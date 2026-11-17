import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { homedir } from "node:os";
import { configDirectory } from "@work-intelligence/shared/database-location";
import {
  mcpContractFingerprint,
  MCP_SELFTEST_ENVIRONMENT,
  SELFTEST_CLIENT_NAME,
} from "@work-intelligence/shared/mcp-contract-fingerprint";
import { windowsCommandShell, windowsSystemTool } from "@work-intelligence/shared/windows-system-tool";
import { LineCollector, LineRingBuffer, SecretMasker } from "../backend/ring-buffer.js";

export const MCP_HANDSHAKE_ERROR_CODES = [
  "HANDSHAKE_SPAWN_FAILED",
  "HANDSHAKE_TIMEOUT",
  "HANDSHAKE_PROTOCOL_ERROR",
  "HANDSHAKE_EXITED",
] as const;
export type McpHandshakeErrorCode = (typeof MCP_HANDSHAKE_ERROR_CODES)[number];

export interface McpHandshakeRequest {
  /**
   * The program to run. It must be the launcher shim of the validated integration record (`launcherShimPath` of the
   * runtime root the App itself chose) or a path the App built; never a `command` read from an Agent's config file,
   * which any process of the user can change and which this probe would then execute.
   */
  readonly command: string;
  readonly args: readonly string[];
  /** Added to this process's environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  /** Paths (such as the runtime root) masked in `stderrTail` besides the home directory, cwd and config directory. */
  readonly maskedPaths?: readonly string[];
  /** The whole handshake (spawn to the last `tools/list` page) must finish within this time. */
  readonly timeoutMs: number;
}

export type McpHandshakeResult =
  | {
      readonly ok: true;
      readonly serverInfo: { readonly name: string; readonly version: string };
      readonly protocolVersion: string;
      readonly toolNames: readonly string[];
      /** Same function the MCP server uses for what a real host received; see {@link mcpContractFingerprint}. */
      readonly contractFingerprint: string;
      readonly elapsedMs: number;
    }
  | {
      readonly ok: false;
      readonly code: McpHandshakeErrorCode;
      readonly message: string;
      /** The last stderr lines of the child, with the home and config directories, cwd and `maskedPaths` masked. */
      readonly stderrTail: readonly string[];
      readonly elapsedMs: number;
    };

/** How a child is started; the argv array reaches the OS without any shell string. */
export interface McpSpawnPlan {
  readonly file: string;
  readonly args: readonly string[];
  /** True when `args` already hold the exact command line cmd.exe must see (Windows batch shims only). */
  readonly windowsVerbatimArguments: boolean;
}

export interface McpHandshakeDependencies {
  readonly platform: NodeJS.Platform;
  readonly environment: Readonly<Record<string, string | undefined>>;
  spawn(file: string, args: readonly string[], options: SpawnOptions): ChildProcess;
}

/** The protocol revision the bundled MCP SDK (apps/mcp) speaks as latest; servers answer with the one they support. */
export const MCP_HANDSHAKE_PROTOCOL_VERSION = "2025-11-25";

const STDERR_LINES = 20;
/** One answer larger than this is not a tools list of ours; stops a runaway server from filling memory. */
const MAX_PENDING_STDOUT = 4 * 1024 * 1024;
const MAX_TOOL_PAGES = 20;
const EXIT_WAIT_MS = 2_000;
const WINDOWS_BATCH_FILE = /\.(?:cmd|bat)$/i;
/** cmd.exe expands `%` even inside quotes and `"` cannot be escaped reliably for a batch file: such arguments are refused. */
const UNSAFE_BATCH_ARGUMENT = /["%\r\n\0]/;
const INITIALIZE_ID = 1;
const FIRST_TOOLS_ID = 2;

const defaultDependencies: McpHandshakeDependencies = {
  platform: process.platform,
  environment: process.env,
  spawn: (file, args, options) => spawn(file, [...args], options),
};

class HandshakeFailure extends Error {
  public readonly code: McpHandshakeErrorCode;

  public constructor(code: McpHandshakeErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function quoteBatchArgument(value: string): string {
  if (UNSAFE_BATCH_ARGUMENT.test(value)) {
    throw new HandshakeFailure(
      "HANDSHAKE_SPAWN_FAILED",
      "an argument of a .cmd shim contains a character cmd.exe cannot pass safely",
    );
  }
  return `"${value}"`;
}

/**
 * Node refuses to start a `.cmd` or `.bat` file without a shell (CVE-2024-27980 hardening), and a shell string built by
 * concatenation is the injection this avoids. The one supported route runs `System32\cmd.exe /d /s /c "<command line>"`
 * with each element quoted by itself and the whole line passed verbatim, so the elements stay separate arguments.
 * Everything else is started directly from its argv array.
 */
export function planMcpSpawn(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): McpSpawnPlan {
  if (platform !== "win32" || !WINDOWS_BATCH_FILE.test(command)) {
    return { file: command, args, windowsVerbatimArguments: false };
  }
  const line = [command, ...args].map(quoteBatchArgument).join(" ");
  return {
    file: windowsCommandShell(environment),
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * Ends the child and everything it started: a process group elsewhere, `taskkill /T` on Windows (the child is
 * `cmd.exe /c shim.cmd`, so killing it alone would orphan the server). `taskkill` works by pid, so it is skipped once
 * the child has exited: the pid may belong to another process by then. A failing `taskkill` falls back to the child.
 * A process group stays valid while any member lives, so POSIX needs no such guard.
 */
function killProcessTree(child: ChildProcess, deps: McpHandshakeDependencies): void {
  const pid = child.pid;
  try {
    if (pid === undefined) {
      child.kill();
    } else if (deps.platform === "win32") {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const killer = deps.spawn(
        windowsSystemTool("taskkill.exe", deps.environment),
        ["/PID", String(pid), "/T", "/F"],
        {
          stdio: "ignore",
          windowsHide: true,
        },
      );
      killer.once("error", () => child.kill());
      killer.once("exit", (code) => {
        if (code !== 0) child.kill();
      });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    child.kill();
  }
}

function toolListPage(result: unknown): { tools: Record<string, unknown>[]; nextCursor: string | undefined } {
  const page = result as { tools?: unknown; nextCursor?: unknown } | null;
  if (!Array.isArray(page?.tools) || !page.tools.every(isNamedTool)) {
    throw new HandshakeFailure("HANDSHAKE_PROTOCOL_ERROR", "tools/list did not return a list of named tools");
  }
  return { tools: page.tools, nextCursor: typeof page.nextCursor === "string" ? page.nextCursor : undefined };
}

function isNamedTool(value: unknown): value is Record<string, unknown> & { name: string } {
  return typeof value === "object" && value !== null && typeof (value as { name?: unknown }).name === "string";
}

function initializeResult(result: unknown): { serverInfo: { name: string; version: string }; protocolVersion: string } {
  const value = result as { protocolVersion?: unknown; serverInfo?: { name?: unknown; version?: unknown } } | null;
  if (typeof value?.protocolVersion !== "string" || typeof value.serverInfo?.name !== "string") {
    throw new HandshakeFailure("HANDSHAKE_PROTOCOL_ERROR", "initialize did not return protocolVersion and serverInfo");
  }
  const version = typeof value.serverInfo.version === "string" ? value.serverInfo.version : "";
  return { protocolVersion: value.protocolVersion, serverInfo: { name: value.serverInfo.name, version } };
}

/**
 * Starts a stdio MCP server and speaks the minimum a host does: `initialize`, `notifications/initialized`, `tools/list`.
 * It proves the server starts and answers, without any Agent in the loop. The child receives
 * {@link MCP_SELFTEST_ENVIRONMENT}, which makes Work Intelligence's own server skip its database and runtime state, and
 * the client name {@link SELFTEST_CLIENT_NAME}, which it never records as a host. The child tree is always killed
 * before this returns. It never throws: every failure is a result with one of {@link MCP_HANDSHAKE_ERROR_CODES}.
 */
export async function probeMcpHandshake(
  request: McpHandshakeRequest,
  deps: McpHandshakeDependencies = defaultDependencies,
): Promise<McpHandshakeResult> {
  const startedAt = performance.now();
  const elapsed = (): number => Math.round(performance.now() - startedAt);
  const stderr = new LineRingBuffer(STDERR_LINES);
  const masker = new SecretMasker({ caseInsensitive: deps.platform === "win32" });
  masker.add(homedir());
  masker.add(request.cwd);
  masker.add(configDirectory({ environment: { ...deps.environment, ...request.env }, platform: deps.platform }));
  request.maskedPaths?.forEach((maskedPath) => masker.add(maskedPath));
  const stderrLines = new LineCollector(stderr, masker);
  let timer: NodeJS.Timeout | undefined;

  try {
    const plan = planMcpSpawn(request.command, request.args, deps.platform, deps.environment);
    const live = deps.spawn(plan.file, plan.args, {
      cwd: request.cwd,
      env: { ...deps.environment, ...request.env, [MCP_SELFTEST_ENVIRONMENT]: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      // Own process group, so the whole tree can be killed with one signal.
      detached: deps.platform !== "win32",
    });
    const exited = new Promise<void>((resolve) => {
      live.once("close", () => resolve());
      live.once("error", () => resolve());
    });

    const outcome = new Promise<Extract<McpHandshakeResult, { ok: true }>>((resolve, reject) => {
      const tools: Record<string, unknown>[] = [];
      let initialized: ReturnType<typeof initializeResult> | undefined;
      let pages = 0;
      let pending = "";
      const send = (message: Record<string, unknown>): void => {
        live.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
      };
      const requestToolsPage = (cursor: string | undefined): void => {
        pages += 1;
        send({ id: FIRST_TOOLS_ID + pages - 1, method: "tools/list", params: cursor === undefined ? {} : { cursor } });
      };
      const handle = (message: Record<string, unknown>): void => {
        if (message.error !== undefined && typeof message.id === "number") {
          throw new HandshakeFailure(
            "HANDSHAKE_PROTOCOL_ERROR",
            `the server answered request ${message.id} with an error`,
          );
        }
        if (message.id === INITIALIZE_ID && !initialized) {
          initialized = initializeResult(message.result);
          send({ method: "notifications/initialized" });
          requestToolsPage(undefined);
        } else if (initialized && message.id === FIRST_TOOLS_ID + pages - 1) {
          const page = toolListPage(message.result);
          tools.push(...page.tools);
          if (page.nextCursor === undefined) {
            resolve({
              ok: true,
              ...initialized,
              toolNames: tools.map((tool) => String(tool.name)),
              contractFingerprint: mcpContractFingerprint(tools as { name: string }[]),
              elapsedMs: elapsed(),
            });
          } else if (pages >= MAX_TOOL_PAGES) {
            throw new HandshakeFailure("HANDSHAKE_PROTOCOL_ERROR", "tools/list kept returning pages");
          } else {
            requestToolsPage(page.nextCursor);
          }
        }
      };
      const handleLine = (line: string): void => {
        if (!line.trim()) return;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          throw new HandshakeFailure(
            "HANDSHAKE_PROTOCOL_ERROR",
            "the server wrote something that is not JSON to stdout",
          );
        }
        if (typeof message !== "object" || message === null || Array.isArray(message)) {
          throw new HandshakeFailure("HANDSHAKE_PROTOCOL_ERROR", "the server wrote a JSON value that is not a message");
        }
        handle(message as Record<string, unknown>);
      };

      live.stdout?.setEncoding("utf8");
      live.stdout?.on("data", (chunk: string) => {
        try {
          pending += chunk;
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          if (pending.length > MAX_PENDING_STDOUT) {
            throw new HandshakeFailure("HANDSHAKE_PROTOCOL_ERROR", "the server wrote an unreasonably long line");
          }
          lines.forEach(handleLine);
        } catch (error) {
          reject(error);
        }
      });
      live.stdin?.on("error", () => undefined);
      live.stderr?.setEncoding("utf8");
      live.stderr?.on("data", (chunk: string) => stderrLines.write(chunk));
      live.once("error", (error) =>
        reject(
          new HandshakeFailure(
            "HANDSHAKE_SPAWN_FAILED",
            `the process could not be started (${(error as NodeJS.ErrnoException).code ?? "error"})`,
          ),
        ),
      );
      live.once("close", (code, signal) =>
        reject(
          new HandshakeFailure(
            "HANDSHAKE_EXITED",
            `the server exited before answering (${code === null ? (signal ?? "unknown") : `exit code ${code}`})`,
          ),
        ),
      );
      timer = setTimeout(
        () => reject(new HandshakeFailure("HANDSHAKE_TIMEOUT", `no complete answer within ${request.timeoutMs} ms`)),
        request.timeoutMs,
      );
      send({
        id: INITIALIZE_ID,
        method: "initialize",
        params: {
          protocolVersion: MCP_HANDSHAKE_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: SELFTEST_CLIENT_NAME, version: "1" },
        },
      });
    });

    try {
      return await outcome;
    } finally {
      clearTimeout(timer);
      killProcessTree(live, deps);
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, EXIT_WAIT_MS).unref())]);
    }
  } catch (error) {
    stderrLines.flush();
    const failure =
      error instanceof HandshakeFailure
        ? error
        : new HandshakeFailure("HANDSHAKE_SPAWN_FAILED", "the process could not be started");
    return {
      ok: false,
      code: failure.code,
      message: failure.message,
      stderrTail: stderr.lines(),
      elapsedMs: elapsed(),
    };
  }
}
