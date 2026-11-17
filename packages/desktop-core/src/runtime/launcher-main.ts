import path from "node:path";
import { pathToFileURL } from "node:url";
import { RuntimeError, runtimeErrorCode } from "./errors.js";
import { DATABASE_ENVIRONMENT_VARIABLE, type DesktopDatabaseResolution } from "./desktop-database.js";
import { checkLaunchConsistency } from "./launch-consistency.js";
import { ELECTRON_AS_NODE_ENV, assertAllowedAction, buildLaunchPlan } from "./launch-plan.js";
import { RUNTIMES_DIRECTORY_NAME } from "./layout.js";
import { HOOK_ACTIONS } from "./manifest.js";
import { verifyRuntime, type VerifiedRuntime } from "./verify.js";

/** What the launcher needs from its process; injectable so tests run it without spawning anything. */
export interface LauncherHost {
  readonly execPath: string;
  readonly versions: Readonly<Record<string, string | undefined>>;
  readonly platform: string;
  readonly arch: string;
  /** Normal output. Only `--print-runtime-info` uses it: for `mcp` stdout belongs to the MCP protocol alone. */
  stdout(text: string): void;
  stderr(text: string): void;
  /** Replaces `process.argv` so the action's entry script sees the command line it expects. */
  setArgv(argv: string[]): void;
  /** Removes an environment variable of this process, so child processes of the action do not inherit it. */
  unsetEnv(name: string): void;
  /** Reads an environment variable of this process. */
  getEnv(name: string): string | undefined;
  /** Sets an environment variable of this process before the action's entry is imported. */
  setEnv(name: string, value: string): void;
  /** The database the App committed, read through the pointer in the launcher root (see desktop-database.ts). */
  desktopDatabase(launcherRoot: string): DesktopDatabaseResolution;
  /** Dynamic `import()` of the action's entry, in this same process. */
  importModule(url: string): Promise<unknown>;
}

/** The runtime directory this launcher script lives in, and the command line after the script name. */
export interface LauncherInput {
  readonly runtimeDirectory: string;
  readonly argv: readonly string[];
}

/** `exit`: the launcher is done with that code. `handed-over`: the action's entry owns the process now. */
export type LauncherOutcome = { readonly kind: "exit"; readonly code: number } | { readonly kind: "handed-over" };

/** The SQLite the running executable bundles. */
export interface SqliteProbe {
  readonly version?: string;
  readonly fts5?: boolean;
  readonly error?: string;
}

/** `sysexits.h` EX_USAGE. */
export const LAUNCHER_EXIT_USAGE = 64;
/** `sysexits.h` EX_CONFIG: the runtime is missing, damaged or unsafe. */
export const LAUNCHER_EXIT_INVALID_RUNTIME = 78;
/** The action started but its entry failed to load. */
export const LAUNCHER_EXIT_ENTRY_FAILED = 1;
/** Prints a diagnostic JSON document on stdout and exits; for installers and smoke tests, never for an Agent. */
export const PRINT_RUNTIME_INFO_FLAG = "--print-runtime-info";

/** The backend the App itself starts; it is always given its database explicitly. */
const SERVE_ACTION = "serve";

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The SQLite version and FTS5 availability of the running executable (ADR-19: judge by `sqlite_version()`). */
export async function probeSqlite(): Promise<SqliteProbe> {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(":memory:");
    try {
      const row = database.prepare("SELECT sqlite_version() AS version").get() as { version: unknown };
      let fts5 = true;
      try {
        database.exec("CREATE VIRTUAL TABLE probe USING fts5(content)");
      } catch {
        fts5 = false;
      }
      return { version: String(row.version), fts5 };
    } finally {
      database.close();
    }
  } catch (error) {
    return { error: describe(error) };
  }
}

/** Set by the caller, either of these means "this checkout / config directory is mine": the App database stays out. */
const EXPLICIT_LOCATION_VARIABLES = ["WORK_INTELLIGENCE_HOME", "WORK_INTELLIGENCE_CONFIG_DIR"] as const;

/**
 * Points the action at the App's committed database (ADR-39) unless the caller chose a location: an explicit
 * `WORK_INTELLIGENCE_DB`, `WORK_INTELLIGENCE_HOME` or `WORK_INTELLIGENCE_CONFIG_DIR` always wins. Without App settings
 * (no pointer, or nothing committed yet) the action keeps the standalone rule. Once the App's settings exist but
 * cannot be used there is NO fallback to another database: `false` means the action must not start, and MCP has
 * already said why in one stderr line (hooks stay silent).
 */
function useDesktopDatabase(launcherRoot: string, host: LauncherHost, quiet: boolean): boolean {
  if (host.getEnv(DATABASE_ENVIRONMENT_VARIABLE)?.trim()) return true;
  if (EXPLICIT_LOCATION_VARIABLES.some((name) => host.getEnv(name)?.trim())) return true;
  const resolution = host.desktopDatabase(launcherRoot);
  if (resolution.kind === "ok") host.setEnv(DATABASE_ENVIRONMENT_VARIABLE, resolution.databasePath);
  else if (resolution.kind === "invalid") {
    if (!quiet) {
      host.stderr(
        `桌面 App 的設定無法使用（${resolution.reason}），為避免寫入另一個資料庫，Agent 未啟動。請在 App 修復設定。\n`,
      );
    }
    return false;
  }
  return true;
}

/** The launcher root and runtime id implied by where this script lives: `<root>/runtimes/<runtimeId>/`. */
function locate(runtimeDirectory: string): { root: string; runtimeId: string } {
  const runtimes = path.dirname(runtimeDirectory);
  if (path.basename(runtimes) !== RUNTIMES_DIRECTORY_NAME) {
    throw new RuntimeError("RUNTIME_POINTER_INVALID", "launcher 不在 <root>/runtimes/<id>/ 之內", {
      file: runtimeDirectory,
    });
  }
  return { root: path.dirname(runtimes), runtimeId: path.basename(runtimeDirectory) };
}

async function runtimeInfo(verified: VerifiedRuntime, host: LauncherHost): Promise<string> {
  const sqlite = await probeSqlite();
  return `${JSON.stringify(
    {
      runtimeId: verified.runtimeId,
      runtimeKind: verified.manifest.runtimeKind,
      execPath: host.execPath,
      nodeVersion: host.versions.node,
      electronVersion: host.versions.electron,
      platform: host.platform,
      arch: host.arch,
      sqlite,
      verification: {
        files: verified.fileCount,
        hashed: verified.hashedCount,
        cached: verified.cachedCount,
        acl: verified.acl,
        aclRead: verified.aclReport,
      },
    },
    null,
    2,
  )}\n`;
}

/**
 * The launcher: runs inside the runtime's own executable, started by the fixed shim as
 * `<executable> <runtime>/launcher.mjs <action> [args…]`.
 *
 * It verifies the runtime it lives in (see verifyRuntime), checks that the shim started the executable and runtime the
 * manifest names (see checkLaunchConsistency), accepts only the fixed actions, and then imports the
 * action's entry script IN THIS PROCESS with `process.argv` set as if the script had been started directly. That
 * costs no second Node start-up (about 40 ms per spawn, measured) and leaves signals, stdio and the exit code to the
 * action itself; a spawned child would need all three forwarded. Nothing here goes through a shell.
 *
 * stdout is never written, so `mcp` keeps a clean protocol stream. If the runtime is unusable the launcher exits 78
 * with the error code and a repair hint on stderr, except for hook actions, which exit 0 (fail open: a broken
 * runtime must not block the Agent) after the same diagnostic on stderr.
 */
export async function runLauncher(input: LauncherInput, host: LauncherHost): Promise<LauncherOutcome> {
  const [action, ...rest] = input.argv;
  if (action === undefined) {
    host.stderr(`用法：launcher <action> [參數…]，或 launcher ${PRINT_RUNTIME_INFO_FLAG}\n`);
    return { kind: "exit", code: LAUNCHER_EXIT_USAGE };
  }
  const diagnosticsOnly = action === PRINT_RUNTIME_INFO_FLAG;
  if (!diagnosticsOnly) {
    try {
      assertAllowedAction(action);
    } catch (error) {
      host.stderr(`${describe(error)}\n`);
      return { kind: "exit", code: LAUNCHER_EXIT_USAGE };
    }
  }
  const failOpen = HOOK_ACTIONS.has(action);
  const refuse = (error: unknown, code: number): LauncherOutcome => {
    host.stderr(`${describe(error)}\n`);
    if (failOpen) host.stderr("hook 已放行，不會阻擋 Agent。\n");
    return { kind: "exit", code: failOpen ? 0 : code };
  };

  let verified: VerifiedRuntime;
  let launcherRoot: string;
  try {
    const { root, runtimeId } = locate(input.runtimeDirectory);
    launcherRoot = root;
    verified = await verifyRuntime(root, runtimeId);
    await checkLaunchConsistency({
      root,
      runtimeId,
      runtimeDirectory: verified.runtimeDirectory,
      manifest: verified.manifest,
      execPath: host.execPath,
      platform: host.platform,
      warn: (message) => host.stderr(message),
    });
  } catch (error) {
    return refuse(error, LAUNCHER_EXIT_INVALID_RUNTIME);
  }
  if (diagnosticsOnly) {
    host.stdout(await runtimeInfo(verified, host));
    return { kind: "exit", code: 0 };
  }

  try {
    const plan = buildLaunchPlan(verified.runtimeDirectory, verified.manifest, action, rest, {});
    const [entry, ...entryArgs] = plan.args as [string, ...string[]];
    // The shims set these for every runtime because they cannot tell which kind they start; a plain Node must not pass them on.
    if (verified.manifest.runtimeKind === "node") {
      for (const name of Object.keys(ELECTRON_AS_NODE_ENV)) host.unsetEnv(name);
    }
    if (action !== SERVE_ACTION && !useDesktopDatabase(launcherRoot, host, failOpen)) {
      return { kind: "exit", code: failOpen ? 0 : LAUNCHER_EXIT_INVALID_RUNTIME };
    }
    host.setArgv([host.execPath, entry, ...entryArgs]);
    await host.importModule(pathToFileURL(entry).href);
    return { kind: "handed-over" };
  } catch (error) {
    const refused = runtimeErrorCode(error) === "RUNTIME_ACTION_NOT_ALLOWED";
    return refuse(error, refused ? LAUNCHER_EXIT_USAGE : LAUNCHER_EXIT_ENTRY_FAILED);
  }
}
