/**
 * Stable stdio launcher for the Work Intelligence MCP server.
 *
 * Agents register this file instead of `index.js`. It runs `index.js` as a child process and relays newline-delimited
 * JSON-RPC between the Agent and the child. When `pnpm build` writes a new server build, the launcher waits for the
 * requests in flight, starts the new build, replays the Agent's `initialize` and `notifications/initialized`, and
 * keeps relaying on the same connection, so the Agent never has to reconnect. Only a change to this file itself
 * needs a reconnect; the child reports that through `server.launcher` (see supervision.ts).
 *
 * Keep this file small and dependent on Node built-ins only: its content hash is the launcher identity, so anything
 * it imports from the workspace would make every rebuild look like a launcher update.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface McpSupervisorOptions {
  /** The server entry point (`apps/mcp/dist/index.js`). */
  entryPath: string;
  /** Returns the build id on disk, or undefined while a build is incomplete or unreadable. */
  readBuildId: () => string | undefined;
  input: Readable;
  output: Writable;
  errorOutput: Writable;
  /** Environment for the server child; the launcher identity variables are added to it. */
  environment?: NodeJS.ProcessEnv;
  launcherIdentity?: McpLauncherIdentity;
  platform?: NodeJS.Platform;
  pollIntervalMs?: number;
  startupTimeoutMs?: number;
  drainTimeoutMs?: number;
  stopTimeoutMs?: number;
  /** Called once after the Agent closed stdin and the child stopped. */
  onClosed?: (exitCode: number) => void;
}

export interface McpLauncherIdentity {
  path: string;
  hash: string;
  version: number;
}

type JsonRpcId = string | number;
type JsonRpcMessage = Record<string, unknown> & { id?: JsonRpcId | null; method?: unknown };

interface ServerConnection {
  child: ChildProcess;
  buildId: string | undefined;
  privateRequests: Map<string, (message: JsonRpcMessage | undefined) => void>;
  exited: Promise<void>;
  hasExited: boolean;
}

/** Bumped only when the launcher protocol with the child (environment, status fields) changes. */
export const MCP_LAUNCHER_VERSION = 1;
export const MCP_LAUNCHER_ENVIRONMENT = {
  path: "WORK_INTELLIGENCE_MCP_LAUNCHER_PATH",
  hash: "WORK_INTELLIGENCE_MCP_LAUNCHER_HASH",
  version: "WORK_INTELLIGENCE_MCP_LAUNCHER_VERSION",
} as const;

const BUILD_PROGRESS_FILE = ".work-intelligence-build-in-progress";
const EMBEDDED_BUILD_HASH = /const MCP_BUILD_DIST_HASH = "([a-f0-9]{64})";/;
/**
 * Ids of the launcher's own requests to a server child. The per-launcher nonce keeps them from colliding with an
 * Agent's ids, and any response carrying the prefix is the launcher's, even after its wait timed out.
 */
const PRIVATE_ID_PREFIX = `work-intelligence-launcher:${randomUUID()}:`;
const INTERNAL_ERROR = -32603;
const CRASH_WINDOW_MS = 60_000;
const CRASH_LIMIT = 3;
/** How long a crash restart waits for a running `pnpm build` to finish before starting the dist on disk. */
const STABLE_BUILD_WAIT_MS = 120_000;
const RACY_WINDOW_MS = 2_000;
const SWAP_FAILED_MESSAGE =
  "Work Intelligence MCP 新版 server 無法啟動，仍使用目前版本；請檢查 pnpm build 的輸出後再試。";
const SERVER_STOPPED_MESSAGE = "Work Intelligence MCP server 行程意外結束，已自動重新啟動；請重試這個請求。";
const SERVER_UNAVAILABLE_MESSAGE = "Work Intelligence MCP server 無法啟動；請執行 pnpm build 後再試。";
const BUILD_MARKER_MESSAGE =
  "Work Intelligence MCP：建置標記檔仍在（.work-intelligence-build-in-progress），先以目前的 dist 啟動；若沒有建置在執行，請重新執行 pnpm build。";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds).unref());
}

function idKey(id: JsonRpcId): string {
  return JSON.stringify(id);
}

function parseMessage(line: string): JsonRpcMessage | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRpcMessage) : undefined;
  } catch {
    return undefined;
  }
}

function isRequest(message: JsonRpcMessage): message is JsonRpcMessage & { id: JsonRpcId; method: string } {
  return typeof message.method === "string" && (typeof message.id === "string" || typeof message.id === "number");
}

function isResponse(message: JsonRpcMessage): message is JsonRpcMessage & { id: JsonRpcId } {
  return message.method === undefined && (typeof message.id === "string" || typeof message.id === "number");
}

/** Splits a stream into lines without rescanning earlier chunks, so a large message stays linear. */
function onLines(stream: Readable, onLine: (line: string) => void): void {
  let pending: string[] = [];
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    let start = 0;
    for (let newline = chunk.indexOf("\n"); newline >= 0; newline = chunk.indexOf("\n", start)) {
      pending.push(chunk.slice(start, newline));
      const line = pending.join("").replace(/\r$/, "");
      pending = [];
      start = newline + 1;
      if (line.trim()) onLine(line);
    }
    if (start < chunk.length) pending.push(chunk.slice(start));
  });
}

/** The request id a `notifications/cancelled` names, when it is a valid JSON-RPC id. */
function cancelledRequestId(message: JsonRpcMessage): JsonRpcId | undefined {
  const params = message.params;
  if (!params || typeof params !== "object") return undefined;
  const requestId = (params as { requestId?: unknown }).requestId;
  return typeof requestId === "string" || typeof requestId === "number" ? requestId : undefined;
}

function fingerprint(message: JsonRpcMessage | undefined): string | undefined {
  const result = message?.result;
  return result === undefined ? undefined : createHash("sha256").update(JSON.stringify(result)).digest("hex");
}

/** Hash of a file's bytes, used as the launcher identity. */
export function launcherFileHash(path: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return undefined;
  }
}

/**
 * The server build on disk as `<package version>:<dist hash>`, the same build id as `readMcpBuildIdentity`. It reads
 * the hash that `pnpm build` embeds in `index.js` last, and only while no build is in progress; the started server
 * verifies the whole dist itself. A stat signature keeps the per-request check to three `stat` calls.
 */
export function createBuildIdReader(repositoryRoot: string, entryPath: string): () => string | undefined {
  const markerPath = resolve(repositoryRoot, BUILD_PROGRESS_FILE);
  const packagePath = resolve(repositoryRoot, "package.json");
  let cached: { signature: string; buildId: string | undefined } | undefined;
  return () => {
    if (existsSync(markerPath)) return undefined;
    let signature: string;
    let recent: boolean;
    try {
      const entry = statSync(entryPath);
      const packageJson = statSync(packagePath);
      // Files written within the timestamp resolution may change again without a new signature (coarse on Windows).
      recent = Date.now() - Math.max(entry.mtimeMs, packageJson.mtimeMs) < RACY_WINDOW_MS;
      signature = [entry.size, entry.mtimeMs, entry.ino, packageJson.size, packageJson.mtimeMs, packageJson.ino].join();
    } catch {
      return undefined;
    }
    if (cached?.signature === signature) return cached.buildId;
    let buildId: string | undefined;
    try {
      const version: unknown = (JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown }).version;
      const hash = EMBEDDED_BUILD_HASH.exec(readFileSync(entryPath, "utf8"))?.[1];
      buildId = typeof version === "string" && hash ? `${version}:${hash}` : undefined;
    } catch {
      buildId = undefined;
    }
    if (existsSync(markerPath)) return undefined;
    cached = recent ? undefined : { signature, buildId };
    return buildId;
  };
}

/**
 * Stops a server child: close its stdin so it can finish, then force it. On Windows `kill()` is TerminateProcess,
 * which cannot be caught; elsewhere SIGTERM comes first and SIGKILL only if the child ignores it.
 */
export async function stopServerProcess(
  child: ChildProcess,
  exited: Promise<void>,
  options: { platform?: NodeJS.Platform; timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 3_000;
  const finished = (wait: number) =>
    Promise.race([
      exited.then(() => true),
      delay(wait).then(() => child.exitCode !== null || child.signalCode !== null),
    ]);
  child.stdin?.end();
  if (await finished(timeoutMs)) return;
  // Windows has no catchable signal: kill() without a signal is TerminateProcess there.
  if ((options.platform ?? process.platform) === "win32") child.kill();
  else child.kill("SIGTERM");
  if (await finished(timeoutMs)) return;
  child.kill("SIGKILL");
  await finished(timeoutMs);
}

export class McpSupervisor {
  private readonly options: Required<
    Pick<McpSupervisorOptions, "pollIntervalMs" | "startupTimeoutMs" | "drainTimeoutMs" | "stopTimeoutMs">
  > &
    McpSupervisorOptions;
  private current: ServerConnection | undefined;
  private initializeRequest: JsonRpcMessage | undefined;
  private initializedNotification: JsonRpcMessage | undefined;
  private readonly inFlight = new Map<string, JsonRpcId>();
  private readonly queue: JsonRpcMessage[] = [];
  private drainWaiters: (() => void)[] = [];
  private swapping = false;
  private pendingFailure: string | undefined;
  private failedBuildId: string | undefined;
  /** A build whose swap gave up waiting for a request; requests go to the old server until the in-flight ones finish. */
  private deferredBuildId: string | undefined;
  private crashTimes: number[] = [];
  private privateSequence = 0;
  private closing = false;
  private pollTimer: NodeJS.Timeout | undefined;

  constructor(options: McpSupervisorOptions) {
    this.options = {
      pollIntervalMs: 1_000,
      startupTimeoutMs: 15_000,
      drainTimeoutMs: 30_000,
      stopTimeoutMs: 3_000,
      ...options,
    };
  }

  /** Starts the first server child and begins relaying. */
  async start(): Promise<void> {
    onLines(this.options.input, (line) => this.handleClientLine(line));
    this.options.input.on("end", () => void this.close());
    // Requests that arrive while the first child starts wait in the queue, exactly as during a swap.
    this.swapping = true;
    try {
      this.current = await this.startServer(false, this.options.startupTimeoutMs);
    } catch {
      this.options.errorOutput.write(`${SERVER_UNAVAILABLE_MESSAGE}\n`);
    } finally {
      this.swapping = false;
      this.flushQueue();
    }
    this.pollTimer = setInterval(() => this.checkForNewBuild(), this.options.pollIntervalMs);
    this.pollTimer.unref();
  }

  /** The build id of the running child, for tests and diagnostics. */
  runningBuildId(): string | undefined {
    return this.current?.buildId;
  }

  /** Stops relaying and the child; resolves after the child exited. */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    const connection = this.current;
    this.current = undefined;
    if (connection) await this.stop(connection);
    this.options.onClosed?.(connection?.child.exitCode ?? 0);
  }

  private handleClientLine(line: string): void {
    if (this.closing) return;
    const message = parseMessage(line);
    if (!message) {
      this.writeTo(this.current, line);
      return;
    }
    if (isRequest(message)) {
      if (this.swapping || this.queue.length > 0 || !this.current) {
        this.queue.push(message);
        if (!this.swapping) void this.replaceServer();
        return;
      }
      if (this.newBuildAvailable()) {
        this.queue.push(message);
        void this.replaceServer();
        return;
      }
      this.forwardRequest(message);
      return;
    }
    if (message.method === "notifications/initialized") this.initializedNotification = message;
    // A cancelled request never gets a response, so it must leave the in-flight set or a swap would wait forever.
    if (message.method === "notifications/cancelled") this.settle(cancelledRequestId(message));
    // Notifications (cancellation, progress) and responses to server requests go to the server that is running now.
    this.writeTo(this.current, line);
  }

  private forwardRequest(message: JsonRpcMessage & { id: JsonRpcId }): void {
    if (this.pendingFailure && message.method !== "initialize") {
      const failure = this.pendingFailure;
      this.pendingFailure = undefined;
      this.reply(message.id, failure);
      return;
    }
    if (!this.current) {
      this.reply(message.id, SERVER_UNAVAILABLE_MESSAGE);
      return;
    }
    // Only an initialize that a server actually received is replayed; a queued one reaches the new server itself.
    if (message.method === "initialize") this.initializeRequest = message;
    this.inFlight.set(idKey(message.id), message.id);
    this.writeTo(this.current, JSON.stringify(message));
  }

  private handleServerLine(connection: ServerConnection, line: string): void {
    const message = parseMessage(line);
    if (message && isResponse(message) && typeof message.id === "string" && message.id.startsWith(PRIVATE_ID_PREFIX)) {
      // The launcher's own request: hand it to its waiter, or drop it if that wait already timed out.
      const resolvePrivate = connection.privateRequests.get(message.id);
      connection.privateRequests.delete(message.id);
      resolvePrivate?.(message);
      return;
    }
    if (connection !== this.current || this.closing) return;
    this.options.output.write(`${line}\n`);
    if (message && isResponse(message)) this.settle(message.id);
  }

  /** Removes a finished or cancelled request; when none remain, wakes a waiting swap or resumes a deferred one. */
  private settle(id: JsonRpcId | null | undefined): void {
    if (id === undefined || id === null || !this.inFlight.delete(idKey(id)) || this.inFlight.size > 0) return;
    this.notifyDrained();
    if (this.deferredBuildId !== undefined) {
      this.deferredBuildId = undefined;
      this.checkForNewBuild();
    }
  }

  private newBuildAvailable(): boolean {
    const buildId = this.options.readBuildId();
    return (
      buildId !== undefined &&
      buildId !== this.current?.buildId &&
      buildId !== this.failedBuildId &&
      buildId !== this.deferredBuildId
    );
  }

  private checkForNewBuild(): void {
    if (this.closing || this.swapping || !this.current || !this.newBuildAvailable()) return;
    void this.replaceServer();
  }

  /**
   * Waits for the requests in flight, starts the new build beside the old one, and switches only once the new child
   * answered the replayed initialize. On failure the old child stays and the next request receives the error.
   */
  private async replaceServer(): Promise<void> {
    if (this.swapping || this.closing) return;
    this.swapping = true;
    try {
      const old = this.current;
      if (old && !(await this.waitForDrain())) {
        // A request is still running: keep the old server, and stop making every new request wait for this build
        // again; the swap resumes once the requests in flight have finished.
        this.deferredBuildId = this.options.readBuildId();
        return;
      }
      const oldTools = old ? await this.listFingerprints(old) : undefined;
      let next: ServerConnection;
      try {
        next = await this.startServer(true);
      } catch {
        this.failedBuildId = this.options.readBuildId();
        if (old && !old.hasExited) {
          this.pendingFailure = SWAP_FAILED_MESSAGE;
        } else {
          this.current = undefined;
          for (const message of this.queue.splice(0)) {
            if (isRequest(message)) this.reply(message.id, SERVER_UNAVAILABLE_MESSAGE);
          }
        }
        return;
      }
      this.failedBuildId = undefined;
      this.current = next;
      if (old) void this.stop(old);
      const newTools = await this.listFingerprints(next);
      if (this.initializedNotification) {
        if (!oldTools || !newTools || oldTools.tools !== newTools.tools) {
          this.options.output.write(
            `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n`,
          );
        }
        if (!oldTools || !newTools || oldTools.resources !== newTools.resources) {
          this.options.output.write(
            `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/resources/list_changed" })}\n`,
          );
        }
      }
    } finally {
      this.swapping = false;
      this.flushQueue();
    }
  }

  private flushQueue(): void {
    for (const message of this.queue.splice(0)) {
      if (this.closing) return;
      if (isRequest(message)) this.forwardRequest(message);
    }
  }

  private waitForDrain(): Promise<boolean> {
    if (this.inFlight.size === 0) return Promise.resolve(true);
    return new Promise((resolveDrain) => {
      let timer: NodeJS.Timeout | undefined;
      const done = () => {
        clearTimeout(timer);
        resolveDrain(true);
      };
      timer = setTimeout(() => {
        this.drainWaiters = this.drainWaiters.filter((waiter) => waiter !== done);
        resolveDrain(false);
      }, this.options.drainTimeoutMs);
      this.drainWaiters.push(done);
    });
  }

  private notifyDrained(): void {
    for (const waiter of this.drainWaiters.splice(0)) waiter();
  }

  private async listFingerprints(
    connection: ServerConnection,
  ): Promise<{ tools: string | undefined; resources: string | undefined } | undefined> {
    if (!this.initializeRequest || connection.hasExited) return undefined;
    const [tools, resources] = await Promise.all([
      this.privateRequest(connection, "tools/list"),
      this.privateRequest(connection, "resources/list"),
    ]);
    return { tools: fingerprint(tools), resources: fingerprint(resources) };
  }

  private privateRequest(
    connection: ServerConnection,
    method: string,
    params?: unknown,
  ): Promise<JsonRpcMessage | undefined> {
    const id = `${PRIVATE_ID_PREFIX}${(this.privateSequence += 1)}`;
    return new Promise((resolveRequest) => {
      const timer = setTimeout(() => {
        connection.privateRequests.delete(id);
        resolveRequest(undefined);
      }, this.options.startupTimeoutMs);
      connection.privateRequests.set(id, (message) => {
        clearTimeout(timer);
        resolveRequest(message);
      });
      this.writeTo(
        connection,
        JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }),
      );
    });
  }

  private async waitForStableBuild(maxWaitMs: number): Promise<string | undefined> {
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      const buildId = this.options.readBuildId();
      if (buildId !== undefined || this.closing) return buildId;
      if (Date.now() >= deadline) {
        if (this.buildInProgress()) this.options.errorOutput.write(`${BUILD_MARKER_MESSAGE}\n`);
        return buildId;
      }
      // Without an embedded hash (a development build) there is nothing to wait for.
      if (existsSync(this.options.entryPath) && !this.buildInProgress()) return undefined;
      await delay(Math.min(this.options.pollIntervalMs, 500));
    }
  }

  private buildInProgress(): boolean {
    return existsSync(resolve(dirname(this.options.entryPath), "../../..", BUILD_PROGRESS_FILE));
  }

  /** Spawns a child and, when the Agent already initialized, replays initialize and initialized to it. */
  private async startServer(replay: boolean, maxBuildWaitMs = STABLE_BUILD_WAIT_MS): Promise<ServerConnection> {
    const buildId = await this.waitForStableBuild(maxBuildWaitMs);
    const identity = this.options.launcherIdentity;
    const child = spawn(process.execPath, [this.options.entryPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...(this.options.environment ?? process.env),
        ...(identity
          ? {
              [MCP_LAUNCHER_ENVIRONMENT.path]: identity.path,
              [MCP_LAUNCHER_ENVIRONMENT.hash]: identity.hash,
              [MCP_LAUNCHER_ENVIRONMENT.version]: String(identity.version),
            }
          : {}),
      },
    });
    let markExited: () => void = () => undefined;
    const connection: ServerConnection = {
      child,
      buildId,
      privateRequests: new Map(),
      hasExited: false,
      exited: new Promise((resolveExit) => (markExited = resolveExit)),
    };
    const onExit = () => {
      if (connection.hasExited) return;
      connection.hasExited = true;
      for (const resolvePrivate of connection.privateRequests.values()) resolvePrivate(undefined);
      connection.privateRequests.clear();
      markExited();
      this.handleExit(connection);
    };
    child.on("exit", onExit);
    child.on("error", onExit);
    child.stdin?.on("error", () => undefined);
    child.stderr?.pipe(this.options.errorOutput, { end: false });
    if (child.stdout) onLines(child.stdout, (line) => this.handleServerLine(connection, line));

    if (replay && this.initializeRequest) {
      const response = await this.privateRequest(connection, "initialize", this.initializeRequest.params);
      if (!response || response.error !== undefined || connection.hasExited) {
        await this.stop(connection);
        throw new Error("The new MCP server did not initialize.");
      }
      if (this.initializedNotification) this.writeTo(connection, JSON.stringify(this.initializedNotification));
    } else {
      await Promise.race([delay(50), connection.exited]);
      if (connection.hasExited) throw new Error("The MCP server exited during startup.");
    }
    return connection;
  }

  private handleExit(connection: ServerConnection): void {
    if (connection !== this.current || this.closing) return;
    this.current = undefined;
    for (const id of this.inFlight.values()) this.reply(id, SERVER_STOPPED_MESSAGE);
    this.inFlight.clear();
    this.notifyDrained();
    const now = Date.now();
    this.crashTimes = [...this.crashTimes.filter((time) => now - time < CRASH_WINDOW_MS), now];
    if (this.crashTimes.length > CRASH_LIMIT) {
      this.options.errorOutput.write(`${SERVER_UNAVAILABLE_MESSAGE}\n`);
      void this.close();
      return;
    }
    void this.replaceServer();
  }

  private stop(connection: ServerConnection): Promise<void> {
    return stopServerProcess(connection.child, connection.exited, {
      platform: this.options.platform,
      timeoutMs: this.options.stopTimeoutMs,
    });
  }

  private reply(id: JsonRpcId, message: string): void {
    this.options.output.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: INTERNAL_ERROR, message } })}\n`);
  }

  private writeTo(connection: ServerConnection | undefined, line: string): void {
    if (!connection || connection.hasExited) return;
    connection.child.stdin?.write(`${line}\n`);
  }
}

async function main(): Promise<void> {
  const launcherPath = realpathSync(fileURLToPath(import.meta.url));
  const entryPath = resolve(dirname(launcherPath), "index.js");
  const repositoryRoot = resolve(dirname(launcherPath), "../../..");
  const supervisor = new McpSupervisor({
    entryPath,
    readBuildId: createBuildIdReader(repositoryRoot, entryPath),
    input: process.stdin,
    output: process.stdout,
    errorOutput: process.stderr,
    launcherIdentity: {
      path: launcherPath,
      hash: launcherFileHash(launcherPath) ?? "unknown",
      version: MCP_LAUNCHER_VERSION,
    },
    onClosed: (exitCode) => {
      // Let pending stdout writes drain; stdin is the only handle left, so exit normally once it is gone.
      process.exitCode = exitCode;
      process.stdin.destroy();
      setTimeout(() => process.exit(exitCode), 1_000).unref();
    },
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => void supervisor.close());
  }
  process.stdout.on("error", () => void supervisor.close());
  await supervisor.start();
}

/** Run directly, not imported. Compares real paths: the checkout may sit behind a symlink. */
function isEntryPoint(): boolean {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) await main();
