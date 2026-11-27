import path from "node:path";
import { pathToFileURL } from "node:url";
import { MCP_LEASE_SCOPE_ENVIRONMENT } from "@work-intelligence/shared/mcp-runtime";
import { errorCode } from "../internal/error-code.js";
import { RuntimeError, runtimeErrorCode } from "./errors.js";
import { DATABASE_ENVIRONMENT_VARIABLE, type DesktopDatabaseResolution } from "./desktop-database.js";
import { checkLaunchConsistency } from "./launch-consistency.js";
import { ELECTRON_AS_NODE_ENV, assertAllowedAction, buildLaunchPlan } from "./launch-plan.js";
import { RUNTIMES_DIRECTORY_NAME } from "./layout.js";
import { LEASE_HEARTBEAT_MS, type LeaseHandle } from "./lease.js";
import { HOOK_ACTIONS } from "./manifest.js";
import { verifyRuntime, type VerifiedRuntime } from "./verify.js";

export interface LauncherHost {
  readonly execPath: string;
  readonly versions: Readonly<Record<string, string | undefined>>;
  readonly platform: string;
  readonly arch: string;
  stdout(text: string): void;
  stderr(text: string): void;
  setArgv(argv: string[]): void;
  unsetEnv(name: string): void;
  getEnv(name: string): string | undefined;
  setEnv(name: string, value: string): void;
  desktopDatabase(launcherRoot: string): DesktopDatabaseResolution;
  importModule(url: string): Promise<unknown>;
  acquireLease(launcherRoot: string, runtimeId: string, action: string): LeaseHandle;
  onExit(handler: () => void): void;
  startHeartbeat(tick: () => void, intervalMs: number): void;
}

export interface LauncherInput {
  readonly runtimeDirectory: string;
  readonly argv: readonly string[];
}

export type LauncherOutcome = { readonly kind: "exit"; readonly code: number } | { readonly kind: "handed-over" };

export interface SqliteProbe {
  readonly version?: string;
  readonly fts5?: boolean;
  readonly error?: string;
}

export const LAUNCHER_EXIT_USAGE = 64;
export const LAUNCHER_EXIT_INVALID_RUNTIME = 78;
export const LAUNCHER_EXIT_ENTRY_FAILED = 1;
export const PRINT_RUNTIME_INFO_FLAG = "--print-runtime-info";

const SERVE_ACTION = "serve";
const LONG_LIVED_ACTIONS: ReadonlySet<string> = new Set(["mcp", SERVE_ACTION]);

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

const EXPLICIT_LOCATION_VARIABLES = ["WORK_INTELLIGENCE_HOME", "WORK_INTELLIGENCE_CONFIG_DIR"] as const;

/**
 * Once the App's settings exist but cannot be used there is no fallback to another database: `false` means the action
 * must not start.
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

/** A lease failure never fails or slows the action: at most one stderr line (a code, no path), none for a hook. */
function startLease(host: LauncherHost, launcherRoot: string, runtimeId: string, action: string, quiet: boolean): void {
  let warned = false;
  const warnOnce = (error: unknown): void => {
    if (warned || quiet) return;
    warned = true;
    host.stderr(`無法記錄這個程序正在使用 runtime（${errorCode(error) ?? "UNKNOWN"}），不影響這次執行。\n`);
  };
  let lease: LeaseHandle;
  try {
    lease = host.acquireLease(launcherRoot, runtimeId, action);
  } catch (error) {
    warnOnce(error);
    return;
  }
  host.onExit(() => lease.remove());
  if (!LONG_LIVED_ACTIONS.has(action)) return;
  host.startHeartbeat(() => {
    try {
      lease.refresh();
    } catch (error) {
      warnOnce(error);
    }
  }, LEASE_HEARTBEAT_MS);
}

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
 * Never writes stdout, so `mcp` keeps a clean protocol stream. Hook actions exit 0 on an unusable runtime (fail open).
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
    // Before verification and import, so no runtime file is read by a process the collector cannot see.
    if (!diagnosticsOnly) startLease(host, root, runtimeId, action, failOpen);
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
    if (LONG_LIVED_ACTIONS.has(action)) host.setEnv(MCP_LEASE_SCOPE_ENVIRONMENT, launcherRoot);
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
