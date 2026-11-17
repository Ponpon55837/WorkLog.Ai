import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

// Process plumbing for the old-writer barrier experiment (design R4 section 10.4). Real child processes run the
// repository TypeScript through tsx; every wait is an explicit message or output line, never a fixed delay.
export interface Waiter {
  readonly child: ChildProcess;
  /** Resolves with the next IPC message of this type (earlier ones are kept, so none is missed). */
  waitFor<T extends { type: string }>(type: string): Promise<T>;
  send(message: Record<string, unknown>): void;
  /** Resolves when the process has exited. */
  exited: Promise<number | null>;
  stderr(): string;
}

export interface LineProcess {
  readonly child: ChildProcess;
  waitForLine(pattern: RegExp): Promise<string>;
  stderr(): string;
  exited: Promise<number | null>;
}

export interface DatabaseSnapshot {
  integrity: string;
  pragmaSchemaVersion: number;
  highestMigration: number;
  projectNames: string[];
  sessionTitles: string[];
  hasFutureTable: boolean;
}

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const WORKER_SCRIPT = join(REPOSITORY_ROOT, "tests/helpers/old-writer-barrier-worker.ts");
export const DEFAULT_WAIT_MS = 60_000;

const WORKSPACE_PATHS: Record<string, string> = {
  "@work-intelligence/core": "packages/core/src/index.ts",
  "@work-intelligence/project-policy": "packages/project-policy/src/index.ts",
  "@work-intelligence/schema": "packages/schema/src/index.ts",
  "@work-intelligence/shared": "packages/shared/src/index.ts",
  "@work-intelligence/shared/app-version": "packages/shared/src/app-version.ts",
  "@work-intelligence/shared/database-location": "packages/shared/src/database-location.ts",
  "@work-intelligence/shared/database-path": "packages/shared/src/database-path.ts",
  "@work-intelligence/shared/instance-proof": "packages/shared/src/instance-proof.ts",
  "@work-intelligence/shared/mcp-contract-fingerprint": "packages/shared/src/mcp-contract-fingerprint.ts",
  "@work-intelligence/shared/loopback-port": "packages/shared/src/loopback-port.ts",
  "@work-intelligence/shared/mcp-runtime": "packages/shared/src/mcp-runtime.ts",
  "@work-intelligence/shared/sqlite-version": "packages/shared/src/sqlite-version.ts",
  "@work-intelligence/shared/windows-system-tool": "packages/shared/src/windows-system-tool.ts",
  "@work-intelligence/storage": "packages/storage/src/index.ts",
};

function timeoutAfter<T>(promise: Promise<T>, label: string, ms = DEFAULT_WAIT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** A tsconfig whose paths send the workspace packages to their sources, so no build output is needed. */
function writeTsconfig(directory: string): string {
  const paths: Record<string, string[]> = Object.fromEntries(
    Object.entries(WORKSPACE_PATHS).map(([name, file]) => [name, [join(REPOSITORY_ROOT, file)]]),
  );
  paths["@modelcontextprotocol/sdk/*"] = [
    join(REPOSITORY_ROOT, "apps/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/*"),
  ];
  const path = join(directory, "tsconfig.json");
  writeFileSync(path, JSON.stringify({ compilerOptions: { baseUrl: REPOSITORY_ROOT, paths } }));
  return path;
}

function tsxLoaderUrl(): string {
  const require = createRequire(join(REPOSITORY_ROOT, "apps/server/package.json"));
  return pathToFileURL(require.resolve("tsx/esm")).href;
}

export class BarrierSandbox {
  public readonly root = mkdtempSync(join(tmpdir(), "work-intelligence-old-writer-"));
  public readonly databasePath = join(this.root, "work-intelligence.sqlite");
  public readonly projectRoot = join(this.root, "apiary");
  public readonly snapshotPath = join(this.root, "snapshot-before-migration.sqlite");
  private readonly children: ChildProcess[] = [];
  private readonly tsconfigPath: string;
  private readonly loader = tsxLoaderUrl();

  public constructor() {
    mkdirSync(this.projectRoot, { recursive: true });
    mkdirSync(join(this.root, "home"), { recursive: true });
    mkdirSync(join(this.root, "tmp"), { recursive: true });
    this.tsconfigPath = writeTsconfig(this.root);
  }

  /** Isolated environment: temp HOME/TMPDIR/config, the temp database, no backups, never the real user data. */
  public environment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const home = join(this.root, "home");
    const inherited = { ...process.env };
    for (const name of Object.keys(inherited)) {
      if (/^(WORK_INTELLIGENCE_|CODEX_|CLAUDE_)/i.test(name)) delete inherited[name];
    }
    return {
      ...inherited,
      HOME: home,
      USERPROFILE: home,
      TMPDIR: join(this.root, "tmp"),
      TEMP: join(this.root, "tmp"),
      TMP: join(this.root, "tmp"),
      WORK_INTELLIGENCE_DB: this.databasePath,
      WORK_INTELLIGENCE_CONFIG_DIR: join(home, ".work-intelligence"),
      WORK_INTELLIGENCE_BACKUP: "off",
      CODEX_HOME: join(home, ".codex"),
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      TSX_TSCONFIG_PATH: this.tsconfigPath,
      NODE_NO_WARNINGS: "1",
      ...extra,
    };
  }

  /** A worker with an IPC channel (store-writer, lock-holder, migrator roles). */
  public spawnWorker(args: string[]): Waiter {
    return this.spawnIpc(WORKER_SCRIPT, args);
  }

  /** A repository TypeScript entry with an IPC channel to the test, like a desktop parent would open. */
  public spawnIpc(script: string, args: string[] = [], extraEnvironment: Record<string, string> = {}): Waiter {
    const child = spawn(process.execPath, ["--import", this.loader, script, ...args], {
      env: this.environment(extraEnvironment),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.children.push(child);
    const received: Array<{ type: string }> = [];
    const pending: Array<{ type: string; resolve: (message: never) => void }> = [];
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdout?.resume();
    child.on("message", (message: { type: string }) => {
      const index = pending.findIndex((waiter) => waiter.type === message.type);
      if (index >= 0) pending.splice(index, 1)[0]?.resolve(message as never);
      else received.push(message);
    });
    const exited = new Promise<number | null>((resolveExit) => child.once("exit", (code) => resolveExit(code)));
    return {
      child,
      exited,
      stderr: () => stderr,
      send: (message) => child.send(message),
      waitFor: <T extends { type: string }>(type: string): Promise<T> => {
        const index = received.findIndex((message) => message.type === type);
        if (index >= 0) return Promise.resolve(received.splice(index, 1)[0] as T);
        const arrived = new Promise<T>((resolveMessage) => pending.push({ type, resolve: resolveMessage as never }));
        const failed = exited.then(() => {
          throw new Error(`The worker exited before sending ${type}: ${stderr.slice(-800)}`);
        });
        return timeoutAfter(Promise.race([arrived, failed]), `worker message ${type}`);
      },
    };
  }

  /** A real repository entry point (API server, MCP server over stdio, CLI) with pipes and a line matcher. */
  public spawnEntry(script: string, args: string[] = [], extraEnvironment: Record<string, string> = {}): LineProcess {
    const child = spawn(process.execPath, ["--import", this.loader, join(REPOSITORY_ROOT, script), ...args], {
      env: this.environment(extraEnvironment),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.children.push(child);
    let stderr = "";
    let stdout = "";
    const watchers: Array<{ pattern: RegExp; resolve: (line: string) => void }> = [];
    const check = (): void => {
      for (const watcher of [...watchers]) {
        const match = (stderr + "\n" + stdout).split("\n").find((line) => watcher.pattern.test(line));
        if (match) {
          watchers.splice(watchers.indexOf(watcher), 1);
          watcher.resolve(match);
        }
      }
    };
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      check();
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      check();
    });
    const exited = new Promise<number | null>((resolveExit) => child.once("exit", (code) => resolveExit(code)));
    return {
      child,
      exited,
      stderr: () => stderr,
      waitForLine: (pattern) => {
        const arrived = new Promise<string>((resolveLine) => {
          watchers.push({ pattern, resolve: resolveLine });
          check();
        });
        const failed = exited.then(() => {
          throw new Error(`The process exited before printing ${String(pattern)}: ${stderr.slice(-800)}`);
        });
        return timeoutAfter(Promise.race([arrived, failed]), `output ${String(pattern)}`);
      },
    };
  }

  public async stopAll(): Promise<void> {
    const running = this.children.filter((child) => child.exitCode === null && child.signalCode === null);
    for (const child of running) child.kill("SIGKILL");
    await Promise.all(running.map((child) => new Promise<void>((done) => child.once("exit", () => done()))));
  }
}

/** Minimal newline-delimited JSON-RPC client for a stdio MCP server (no SDK needed). */
export class StdioJsonRpcClient {
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, (message: Record<string, unknown>) => void>();

  public constructor(private readonly process: LineProcess) {
    process.child.stdout?.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      for (let newline = this.buffer.indexOf("\n"); newline >= 0; newline = this.buffer.indexOf("\n")) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line) as { id?: number } & Record<string, unknown>;
        if (typeof message.id === "number") this.pending.get(message.id)?.(message);
      }
    });
  }

  public request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const answer = new Promise<Record<string, unknown>>((resolveAnswer) => this.pending.set(id, resolveAnswer));
    this.process.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return timeoutAfter(answer, `MCP response to ${method}`);
  }

  public notify(method: string): void {
    this.process.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  public async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "old-writer-barrier-test", version: "0.0.0" },
    });
    this.notify("notifications/initialized");
  }
}

/** A free TCP port chosen by the OS (the server entry point cannot take port 0). */
export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        address && typeof address !== "string" ? resolvePort(address.port) : reject(new Error("No port")),
      );
    });
  });
}

/** Reads a database from a fresh connection, the way the next process to open the file would see it. */
export function inspectDatabase(databasePath: string): DatabaseSnapshot {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const names = (sql: string): string[] =>
      (db.prepare(sql).all() as Array<{ value: string }>).map((row) => row.value);
    return {
      integrity: (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check,
      pragmaSchemaVersion: (db.prepare("PRAGMA schema_version").get() as { schema_version: number }).schema_version,
      highestMigration: (db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v,
      projectNames: names("SELECT name AS value FROM projects ORDER BY name"),
      sessionTitles: names("SELECT title AS value FROM sessions ORDER BY title"),
      hasFutureTable:
        db.prepare("SELECT 1 AS found FROM sqlite_master WHERE name = 'synthetic_future_feature'").get() !== undefined,
    };
  } finally {
    db.close();
  }
}
