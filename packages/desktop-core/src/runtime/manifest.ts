import { RuntimeError } from "./errors.js";
import { casefoldKey, relativePathProblem, symlinkTargetProblem } from "./paths.js";

/** The launcher script every shim starts; always at the root of the runtime directory, so it is not configurable. */
export const LAUNCHER_ENTRY_NAME = "launcher.mjs";

/** The only actions a launcher starts. Anything else is refused before a file is read. */
export const RUNTIME_ACTIONS = ["mcp", "serve", "codex-finalize-reminder", "claude-finalize-reminder"] as const;

/** One of {@link RUNTIME_ACTIONS}. */
export type RuntimeAction = (typeof RUNTIME_ACTIONS)[number];

/** Hook actions fail open: an unusable runtime must never block the Agent that called the hook. */
export const HOOK_ACTIONS: ReadonlySet<string> = new Set<RuntimeAction>([
  "codex-finalize-reminder",
  "claude-finalize-reminder",
]);

/** How the bundled executable runs a script: as plain Node, or as Electron with ELECTRON_RUN_AS_NODE=1. */
export const RUNTIME_KINDS = ["node", "electron-run-as-node"] as const;

/** One of {@link RUNTIME_KINDS}. */
export type RuntimeKind = (typeof RUNTIME_KINDS)[number];

/** Directory names and the `current` pointer use this charset, which a shell can validate without a JSON parser. */
export const RUNTIME_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** What one action runs: an entry script of the runtime and fixed arguments that come before the caller's. */
export interface RuntimeActionSpec {
  readonly entry: string;
  readonly args?: readonly string[];
}

/** The `actions` section of a manifest. */
export type RuntimeActions = Readonly<Partial<Record<RuntimeAction, RuntimeActionSpec>>>;

/** One file of the runtime: relative path, size in bytes and lowercase hex SHA-256. */
export interface RuntimeFileEntry {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

/** One symlink the runtime may contain, with the target exactly as `readlink` returns it. */
export interface RuntimeSymlinkEntry {
  readonly path: string;
  readonly target: string;
}

/**
 * Version 1 of the runtime manifest, written once when a runtime is installed and never changed afterwards.
 * `files` lists EVERY file of the runtime directory (except this manifest and the verification cache); a file that is
 * not listed makes the runtime invalid. `symlinks` lists the links a runtime may contain (macOS framework bundles);
 * each target must stay inside the runtime.
 */
export interface RuntimeManifest {
  readonly manifestVersion: 1;
  readonly runtimeId: string;
  readonly runtimeKind: RuntimeKind;
  readonly executable: string;
  readonly actions: RuntimeActions;
  readonly files: readonly RuntimeFileEntry[];
  readonly symlinks: readonly RuntimeSymlinkEntry[];
}

/** The executable path is written into a plain-text file read by sh and cmd, so they use a safe subset. */
const SHIM_SAFE_PATH_PATTERN = /^[A-Za-z0-9._/-]+$/;
/** A SHA-256 digest as 64 lowercase hex digits; the manifest and the verification cache share it. */
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_REPORTED_ISSUES = 12;

/** Whether `value` is a legal runtime id. */
export function isRuntimeId(value: string): boolean {
  return RUNTIME_ID_PATTERN.test(value);
}

/** Whether `value` is one of the fixed actions. */
export function isRuntimeAction(value: string): value is RuntimeAction {
  return (RUNTIME_ACTIONS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collects problems with the path they belong to; a few lines per problem keep launcher errors readable. */
class Issues {
  readonly #messages: string[] = [];

  add(at: string, message: string): void {
    this.#messages.push(`${at}: ${message}`);
  }

  get any(): boolean {
    return this.#messages.length > 0;
  }

  /** Records any key that is not in `allowed` (the manifest is strict: unknown fields mean a newer or damaged file). */
  onlyKeys(value: Record<string, unknown>, allowed: readonly string[], at: string): void {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) this.add(at, `unknown field "${key}"`);
    }
  }

  /** Reads `value` as a relative path; `shimSafe` limits it to the charset the shims accept. */
  path(value: unknown, at: string, shimSafe = false): value is string {
    if (typeof value !== "string") {
      this.add(at, "must be a string");
      return false;
    }
    let problem = relativePathProblem(value);
    if (problem === undefined && shimSafe && !SHIM_SAFE_PATH_PATTERN.test(value)) {
      problem = "path may only contain letters, digits, '.', '_', '-' and '/'";
    }
    if (problem !== undefined) this.add(at, problem);
    return problem === undefined;
  }

  toString(): string {
    const shown = this.#messages.slice(0, MAX_REPORTED_ISSUES).join("; ");
    return this.#messages.length > MAX_REPORTED_ISSUES
      ? `${shown}; …(+${this.#messages.length - MAX_REPORTED_ISSUES})`
      : shown;
  }
}

function checkActions(value: unknown, issues: Issues): void {
  if (!isRecord(value)) return issues.add("actions", "must be an object");
  issues.onlyKeys(value, RUNTIME_ACTIONS, "actions");
  for (const [action, spec] of Object.entries(value)) {
    const at = `actions.${action}`;
    if (!isRecord(spec)) {
      issues.add(at, "must be an object");
      continue;
    }
    issues.onlyKeys(spec, ["entry", "args"], at);
    issues.path(spec.entry, `${at}.entry`);
    const args = spec.args;
    if (
      args !== undefined &&
      !(Array.isArray(args) && args.every((arg) => typeof arg === "string" && !arg.includes("\0")))
    ) {
      issues.add(`${at}.args`, "must be an array of strings without NUL");
    }
  }
}

function checkFiles(value: unknown, issues: Issues): void {
  if (!Array.isArray(value) || value.length === 0) return issues.add("files", "must be a non-empty array");
  value.forEach((entry: unknown, index) => {
    const at = `files.${index}`;
    if (!isRecord(entry)) return issues.add(at, "must be an object");
    issues.onlyKeys(entry, ["path", "size", "sha256"], at);
    issues.path(entry.path, `${at}.path`);
    if (!Number.isSafeInteger(entry.size) || (entry.size as number) < 0)
      issues.add(`${at}.size`, "must be a non-negative integer");
    if (typeof entry.sha256 !== "string" || !SHA256_PATTERN.test(entry.sha256))
      issues.add(`${at}.sha256`, "must be 64 lowercase hex digits");
  });
}

function checkSymlinks(value: unknown, issues: Issues): void {
  if (!Array.isArray(value)) return issues.add("symlinks", "must be an array");
  value.forEach((entry: unknown, index) => {
    const at = `symlinks.${index}`;
    if (!isRecord(entry)) return issues.add(at, "must be an object");
    issues.onlyKeys(entry, ["path", "target"], at);
    if (!issues.path(entry.path, `${at}.path`)) return;
    if (typeof entry.target !== "string") return issues.add(`${at}.target`, "must be a string");
    const problem = symlinkTargetProblem(entry.path, entry.target);
    if (problem !== undefined) issues.add(`${at}.target`, problem);
  });
}

/** Relations between fields: no path twice (case-insensitively), and everything the launcher starts is a listed file. */
function checkRelations(manifest: RuntimeManifest, issues: Issues): void {
  const seen = new Set<string>();
  for (const entry of [...manifest.files, ...manifest.symlinks]) {
    const key = casefoldKey(entry.path);
    if (seen.has(key)) issues.add("files", `duplicate path (case-insensitive): ${entry.path}`);
    seen.add(key);
  }
  const listed = new Set(manifest.files.map((file) => file.path));
  const required: [string, string][] = [
    ["executable", manifest.executable],
    ["launcher", LAUNCHER_ENTRY_NAME],
    ...Object.entries(manifest.actions).map(([action, spec]): [string, string] => [
      `actions.${action}.entry`,
      spec.entry,
    ]),
  ];
  for (const [field, value] of required) {
    if (!listed.has(value)) issues.add(field, `not listed in files: ${value}`);
  }
}

/**
 * Validates a parsed manifest and returns it typed. Any problem, including an unknown field or version, is a
 * `RUNTIME_MANIFEST_INVALID` error: the launcher fails closed instead of guessing what a newer manifest meant.
 * Hand-written rather than a zod schema because the launcher runs before every MCP session and hook, and loading zod
 * costs about 45 ms of start-up there (measured); this file has no dependency beyond the path rules.
 */
export function parseRuntimeManifest(raw: unknown): RuntimeManifest {
  const issues = new Issues();
  if (!isRecord(raw)) {
    issues.add("(root)", "must be an object");
  } else {
    issues.onlyKeys(
      raw,
      ["manifestVersion", "runtimeId", "runtimeKind", "executable", "actions", "files", "symlinks"],
      "(root)",
    );
    if (raw.manifestVersion !== 1) issues.add("manifestVersion", "must be 1");
    if (typeof raw.runtimeId !== "string" || !isRuntimeId(raw.runtimeId))
      issues.add("runtimeId", "has a forbidden character or length");
    if (!(RUNTIME_KINDS as readonly unknown[]).includes(raw.runtimeKind))
      issues.add("runtimeKind", `must be one of ${RUNTIME_KINDS.join(", ")}`);
    issues.path(raw.executable, "executable", true);
    checkActions(raw.actions, issues);
    checkFiles(raw.files, issues);
    checkSymlinks(raw.symlinks, issues);
    if (!issues.any) checkRelations(raw as unknown as RuntimeManifest, issues);
  }
  if (issues.any)
    throw new RuntimeError("RUNTIME_MANIFEST_INVALID", "runtime manifest 格式不正確", { actual: issues.toString() });
  return raw as unknown as RuntimeManifest;
}
