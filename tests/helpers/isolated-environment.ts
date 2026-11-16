/**
 * Vitest setup file shared by every suite (registered as `setupFiles` in each vitest config).
 *
 * Why: tests must never read or write the developer's real home, Codex/Claude configuration, the real
 * `~/.work-intelligence` data, or talk to the real server port 3210. Code under test falls back to those
 * locations whenever an environment variable is not injected, and child processes inherit `process.env`,
 * so the safest guard is to repoint the whole environment before any test module is imported.
 *
 * What it does, per test file (each file gets its own worker context):
 *  1. Records the real home (from the passwd entry, which HOME/USERPROFILE do not influence).
 *  2. Creates a fresh temp root and points every variable the code reads at directories inside it:
 *       HOME, USERPROFILE                    os.homedir() and every `~` default (Node honors them)
 *       APPDATA, LOCALAPPDATA                Windows user service and Claude Desktop locations
 *       XDG_CONFIG_HOME/_DATA_HOME/_STATE_HOME  Linux user service files and Claude Desktop locations
 *       CODEX_HOME, CLAUDE_CONFIG_DIR        Agent configuration directories (agent-setup, doctor, plugin)
 *       WORK_INTELLIGENCE_CONFIG_DIR         standalone data directory (database-location configDirectory)
 *  3. Removes WORK_INTELLIGENCE_DB / _HOME / _BACKUP_DIR inherited from the developer shell, and pins
 *     WORK_INTELLIGENCE_PORT to an unused sentinel so a test that forgets to inject a port can never reach 3210.
 *  4. Makes any in-process `listen`/`connect` on port 3210 throw (child processes are covered by the static
 *     check in tests/shared/test-isolation.test.ts and by the sentinel port above).
 *  5. After the file: asserts os.homedir() is still the fake home (a test that deletes HOME would make Node fall
 *     back to the real passwd home), compares cheap stat snapshots of the real sensitive paths and, in strict
 *     mode, fails on any change; finally removes the temp root.
 *
 * Strict snapshot mode is on when CI is set or WORK_INTELLIGENCE_ISOLATION_STRICT=1 (off with =0). Locally a real
 * Codex/Claude session or the real Work Intelligence server legitimately rewrites those paths while tests run, so
 * the snapshot comparison would give false alarms there.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

/** The server's default port; tests must never listen on or connect to it. */
export const FORBIDDEN_PORT = 3210;
/** A port nothing is expected to listen on; stands in for WORK_INTELLIGENCE_PORT when a test sets none. */
export const SENTINEL_PORT = "65533";

/** The isolated locations created for the current test file. */
export interface IsolatedEnvironment {
  /** The developer's real home directory (never touched; only stat-ed). */
  readonly realHome: string;
  /** Temp directory that holds everything below. */
  readonly root: string;
  /** Value of HOME and USERPROFILE. */
  readonly home: string;
}

const REAL_HOME = os.userInfo().homedir;
const REAL_APPDATA = process.env.APPDATA;

const root = realpathSync(mkdtempSync(join(os.tmpdir(), "wi-test-isolation-")));
const home = join(root, "home");

/** Describes where this test file's environment points; exported so the guard test can assert on it. */
export const isolatedEnvironment: IsolatedEnvironment = { realHome: REAL_HOME, root, home };

/** Real-home paths whose contents a test must never change (stat-only comparison). */
function sensitivePaths(): string[] {
  const paths = [
    join(REAL_HOME, ".work-intelligence"),
    join(REAL_HOME, ".codex"),
    join(REAL_HOME, ".claude"),
    join(REAL_HOME, ".claude.json"),
    join(REAL_HOME, "Library", "Application Support", "Claude"),
    join(REAL_HOME, ".config", "Claude"),
  ];
  if (REAL_APPDATA) {
    paths.push(join(REAL_APPDATA, "Claude"));
  }
  return paths;
}

/** One-level fingerprint: mtime and size of the path plus the name, size and mtime of each file entry. */
function fingerprint(path: string): string {
  if (!existsSync(path)) {
    return "absent";
  }
  const stat = statSync(path);
  if (!stat.isDirectory()) {
    return `file:${stat.size}:${stat.mtimeMs}`;
  }
  const entries = readdirSync(path, { withFileTypes: true })
    .map((entry) => {
      if (entry.isDirectory()) {
        return `${entry.name}/`;
      }
      try {
        const child = statSync(join(path, entry.name));
        return `${entry.name}:${child.size}:${child.mtimeMs}`;
      } catch {
        return entry.name;
      }
    })
    .sort();
  return `dir:${stat.mtimeMs}:${entries.join("|")}`;
}

function snapshotRealHome(): Map<string, string> {
  return new Map(sensitivePaths().map((path) => [path, fingerprint(path)]));
}

/** Environment values the code reads, all inside the temp root. */
function isolatedValues(): Record<string, string> {
  return {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    WORK_INTELLIGENCE_CONFIG_DIR: join(home, ".work-intelligence"),
    WORK_INTELLIGENCE_PORT: SENTINEL_PORT,
  };
}

/** Port requested by the first argument of `connect`/`listen` (number, numeric string, options object or array). */
function requestedPort(args: unknown[]): number | undefined {
  const first = args[0];
  if (Array.isArray(first)) {
    return requestedPort(first);
  }
  if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
    return Number(first);
  }
  if (typeof first === "object" && first !== null && "port" in first) {
    const port = Number((first as { port: unknown }).port);
    return Number.isNaN(port) ? undefined : port;
  }
  return undefined;
}

const PATCHED = Symbol.for("work-intelligence.test-isolation.port-guard");

/** Makes in-process sockets and servers refuse port 3210 with an explicit error. */
function guardForbiddenPort(): void {
  const targets: Array<{ prototype: Record<string, unknown>; method: "connect" | "listen" }> = [
    { prototype: net.Socket.prototype as unknown as Record<string, unknown>, method: "connect" },
    { prototype: net.Server.prototype as unknown as Record<string, unknown>, method: "listen" },
  ];
  for (const { prototype, method } of targets) {
    const original = prototype[method] as ((...args: unknown[]) => unknown) & Record<symbol, unknown>;
    if (original[PATCHED]) {
      continue;
    }
    const guarded = function (this: unknown, ...args: unknown[]): unknown {
      if (requestedPort(args) === FORBIDDEN_PORT) {
        throw new Error(
          `Test isolation: tests must not ${method} on port ${FORBIDDEN_PORT}; use port 0 or inject one.`,
        );
      }
      return original.apply(this, args);
    } as ((...args: unknown[]) => unknown) & Record<symbol, unknown>;
    guarded[PATCHED] = true;
    prototype[method] = guarded;
  }
}

function isStrict(): boolean {
  const flag = process.env.WORK_INTELLIGENCE_ISOLATION_STRICT;
  return flag === undefined ? Boolean(process.env.CI) : flag !== "0";
}

function applyIsolation(): void {
  for (const directory of [
    home,
    join(home, "AppData", "Roaming"),
    join(home, "AppData", "Local"),
    join(home, ".config"),
    join(home, ".local", "share"),
    join(home, ".local", "state"),
    join(home, ".codex"),
    join(home, ".claude"),
    join(home, ".work-intelligence"),
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  Object.assign(process.env, isolatedValues());
  for (const name of ["WORK_INTELLIGENCE_DB", "WORK_INTELLIGENCE_HOME", "WORK_INTELLIGENCE_BACKUP_DIR"]) {
    delete process.env[name];
  }
  guardForbiddenPort();
}

const before = snapshotRealHome();
applyIsolation();

afterAll(() => {
  const violations: string[] = [];
  if (os.homedir() === REAL_HOME) {
    violations.push(
      `os.homedir() resolves to the real home (${REAL_HOME}); a test removed or replaced HOME/USERPROFILE without restoring it.`,
    );
  }
  for (const [path, previous] of before) {
    if (fingerprint(path) !== previous) {
      violations.push(`${path} changed while the tests ran.`);
    }
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  if (violations.length === 0) {
    return;
  }
  const message = `Test isolation violated:\n${violations.join("\n")}`;
  if (isStrict()) {
    throw new Error(message);
  }
  // Locally a real Agent session may legitimately touch these paths; only report homedir problems as errors.
  if (violations.some((violation) => violation.startsWith("os.homedir()"))) {
    throw new Error(message);
  }
});
