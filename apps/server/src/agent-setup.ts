import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";

export type AgentSetupComponentId =
  | "codexSkill"
  | "codexLegacySkill"
  | "claudeSkill"
  | "codexMcp"
  | "claudeMcp"
  | "claudeStopHook"
  | "codexPostToolUseHook"
  | "codexStopHook"
  | "codexUserPromptSubmitHook";

export type CodexHooksFeature = "enabled" | "disabled" | "unknown";

export interface AgentSetupFinding {
  componentId: AgentSetupComponentId;
  state: "current" | "missing" | "stale" | "unreadable";
  detail: string;
}

export interface AgentSetupPlanOptions {
  homeDirectory: string;
  repositoryRoot: string;
  codexHomeDirectory?: string;
  claudeConfigDirectory?: string;
  now?: Date;
  platform?: NodeJS.Platform;
}

export interface AgentSetupFileMutation {
  path: string;
  label: string;
  before: Buffer | null;
  after: Buffer | null;
  mode: number;
  backupPath?: string;
}

export interface AgentSetupPlan {
  mode: "install" | "uninstall";
  actions: string[];
  conflicts: string[];
  mutations: AgentSetupFileMutation[];
}

export interface AgentSetupApplyResult {
  applied: boolean;
  actions: string[];
  conflicts: string[];
  error?: string;
}

export interface AgentSetupApplyOptions {
  /** Test seam for simulating a filesystem failure before a staged write. */
  beforeWrite?: (mutation: AgentSetupFileMutation, index: number) => void;
}

export interface AgentSetupCliDependencies extends AgentSetupPlanOptions {
  print: (message: string) => void;
  confirm?: (question: string) => Promise<boolean>;
}

type ManagedEntry =
  | { id: "codexSkill" | "codexLegacySkill" | "claudeSkill"; kind: "file"; expected: string }
  | { id: "codexMcp"; kind: "toml-block"; expected: string }
  | { id: "claudeMcp"; kind: "json-property"; expected: unknown }
  | {
      id: "claudeStopHook" | "codexPostToolUseHook" | "codexStopHook" | "codexUserPromptSubmitHook";
      kind: "json-array-item";
      expected: unknown;
    };

interface SetupManifest {
  version: 2;
  codexHomeDirectory?: string;
  claudeConfigDirectory?: string;
  components: ManagedEntry[];
}

interface JsonMutationSpec {
  id: ManagedEntry["id"];
  kind: "property" | "array-item";
  path: string[];
  expected: unknown;
  label: string;
  similar?: (value: unknown) => boolean;
  /**
   * An existing entry that already does the job (for example written by hand before setup existed, with an
   * absolute node path or exec-form args). It is kept as is and not recorded as setup-owned.
   */
  equivalent?: (value: unknown) => boolean;
  /** Returns an upgraded copy of an existing entry that needs only a known fix, or undefined. */
  upgrade?: (value: unknown) => unknown;
}

interface ReadFileResult {
  bytes: Buffer | null;
  mode: number;
  conflict?: string;
}

/** PostToolUse matcher that sees finalize calls both as a legacy direct tool and through the MCP dispatcher. */
export const CODEX_POST_TOOL_USE_MATCHER = "^(apply_patch|.*(work_finalize_session|work_write_idempotent))$";
/** Pre-dispatcher matcher; setup upgrades it and Doctor reports it as stale. */
export const LEGACY_CODEX_POST_TOOL_USE_MATCHER = "^(apply_patch|.*work_finalize_session)$";
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SKILL_SOURCE_RELATIVE_PATH = ".agents/skills/work-intelligence/SKILL.md";
const MANIFEST_FILENAME = ".work-intelligence-agent-setup.json";
const TOML_BLOCK_START = "# >>> Work Intelligence setup:agents >>>";
const TOML_BLOCK_END = "# <<< Work Intelligence setup:agents <<<";
const JSON_OBJECT = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Hash that ignores CRLF/LF differences, so a Windows checkout still matches the committed text. */
function lineEndingNeutralSha256(value: Buffer): string {
  return sha256(value.toString("utf8").replaceAll("\r\n", "\n"));
}

/**
 * Hashes of every committed version of the canonical skill. A user-scope copy byte-identical to one of them was
 * copied from this repository and never customised, so setup may upgrade it even without an ownership record.
 * Returns an empty set when Git or the history is unavailable, which keeps the conservative refuse-to-overwrite path.
 */
function publishedSkillHashes(repositoryRoot: string): Set<string> {
  const hashes = new Set<string>();
  const git = (args: string[], input?: string): Buffer =>
    execFileSync("git", ["-C", repositoryRoot, ...args], {
      input,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
  try {
    const commits = git(["rev-list", "HEAD", "--", SKILL_SOURCE_RELATIVE_PATH])
      .toString("utf8")
      .split(/\s+/)
      .filter(Boolean);
    if (!commits.length) return hashes;
    const output = git(
      ["cat-file", "--batch"],
      commits.map((commit) => `${commit}:${SKILL_SOURCE_RELATIVE_PATH}\n`).join(""),
    );
    let offset = 0;
    while (offset < output.length) {
      const headerEnd = output.indexOf(0x0a, offset);
      if (headerEnd < 0) break;
      const header = output.subarray(offset, headerEnd).toString("utf8").split(" ");
      offset = headerEnd + 1;
      if (header[1] !== "blob") continue;
      const size = Number(header[2]);
      hashes.add(lineEndingNeutralSha256(output.subarray(offset, offset + size)));
      offset += size + 1;
    }
  } catch {
    hashes.clear();
  }
  return hashes;
}

function equalValue(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (JSON_OBJECT(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function readRegularFile(path: string): ReadFileResult {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      return { bytes: null, mode: 0o600, conflict: `${path} 不是一般檔案，保留且拒絕修改。` };
    }
    return { bytes: readFileSync(path), mode: stats.mode & 0o777 };
  } catch (error) {
    if (JSON_OBJECT(error) && error.code === "ENOENT") {
      return { bytes: null, mode: 0o600 };
    }
    return { bytes: null, mode: 0o600, conflict: `無法讀取 ${path}，保留且拒絕修改。` };
  }
}

function targetPath(id: AgentSetupComponentId, options: AgentSetupPlanOptions): string {
  const codexHome = options.codexHomeDirectory ?? join(options.homeDirectory, ".codex");
  const claudeConfigDirectory = options.claudeConfigDirectory ?? join(options.homeDirectory, ".claude");
  switch (id) {
    case "codexSkill":
      return join(options.homeDirectory, ".agents", "skills", "work-intelligence", "SKILL.md");
    case "codexLegacySkill":
      return join(codexHome, "skills", "work-intelligence", "SKILL.md");
    case "claudeSkill":
      return join(claudeConfigDirectory, "skills", "work-intelligence", "SKILL.md");
    case "codexMcp":
      return join(codexHome, "config.toml");
    case "claudeMcp":
      return join(options.homeDirectory, ".claude.json");
    case "claudeStopHook":
      return join(claudeConfigDirectory, "settings.json");
    case "codexPostToolUseHook":
    case "codexStopHook":
    case "codexUserPromptSubmitHook":
      return join(codexHome, "hooks.json");
  }
}

function normalizePlanOptions(options: AgentSetupPlanOptions): AgentSetupPlanOptions {
  const homeDirectory = resolve(options.homeDirectory);
  return {
    ...options,
    homeDirectory,
    repositoryRoot: resolve(options.repositoryRoot),
    codexHomeDirectory: resolve(options.codexHomeDirectory ?? join(homeDirectory, ".codex")),
    claudeConfigDirectory: resolve(options.claudeConfigDirectory ?? join(homeDirectory, ".claude")),
  };
}

function manifestPath(homeDirectory: string): string {
  return join(homeDirectory, MANIFEST_FILENAME);
}

function skillLabel(id: "codexSkill" | "codexLegacySkill" | "claudeSkill"): string {
  if (id === "codexSkill") return "Codex canonical user-scope skill";
  if (id === "codexLegacySkill") return "Codex legacy compatibility skill copy";
  return "Claude Code user-scope skill";
}

function displayPath(path: string, homeDirectory: string): string {
  const absoluteHome = resolve(homeDirectory);
  const absolutePath = resolve(path);
  return absolutePath === absoluteHome
    ? "~"
    : absolutePath.startsWith(absoluteHome + "/")
      ? "~" + absolutePath.slice(absoluteHome.length)
      : absolutePath;
}

function backupPathFor(path: string, before: Buffer, now: Date): string {
  const stamp = now.toISOString().replaceAll(/[-:.]/g, "");
  const root = `${path}.work-intelligence.backup-${stamp}-${sha256(before).slice(0, 8)}`;
  let candidate = root;
  let suffix = 1;
  while (existsSync(candidate)) {
    candidate = `${root}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function parseManifest(bytes: Buffer | null): { manifest: SetupManifest; conflict?: string } {
  if (!bytes) {
    return { manifest: { version: 2, components: [] } };
  }
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (
      !JSON_OBJECT(parsed) ||
      (parsed.version !== 1 && parsed.version !== 2) ||
      !Array.isArray(parsed.components) ||
      (parsed.codexHomeDirectory !== undefined && typeof parsed.codexHomeDirectory !== "string") ||
      (parsed.claudeConfigDirectory !== undefined && typeof parsed.claudeConfigDirectory !== "string")
    ) {
      return {
        manifest: { version: 2, components: [] },
        conflict: "Work Intelligence 安裝紀錄格式不受支援；保留且拒絕修改。",
      };
    }
    const components: ManagedEntry[] = [];
    for (const item of parsed.components) {
      if (!JSON_OBJECT(item) || typeof item.id !== "string" || typeof item.kind !== "string") {
        return {
          manifest: { version: 2, components: [] },
          conflict: "Work Intelligence 安裝紀錄有未知項目；保留且拒絕修改。",
        };
      }
      const storedId = item.id as AgentSetupComponentId;
      if (parsed.version === 1 && storedId === "codexLegacySkill") {
        return {
          manifest: { version: 2, components: [] },
          conflict: "Work Intelligence 安裝紀錄有未知項目；保留且拒絕修改。",
        };
      }
      const id = parsed.version === 1 && storedId === "codexSkill" ? "codexLegacySkill" : storedId;
      const valid =
        ((id === "codexSkill" || id === "codexLegacySkill" || id === "claudeSkill") &&
          item.kind === "file" &&
          typeof item.expected === "string") ||
        (id === "codexMcp" && item.kind === "toml-block" && typeof item.expected === "string") ||
        (id === "claudeMcp" && item.kind === "json-property" && "expected" in item) ||
        ((id === "claudeStopHook" ||
          id === "codexPostToolUseHook" ||
          id === "codexStopHook" ||
          id === "codexUserPromptSubmitHook") &&
          item.kind === "json-array-item" &&
          "expected" in item);
      if (!valid) {
        return {
          manifest: { version: 2, components: [] },
          conflict: "Work Intelligence 安裝紀錄有未知項目；保留且拒絕修改。",
        };
      }
      components.push({ ...item, id } as ManagedEntry);
    }
    if (new Set(components.map((entry) => entry.id)).size !== components.length) {
      return {
        manifest: { version: 2, components: [] },
        conflict: "Work Intelligence 安裝紀錄有重複項目；保留且拒絕修改。",
      };
    }
    return {
      manifest: {
        version: 2,
        ...(typeof parsed.codexHomeDirectory === "string" ? { codexHomeDirectory: parsed.codexHomeDirectory } : {}),
        ...(typeof parsed.claudeConfigDirectory === "string"
          ? { claudeConfigDirectory: parsed.claudeConfigDirectory }
          : {}),
        components,
      },
    };
  } catch {
    return {
      manifest: { version: 2, components: [] },
      conflict: "Work Intelligence 安裝紀錄不是有效 JSON；保留且拒絕修改。",
    };
  }
}

function entryIndex(entries: ManagedEntry[], id: AgentSetupComponentId): number {
  return entries.findIndex((entry) => entry.id === id);
}

function setEntry(entries: ManagedEntry[], entry: ManagedEntry): void {
  const index = entryIndex(entries, entry.id);
  if (index < 0) entries.push(entry);
  else entries[index] = entry;
}

function removeEntry(entries: ManagedEntry[], id: AgentSetupComponentId): void {
  const index = entryIndex(entries, id);
  if (index >= 0) entries.splice(index, 1);
}

function getPathValue(root: Record<string, unknown>, path: readonly string[]): unknown {
  let value: unknown = root;
  for (const key of path) {
    if (!JSON_OBJECT(value)) return undefined;
    value = value[key];
  }
  return value;
}

function setPathValue(root: Record<string, unknown>, path: readonly string[], value: unknown): boolean {
  let current = root;
  for (const key of path.slice(0, -1)) {
    if (current[key] === undefined) current[key] = {};
    if (!JSON_OBJECT(current[key])) return false;
    current = current[key];
  }
  const last = path.at(-1);
  if (!last) return false;
  current[last] = value;
  return true;
}

function deletePathValue(root: Record<string, unknown>, path: readonly string[]): boolean {
  let current: unknown = root;
  for (const key of path.slice(0, -1)) {
    if (!JSON_OBJECT(current)) return false;
    current = current[key];
  }
  const last = path.at(-1);
  if (!last || !JSON_OBJECT(current)) return false;
  delete current[last];
  return true;
}

function referencesScriptPath(value: unknown, scriptPath: string): boolean {
  if (Array.isArray(value)) return value.some((item) => referencesScriptPath(item, scriptPath));
  if (!JSON_OBJECT(value)) return false;
  if (
    typeof value.command === "string" &&
    (value.command.includes(scriptPath) ||
      value.command.includes(quoteShellArgument(scriptPath, "linux")) ||
      value.command.includes(quoteShellArgument(scriptPath, "win32")))
  ) {
    return true;
  }
  if (
    Array.isArray(value.args) &&
    value.args.some(
      (argument) => typeof argument === "string" && normalizeConfigPath(argument) === normalizeConfigPath(scriptPath),
    )
  ) {
    return true;
  }
  return Object.values(value).some((item) => referencesScriptPath(item, scriptPath));
}

function normalizeConfigPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+/g, "/").replace(/\/$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isNodeExecutable(command: string): boolean {
  const executable = command.trim().replaceAll("\\", "/").split("/").at(-1)?.toLowerCase();
  return executable === "node" || executable === "node.exe" || executable === "nodejs" || executable === "nodejs.exe";
}

function isPnpmExecutable(command: string): boolean {
  const executable = command.trim().replaceAll("\\", "/").split("/").at(-1)?.toLowerCase();
  return executable === "pnpm" || executable === "pnpm.cmd" || executable === "pnpm.exe";
}

/** Split the quoted command form emitted by setup without evaluating shell syntax. */
function commandWords(command: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;
  let wordStarted = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === undefined) continue;
    const next = command[index + 1];

    if (quote === "'") {
      if (character === "'") quote = undefined;
      else word += character;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = undefined;
      else if (character === "\\" && next === '"') {
        word += '"';
        index += 1;
      } else word += character;
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      wordStarted = true;
    } else if (character === "\\") {
      if (next === undefined) word += character;
      else {
        word += next;
        index += 1;
      }
      wordStarted = true;
    } else if (/\s/.test(character)) {
      if (wordStarted) words.push(word);
      word = "";
      wordStarted = false;
    } else {
      word += character;
      wordStarted = true;
    }
  }

  if (quote) return undefined;
  if (wordStarted) words.push(word);
  return words;
}

function nodeCommandRunsScript(command: string, args: readonly string[], scriptPath: string): boolean {
  const parsedCommand = commandWords(command);
  if (!parsedCommand || !parsedCommand[0] || !isNodeExecutable(parsedCommand[0])) return false;
  const scriptArgument = parsedCommand[1] ?? args[0];
  return scriptArgument !== undefined && normalizeConfigPath(scriptArgument) === normalizeConfigPath(scriptPath);
}

/** A path alone does not prove that the command invokes Node with that script. */
function invokesNodeScript(value: unknown, scriptPath: string): boolean {
  if (Array.isArray(value)) return value.some((item) => invokesNodeScript(item, scriptPath));
  if (!JSON_OBJECT(value)) return false;

  const args = Array.isArray(value.args) ? value.args.filter((arg): arg is string => typeof arg === "string") : [];
  if (typeof value.command === "string" && nodeCommandRunsScript(value.command, args, scriptPath)) return true;
  return Object.values(value).some((item) => invokesNodeScript(item, scriptPath));
}

/**
 * Whether an MCP server entry launches this repository's MCP server, either through its built entry point
 * (`node <repo>/apps/mcp/dist/index.js`, any node path) or `pnpm --dir <repo> start:mcp` / `cwd: <repo>`.
 */
function launchesRepositoryMcp(value: unknown, repositoryRoot: string): boolean {
  if (!JSON_OBJECT(value) || typeof value.command !== "string") return false;
  const args = Array.isArray(value.args) ? value.args.filter((part): part is string => typeof part === "string") : [];
  const serverPath = normalizeConfigPath(resolve(repositoryRoot, "apps/mcp/dist/index.js"));

  if (isNodeExecutable(value.command) && args[0] && normalizeConfigPath(args[0]) === serverPath) return true;
  if (!isPnpmExecutable(value.command) || !args.includes("start:mcp")) return false;

  const dirFlag = args.findIndex((part) => part === "--dir" || part === "-C");
  const directory = dirFlag >= 0 ? args[dirFlag + 1] : typeof value.cwd === "string" ? value.cwd : undefined;
  return directory !== undefined && normalizeConfigPath(directory) === normalizeConfigPath(resolve(repositoryRoot));
}

/** Reads `[mcp_servers.work-intelligence]` from config.toml when it parses; undefined otherwise. */
function codexWorkIntelligenceServer(tomlText: string): unknown {
  try {
    const config = parseToml(tomlText, { maxDepth: 128, unsafeKeyBehaviour: "throw" }) as Record<string, unknown>;
    const servers = config.mcp_servers;
    return JSON_OBJECT(servers) ? servers["work-intelligence"] : undefined;
  } catch {
    return undefined;
  }
}

function sameManagedHookShape(actual: unknown, expected: unknown, key?: string): boolean {
  if (key === "command" && typeof actual === "string" && typeof expected === "string") return true;
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length < expected.length) return false;
    const unmatched = [...actual];
    for (const expectedItem of expected) {
      const match = unmatched.findIndex((actualItem) => sameManagedHookShape(actualItem, expectedItem));
      if (match < 0) return false;
      unmatched.splice(match, 1);
    }
    return true;
  }
  if (JSON_OBJECT(actual) || JSON_OBJECT(expected)) {
    if (!JSON_OBJECT(actual) || !JSON_OBJECT(expected)) return false;
    return Object.keys(expected).every(
      (childKey) => childKey in actual && sameManagedHookShape(actual[childKey], expected[childKey], childKey),
    );
  }
  return equalValue(actual, expected);
}

function parseJsonFile(
  path: string,
  homeDirectory: string,
  conflicts: string[],
): { root: Record<string, unknown>; before: Buffer | null; mode: number } {
  const read = readRegularFile(path);
  if (read.conflict) conflicts.push(read.conflict);
  if (!read.bytes) return { root: {}, before: null, mode: read.mode };
  try {
    const value: unknown = JSON.parse(read.bytes.toString("utf8"));
    if (!JSON_OBJECT(value)) throw new Error("expected object");
    return { root: value, before: read.bytes, mode: read.mode };
  } catch {
    conflicts.push(`${displayPath(path, homeDirectory)} 不是受支援的 JSON object，保留且拒絕修改。`);
    return { root: {}, before: read.bytes, mode: read.mode };
  }
}

function jsonIndent(source: Buffer | null): number {
  if (!source) return 2;
  const match = /\n([ \t]+)"/.exec(source.toString("utf8"));
  return match?.[1]?.length ?? 2;
}

function serializeJson(root: Record<string, unknown>, source: Buffer | null): Buffer {
  const newline = source?.toString("utf8").includes("\r\n") ? "\r\n" : "\n";
  return Buffer.from(JSON.stringify(root, null, jsonIndent(source)).replaceAll("\n", newline) + newline, "utf8");
}

function addJsonSpec(
  root: Record<string, unknown>,
  entries: ManagedEntry[],
  spec: JsonMutationSpec,
  conflicts: string[],
  actions: string[],
): boolean {
  const previousIndex = entryIndex(entries, spec.id);
  const previous = previousIndex >= 0 ? entries[previousIndex] : undefined;
  let changed = false;
  if (spec.kind === "property") {
    const current = getPathValue(root, spec.path);
    if (current === undefined) {
      if (!setPathValue(root, spec.path, spec.expected)) {
        conflicts.push(`${spec.label} 的設定結構不受支援，保留且拒絕修改。`);
        return false;
      }
      setEntry(entries, { id: spec.id as "claudeMcp", kind: "json-property", expected: spec.expected });
      return true;
    }
    if (equalValue(current, spec.expected)) {
      if (previous?.kind === "json-property") setEntry(entries, { ...previous, expected: spec.expected });
      return false;
    }
    if (previous?.kind === "json-property" && equalValue(current, previous.expected)) {
      setPathValue(root, spec.path, spec.expected);
      setEntry(entries, { id: spec.id as "claudeMcp", kind: "json-property", expected: spec.expected });
      return true;
    }
    if (spec.equivalent?.(current)) {
      actions.push(`保留既有 ${spec.label}：已指向這個 Work Intelligence，不修改。`);
      return false;
    }
    conflicts.push(`${spec.label} 已有不同設定，保留且拒絕覆寫。`);
    return changed;
  }

  const arrayKey = spec.path.at(-1);
  if (getPathValue(root, spec.path) === undefined) {
    if (!setPathValue(root, spec.path, [])) {
      conflicts.push(`${spec.label} 的設定結構不受支援，保留且拒絕修改。`);
      return false;
    }
  }
  const array = getPathValue(root, spec.path);
  if (!Array.isArray(array)) {
    conflicts.push(`${spec.label} 不是陣列，保留且拒絕修改。`);
    return false;
  }
  const exact = array.findIndex((item) => equalValue(item, spec.expected));
  if (exact >= 0) {
    if (previous?.kind === "json-array-item") setEntry(entries, { ...previous, expected: spec.expected });
    return false;
  }
  if (previous?.kind === "json-array-item") {
    const ownedIndex = array.findIndex((item) => equalValue(item, previous.expected));
    if (ownedIndex >= 0) {
      array.splice(ownedIndex, 1, spec.expected);
      setEntry(entries, {
        id: spec.id as ManagedEntry["id"],
        kind: "json-array-item",
        expected: spec.expected,
      } as ManagedEntry);
      return true;
    }
    if (array.some((item) => sameManagedHookShape(item, previous.expected))) {
      conflicts.push(`${spec.label} 已在安裝後修改；保留現有 hook 並拒絕新增重複項目。`);
      return false;
    }
  }
  if (spec.equivalent && array.some(spec.equivalent)) {
    actions.push(`保留既有 ${spec.label}：已指向這個 Work Intelligence，不修改。`);
    return false;
  }
  const upgradeIndex = spec.upgrade ? array.findIndex((item) => spec.upgrade?.(item) !== undefined) : -1;
  if (spec.upgrade && upgradeIndex >= 0) {
    array[upgradeIndex] = spec.upgrade(array[upgradeIndex]);
    actions.push(`更新既有 ${spec.label} 的 matcher，其餘自訂設定保留。`);
    return true;
  }
  if (arrayKey && spec.similar && array.some(spec.similar)) {
    conflicts.push(`${spec.label} 有已自訂的相似設定，保留且拒絕新增重複項目。`);
    return false;
  }
  array.push(spec.expected);
  setEntry(entries, {
    id: spec.id as ManagedEntry["id"],
    kind: "json-array-item",
    expected: spec.expected,
  } as ManagedEntry);
  changed = true;
  return changed;
}

function removeJsonSpec(
  root: Record<string, unknown>,
  entries: ManagedEntry[],
  entry: ManagedEntry,
  path: readonly string[],
  similar?: (value: unknown) => boolean,
  conflicts: string[] = [],
  label: string = entry.id,
): boolean {
  if (entry.kind === "json-property") {
    const current = getPathValue(root, path);
    if (current === undefined) {
      removeEntry(entries, entry.id);
      return false;
    }
    if (equalValue(current, entry.expected)) {
      deletePathValue(root, path);
      removeEntry(entries, entry.id);
      return true;
    }
    conflicts.push(`${label} 已在安裝後變更；保留現有設定與安裝紀錄。`);
    return false;
  }
  if (entry.kind !== "json-array-item") return false;
  const value = getPathValue(root, path);
  if (!Array.isArray(value)) {
    if (value === undefined) {
      removeEntry(entries, entry.id);
      return false;
    }
    conflicts.push(`${label} 的陣列結構已變更；保留現有設定與安裝紀錄。`);
    return false;
  }
  const index = value.findIndex((item) => equalValue(item, entry.expected));
  if (index >= 0) {
    value.splice(index, 1);
    removeEntry(entries, entry.id);
    return true;
  }
  if (value.some((item) => sameManagedHookShape(item, entry.expected))) {
    conflicts.push(`${label} 已在安裝後修改；保留該 hook 與安裝紀錄。`);
    return false;
  }
  if (similar && value.some(similar)) {
    conflicts.push(`${label} 已在安裝後修改；保留該 hook 與安裝紀錄。`);
    return false;
  }
  removeEntry(entries, entry.id);
  return false;
}

function codexHooksFeatureFromToml(text: string | undefined): CodexHooksFeature {
  if (text === undefined) return "enabled";
  let section: string[] = [];
  let foundFeatures = 0;
  const configuredValues = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const header = /^\[([^\]]+)\]\s*(?:#.*)?$/.exec(trimmed);
    if (header) {
      const parsed = parseTomlKeyPath(header[1] ?? "");
      if (!parsed) return "unknown";
      section = parsed;
      if (section.length === 1 && section[0] === "features") foundFeatures += 1;
      continue;
    }
    const equalIndex = trimmed.indexOf("=");
    if (equalIndex < 0) {
      if (section[0] === "features" || /features|codex_hooks|hooks/.test(trimmed)) return "unknown";
      continue;
    }
    const keyPath = parseTomlKeyPath(trimmed.slice(0, equalIndex));
    if (!keyPath) {
      if (section[0] === "features" || /features|codex_hooks|hooks/.test(trimmed.slice(0, equalIndex)))
        return "unknown";
      continue;
    }
    const fullPath = section.length ? [...section, ...keyPath] : keyPath;
    if (fullPath.length === 1 && fullPath[0] === "features") return "unknown";
    if (
      fullPath.length === 2 &&
      fullPath[0] === "features" &&
      (fullPath[1] === "hooks" || fullPath[1] === "codex_hooks")
    ) {
      const value = /^(true|false)\s*(?:#.*)?$/.exec(trimmed.slice(equalIndex + 1).trim());
      if (!value || configuredValues.has(fullPath[1])) return "unknown";
      configuredValues.set(fullPath[1], value[1] ?? "");
    }
  }
  if (foundFeatures > 1) return "unknown";
  return [...configuredValues.values()].includes("false") ? "disabled" : "enabled";
}

function codexTomlBlock(repositoryRoot: string, newline: string): string {
  const serverPath = resolve(repositoryRoot, "apps/mcp/dist/index.js");
  return [
    TOML_BLOCK_START,
    "[mcp_servers.work-intelligence]",
    'command = "node"',
    `args = [${JSON.stringify(serverPath)}]`,
    TOML_BLOCK_END,
    "",
  ].join(newline);
}

function parseTomlKeyPath(source: string): string[] | undefined {
  const keys: string[] = [];
  let index = 0;
  while (index < source.length) {
    while (/\s/.test(source[index] ?? "")) index += 1;
    const quote = source[index];
    if (quote === '"' || quote === "'") {
      const start = index;
      index += 1;
      let escaped = false;
      while (index < source.length) {
        const char = source[index];
        if (quote === '"' && !escaped && char === "\\") {
          escaped = true;
          index += 1;
          continue;
        }
        if (!escaped && char === quote) break;
        escaped = false;
        index += 1;
      }
      if (index >= source.length) return undefined;
      const token = source.slice(start, index + 1);
      let value: string;
      if (quote === '"') {
        try {
          value = JSON.parse(token) as string;
        } catch {
          return undefined;
        }
      } else {
        value = token.slice(1, -1);
      }
      keys.push(value);
      index += 1;
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(source.slice(index));
      if (!match) return undefined;
      keys.push(match[0]);
      index += match[0].length;
    }
    while (/\s/.test(source[index] ?? "")) index += 1;
    if (index === source.length) break;
    if (source[index] !== ".") return undefined;
    index += 1;
    while (/\s/.test(source[index] ?? "")) index += 1;
    if (index === source.length) return undefined;
  }
  return keys.length ? keys : undefined;
}

function tomlHasUnsupportedMcpEntry(text: string): boolean {
  let section: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const header = /^\[\[?(.+?)\]\]?\s*(?:#.*)?$/.exec(trimmed);
    if (header) {
      const headerText = header[1] ?? "";
      const parsed = parseTomlKeyPath(headerText);
      if (!parsed) return true;
      section = parsed;
      if (section[0] === "mcp_servers" && section[1] === "work-intelligence") return true;
      continue;
    }
    const equalIndex = trimmed.indexOf("=");
    if (equalIndex < 0) {
      if (section[0] === "mcp_servers" || /mcp_servers/.test(trimmed)) return true;
      continue;
    }
    const keyText = trimmed.slice(0, equalIndex).trim();
    const parsed = parseTomlKeyPath(keyText);
    if (!parsed) {
      if (section[0] === "mcp_servers" || /mcp_servers/.test(keyText)) return true;
      continue;
    }
    const fullPath = section.length ? [...section, ...parsed] : parsed;
    if (fullPath[0] === "mcp_servers" && fullPath[1] === "work-intelligence") return true;
    if (fullPath.length === 1 && fullPath[0] === "mcp_servers") return true;
    if (section.length === 1 && section[0] === "mcp_servers" && parsed[0] === "work-intelligence") return true;
  }
  return false;
}

function stageMutation(
  plan: AgentSetupPlan,
  options: AgentSetupPlanOptions,
  path: string,
  label: string,
  before: Buffer | null,
  after: Buffer | null,
  mode: number,
): void {
  if (before?.equals(after ?? Buffer.alloc(0)) && after !== null) return;
  if (before === null && after === null) return;
  if (before === null && after === null) return;
  if (before && after && before.equals(after)) return;
  const mutation: AgentSetupFileMutation = { path, label, before, after, mode };
  if (before) mutation.backupPath = backupPathFor(path, before, options.now ?? new Date());
  plan.mutations.push(mutation);
  const verb = after === null ? "移除" : before ? "更新" : "建立";
  plan.actions.push(
    `${verb} ${label}：${displayPath(path, options.homeDirectory)}${mutation.backupPath ? `（備份：${displayPath(mutation.backupPath, options.homeDirectory)}）` : ""}`,
  );
}

function addConflict(plan: AgentSetupPlan, message: string): void {
  if (!plan.conflicts.includes(message)) plan.conflicts.push(message);
}

function getClaudeMcpSpec(repositoryRoot: string): JsonMutationSpec {
  const serverPath = resolve(repositoryRoot, "apps/mcp/dist/index.js");
  return {
    id: "claudeMcp",
    kind: "property",
    path: ["mcpServers", "work-intelligence"],
    expected: { type: "stdio", command: "node", args: [serverPath] },
    label: "Claude MCP 註冊",
    equivalent: (value) => launchesRepositoryMcp(value, repositoryRoot),
  };
}

function quoteShellArgument(value: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return `"${value.replaceAll('"', '\\"')}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function commandForAgentHook(scriptPath: string, platform: NodeJS.Platform = process.platform): string {
  return `node ${quoteShellArgument(scriptPath, platform)}`;
}

function getClaudeStopSpec(repositoryRoot: string, platform: NodeJS.Platform): JsonMutationSpec {
  const scriptPath = resolve(repositoryRoot, "apps/mcp/dist/finalize-reminder.js");
  const expected = { hooks: [{ type: "command", command: commandForAgentHook(scriptPath, platform) }] };
  return {
    id: "claudeStopHook",
    kind: "array-item",
    path: ["hooks", "Stop"],
    expected,
    label: "Claude Stop hook",
    similar: (value) => referencesScriptPath(value, scriptPath),
    equivalent: (value) => invokesNodeScript(value, scriptPath),
  };
}

function getCodexHookSpecs(repositoryRoot: string, platform: NodeJS.Platform): JsonMutationSpec[] {
  const scriptPath = resolve(repositoryRoot, "apps/mcp/dist/codex-finalize-reminder.js");
  const command = commandForAgentHook(scriptPath, platform);
  const simpleHook = { hooks: [{ type: "command", command }] };
  const matcher = CODEX_POST_TOOL_USE_MATCHER;
  const compatibleMatchers = new Set([matcher, LEGACY_CODEX_POST_TOOL_USE_MATCHER]);
  return [
    {
      id: "codexPostToolUseHook",
      kind: "array-item",
      path: ["hooks", "PostToolUse"],
      expected: { matcher, hooks: [{ type: "command", command }] },
      label: "Codex PostToolUse hook",
      similar: (value) =>
        JSON_OBJECT(value) &&
        typeof value.matcher === "string" &&
        compatibleMatchers.has(value.matcher) &&
        referencesScriptPath(value, scriptPath),
      equivalent: (value) => JSON_OBJECT(value) && value.matcher === matcher && invokesNodeScript(value, scriptPath),
      upgrade: (value) =>
        JSON_OBJECT(value) &&
        value.matcher === LEGACY_CODEX_POST_TOOL_USE_MATCHER &&
        invokesNodeScript(value, scriptPath)
          ? { ...value, matcher }
          : undefined,
    },
    {
      id: "codexStopHook",
      kind: "array-item",
      path: ["hooks", "Stop"],
      expected: simpleHook,
      label: "Codex Stop hook",
      similar: (value) => referencesScriptPath(value, scriptPath),
      equivalent: (value) => invokesNodeScript(value, scriptPath),
    },
    {
      id: "codexUserPromptSubmitHook",
      kind: "array-item",
      path: ["hooks", "UserPromptSubmit"],
      expected: simpleHook,
      label: "Codex UserPromptSubmit hook",
      similar: (value) => referencesScriptPath(value, scriptPath),
      equivalent: (value) => invokesNodeScript(value, scriptPath),
    },
  ];
}

function installPlan(options: AgentSetupPlanOptions): AgentSetupPlan {
  const plan: AgentSetupPlan = { mode: "install", actions: [], conflicts: [], mutations: [] };
  options = normalizePlanOptions(options);
  const homeDirectory = options.homeDirectory;
  const repositoryRoot = options.repositoryRoot;
  for (const relativePath of [
    "apps/mcp/dist/index.js",
    "apps/mcp/dist/finalize-reminder.js",
    "apps/mcp/dist/codex-finalize-reminder.js",
  ]) {
    if (!existsSync(join(repositoryRoot, relativePath))) {
      addConflict(plan, `缺少 ${relativePath}；請先執行 pnpm build，再重新預覽。`);
    }
  }
  const manifestTarget = manifestPath(homeDirectory);
  const manifestFile = readRegularFile(manifestTarget);
  if (manifestFile.conflict) addConflict(plan, manifestFile.conflict);
  const parsedManifest = parseManifest(manifestFile.bytes);
  if (parsedManifest.conflict) addConflict(plan, parsedManifest.conflict);
  if (
    parsedManifest.manifest.components.length > 0 &&
    ((parsedManifest.manifest.codexHomeDirectory &&
      parsedManifest.manifest.codexHomeDirectory !== options.codexHomeDirectory) ||
      (parsedManifest.manifest.claudeConfigDirectory &&
        parsedManifest.manifest.claudeConfigDirectory !== options.claudeConfigDirectory))
  ) {
    addConflict(
      plan,
      "安裝時使用的 CODEX_HOME 或 CLAUDE_CONFIG_DIR 已變更；請先用原設定解除安裝，避免操作到其他設定目錄。",
    );
  }
  const components = parsedManifest.manifest.components;
  const sourcePath = join(repositoryRoot, SKILL_SOURCE_RELATIVE_PATH);
  const sourceFile = readRegularFile(sourcePath);
  if (sourceFile.conflict || !sourceFile.bytes) {
    addConflict(plan, `找不到可安裝的 work-intelligence skill：${displayPath(sourcePath, homeDirectory)}。`);
  }
  const skillBytes = sourceFile.bytes ?? Buffer.alloc(0);
  const skillHash = sha256(skillBytes);
  let publishedHashes: Set<string> | undefined;
  const isPublishedSkillCopy = (bytes: Buffer): boolean =>
    (publishedHashes ??= publishedSkillHashes(repositoryRoot)).has(lineEndingNeutralSha256(bytes));

  for (const id of ["codexSkill", "codexLegacySkill", "claudeSkill"] as const) {
    const path = targetPath(id, options);
    const current = readRegularFile(path);
    if (current.conflict) addConflict(plan, current.conflict);
    const ownedIndex = entryIndex(components, id);
    const owned = ownedIndex >= 0 ? components[ownedIndex] : undefined;
    const currentHash = current.bytes ? sha256(current.bytes) : undefined;
    if (currentHash === skillHash) {
      if (owned?.kind === "file") setEntry(components, { id, kind: "file", expected: skillHash });
      continue;
    }
    const ownedAndUnchanged = owned?.kind === "file" && currentHash === owned.expected;
    if (current.bytes && !ownedAndUnchanged && !isPublishedSkillCopy(current.bytes)) {
      addConflict(plan, `${displayPath(path, homeDirectory)} 已有不同內容；保留且拒絕覆寫。`);
      continue;
    }
    stageMutation(plan, options, path, skillLabel(id), current.bytes, skillBytes, current.mode);
    setEntry(components, { id, kind: "file", expected: skillHash });
  }

  const tomlPath = targetPath("codexMcp", options);
  const tomlFile = readRegularFile(tomlPath);
  if (tomlFile.conflict) addConflict(plan, tomlFile.conflict);
  const tomlText = tomlFile.bytes?.toString("utf8") ?? "";
  const tomlNewline = tomlText.includes("\r\n") ? "\r\n" : "\n";
  const desiredBlock = codexTomlBlock(repositoryRoot, tomlNewline);
  const tomlEntryIndex = entryIndex(components, "codexMcp");
  const tomlOwned = tomlEntryIndex >= 0 ? components[tomlEntryIndex] : undefined;
  const tomlOwnedExpected = tomlOwned?.kind === "toml-block" ? tomlOwned.expected : undefined;
  if (tomlText.includes(desiredBlock)) {
    if (tomlOwned?.kind === "toml-block")
      setEntry(components, { id: "codexMcp", kind: "toml-block", expected: desiredBlock });
  } else if (tomlOwnedExpected && tomlText.includes(tomlOwnedExpected)) {
    const next = tomlText.replace(tomlOwnedExpected, desiredBlock);
    stageMutation(plan, options, tomlPath, "Codex MCP 註冊", tomlFile.bytes, Buffer.from(next, "utf8"), tomlFile.mode);
    setEntry(components, { id: "codexMcp", kind: "toml-block", expected: desiredBlock });
  } else if (!tomlOwned && launchesRepositoryMcp(codexWorkIntelligenceServer(tomlText), repositoryRoot)) {
    plan.actions.push("保留既有 Codex MCP 註冊：已指向這個 Work Intelligence，不修改。");
  } else if (tomlOwned && !tomlText.includes(tomlOwnedExpected ?? "")) {
    if (tomlText.includes(TOML_BLOCK_START) || tomlText.includes(TOML_BLOCK_END)) {
      addConflict(plan, "Codex MCP 的安裝區塊已被修改；保留且拒絕覆寫。");
    } else if (!tomlHasUnsupportedMcpEntry(tomlText)) {
      const prefix = tomlText && !tomlText.endsWith("\n") ? tomlText + tomlNewline : tomlText;
      stageMutation(
        plan,
        options,
        tomlPath,
        "Codex MCP 註冊",
        tomlFile.bytes,
        Buffer.from(prefix + desiredBlock, "utf8"),
        tomlFile.mode,
      );
      setEntry(components, { id: "codexMcp", kind: "toml-block", expected: desiredBlock });
    } else {
      addConflict(plan, "Codex config.toml 已有未支援的 mcp_servers 結構；保留且拒絕修改。");
    }
  } else if (tomlHasUnsupportedMcpEntry(tomlText)) {
    addConflict(plan, "Codex config.toml 已有未支援的 mcp_servers 結構；保留且拒絕修改。");
  } else {
    const prefix = tomlText && !tomlText.endsWith("\n") ? tomlText + tomlNewline : tomlText;
    stageMutation(
      plan,
      options,
      tomlPath,
      "Codex MCP 註冊",
      tomlFile.bytes,
      Buffer.from(prefix + desiredBlock, "utf8"),
      tomlFile.mode,
    );
    setEntry(components, { id: "codexMcp", kind: "toml-block", expected: desiredBlock });
  }

  const codexFeature = codexHooksFeatureFromToml(tomlText);
  if (codexFeature === "disabled") {
    plan.actions.push("保留 ~/.codex/config.toml 的 [features].hooks=false；略過 Codex hooks 設定。");
  } else if (codexFeature === "unknown") {
    plan.actions.push("無法安全判斷 Codex hooks 是否停用；保留設定並略過 Codex hooks。");
  }

  const jsonFileChanges = new Map<
    string,
    { before: Buffer | null; mode: number; root: Record<string, unknown>; changed: boolean }
  >();
  const mutateJson = (path: string, specs: JsonMutationSpec[]) => {
    const loaded = parseJsonFile(path, homeDirectory, plan.conflicts);
    const changes = { before: loaded.before, mode: loaded.mode, root: loaded.root, changed: false };
    for (const spec of specs)
      changes.changed = addJsonSpec(changes.root, components, spec, plan.conflicts, plan.actions) || changes.changed;
    jsonFileChanges.set(path, changes);
  };

  const platform = options.platform ?? process.platform;
  mutateJson(targetPath("claudeMcp", options), [getClaudeMcpSpec(repositoryRoot)]);
  mutateJson(targetPath("claudeStopHook", options), [getClaudeStopSpec(repositoryRoot, platform)]);
  if (codexFeature !== "disabled" && codexFeature !== "unknown") {
    mutateJson(targetPath("codexStopHook", options), getCodexHookSpecs(repositoryRoot, platform));
  }

  for (const [path, file] of jsonFileChanges) {
    if (file.changed)
      stageMutation(
        plan,
        options,
        path,
        "Agent JSON 設定",
        file.before,
        serializeJson(file.root, file.before),
        file.mode,
      );
  }

  const nextManifest: SetupManifest = {
    version: 2,
    codexHomeDirectory: options.codexHomeDirectory,
    claudeConfigDirectory: options.claudeConfigDirectory,
    components,
  };
  const manifestAfter = components.length ? Buffer.from(JSON.stringify(nextManifest, null, 2) + "\n", "utf8") : null;
  stageMutation(
    plan,
    options,
    manifestTarget,
    "Work Intelligence 安裝紀錄",
    manifestFile.bytes,
    manifestAfter,
    manifestFile.mode,
  );
  if (!plan.actions.length) plan.actions.push("Codex 與 Claude Code 的 MCP、skill 及可用 hooks 已符合設定；不需變更。");
  return plan;
}

function uninstallPlan(options: AgentSetupPlanOptions): AgentSetupPlan {
  const plan: AgentSetupPlan = { mode: "uninstall", actions: [], conflicts: [], mutations: [] };
  options = normalizePlanOptions(options);
  const homeDirectory = options.homeDirectory;
  const repositoryRoot = options.repositoryRoot;
  const path = manifestPath(homeDirectory);
  const file = readRegularFile(path);
  if (file.conflict) addConflict(plan, file.conflict);
  const parsed = parseManifest(file.bytes);
  if (parsed.conflict) addConflict(plan, parsed.conflict);
  options = normalizePlanOptions({
    ...options,
    codexHomeDirectory: parsed.manifest.codexHomeDirectory ?? options.codexHomeDirectory,
    claudeConfigDirectory: parsed.manifest.claudeConfigDirectory ?? options.claudeConfigDirectory,
  });
  if (!file.bytes) {
    plan.actions.push("沒有 Work Intelligence 安裝紀錄；未移除任何設定。");
    return plan;
  }
  const remaining = [...parsed.manifest.components];
  const changedJson = new Map<
    string,
    { before: Buffer | null; mode: number; root: Record<string, unknown>; changed: boolean }
  >();
  const loadJson = (target: string) => {
    const existing = changedJson.get(target);
    if (existing) return existing;
    const loaded = parseJsonFile(target, homeDirectory, plan.conflicts);
    const result = { before: loaded.before, mode: loaded.mode, root: loaded.root, changed: false };
    changedJson.set(target, result);
    return result;
  };

  for (const entry of parsed.manifest.components) {
    const target = targetPath(entry.id, options);
    if (entry.kind === "file") {
      const current = readRegularFile(target);
      if (current.conflict) {
        addConflict(plan, current.conflict);
      } else if (!current.bytes) {
        removeEntry(remaining, entry.id);
      } else if (sha256(current.bytes) === entry.expected) {
        stageMutation(plan, options, target, skillLabel(entry.id), current.bytes, null, current.mode);
        removeEntry(remaining, entry.id);
      } else {
        addConflict(plan, `${displayPath(target, homeDirectory)} 已在安裝後修改；保留且不解除安裝。`);
      }
      continue;
    }
    if (entry.kind === "toml-block") {
      const current = readRegularFile(target);
      if (current.conflict) addConflict(plan, current.conflict);
      const text = current.bytes?.toString("utf8") ?? "";
      const openCount = text.split(TOML_BLOCK_START).length - 1;
      const closeCount = text.split(TOML_BLOCK_END).length - 1;
      if (!current.bytes || (openCount === 0 && closeCount === 0)) {
        removeEntry(remaining, entry.id);
      } else if (openCount === 1 && closeCount === 1 && text.includes(entry.expected)) {
        const next = text.replace(entry.expected, "");
        stageMutation(plan, options, target, "Codex MCP 註冊", current.bytes, Buffer.from(next, "utf8"), current.mode);
        removeEntry(remaining, entry.id);
      } else {
        addConflict(plan, "Codex MCP 的安裝區塊已在安裝後修改；保留且不解除安裝。");
      }
      continue;
    }
    if (entry.kind === "json-property") {
      const spec = getClaudeMcpSpec(repositoryRoot);
      const targetFile = loadJson(target);
      targetFile.changed =
        removeJsonSpec(targetFile.root, remaining, entry, spec.path, undefined, plan.conflicts, "Claude MCP 註冊") ||
        targetFile.changed;
      continue;
    }
    const spec =
      entry.id === "claudeStopHook"
        ? getClaudeStopSpec(repositoryRoot, options.platform ?? process.platform)
        : getCodexHookSpecs(repositoryRoot, options.platform ?? process.platform).find((item) => item.id === entry.id);
    if (!spec) {
      addConflict(plan, `無法識別 ${entry.id} 的安裝項目；保留安裝紀錄。`);
      continue;
    }
    const targetFile = loadJson(target);
    targetFile.changed =
      removeJsonSpec(targetFile.root, remaining, entry, spec.path, spec.similar, plan.conflicts, spec.label) ||
      targetFile.changed;
  }

  for (const [target, targetFile] of changedJson) {
    if (targetFile.changed)
      stageMutation(
        plan,
        options,
        target,
        "Agent JSON 設定",
        targetFile.before,
        serializeJson(targetFile.root, targetFile.before),
        targetFile.mode,
      );
  }
  const remainingManifest = remaining.length
    ? Buffer.from(
        JSON.stringify(
          {
            version: 2,
            codexHomeDirectory: options.codexHomeDirectory,
            claudeConfigDirectory: options.claudeConfigDirectory,
            components: remaining,
          },
          null,
          2,
        ) + "\n",
        "utf8",
      )
    : null;
  stageMutation(plan, options, path, "Work Intelligence 安裝紀錄", file.bytes, remainingManifest, file.mode);
  if (!plan.actions.length) plan.actions.push("沒有可安全移除的 Work Intelligence 設定。");
  return plan;
}

function readCurrent(path: string): Buffer | null {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error("symbolic link");
    return readFileSync(path);
  } catch (error) {
    if (JSON_OBJECT(error) && error.code === "ENOENT") return null;
    throw new Error(`套用前無法安全讀取 ${path}。`, { cause: error });
  }
}

function sameNullableBuffer(left: Buffer | null, right: Buffer | null): boolean {
  if (left === null || right === null) return left === right;
  return left.equals(right);
}

function writeAtomically(path: string, bytes: Buffer, mode: number): void {
  const temporaryPath = `${path}.work-intelligence.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporaryPath, bytes, { flag: "wx", mode });
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // Keep the original failure; temporary-file cleanup is best effort.
    }
    throw error;
  }
}

function writeExclusiveAtomically(path: string, bytes: Buffer): void {
  const temporaryPath = `${path}.work-intelligence.tmp-${randomUUID()}`;
  let linked = false;
  try {
    writeFileSync(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
    linkSync(temporaryPath, path);
    linked = true;
    unlinkSync(temporaryPath);
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true });
      if (linked) rmSync(path, { force: true });
    } catch {
      // Keep the original failure; temporary-file cleanup is best effort.
    }
    throw error;
  }
}

function ensureDirectory(path: string, createdDirectories: Set<string>): void {
  const missing: string[] = [];
  let current = path;
  while (!existsSync(current)) {
    missing.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  mkdirSync(path, { recursive: true });
  for (const directory of missing) createdDirectories.add(directory);
}

function printPlan(plan: AgentSetupPlan, options: AgentSetupCliDependencies): void {
  options.print(plan.mode === "install" ? "Agent 設定預覽（尚未寫入）：" : "解除安裝預覽（尚未寫入）：");
  for (const action of plan.actions) options.print(`- ${action}`);
  for (const conflict of plan.conflicts) options.print(`- 衝突：${conflict}`);
  if (plan.conflicts.length) options.print("發現設定衝突，沒有任何項目會寫入；請先手動處理衝突後重試。");
}

function printProjectInstructionSnippet(options: AgentSetupCliDependencies): void {
  const snippet = [
    "## Work Intelligence",
    "",
    "- 在已由使用者明確設為「記錄中」的專案，開始工作前透過 `work_read` 執行 `work_get_project_status`，再以 `work_read` 執行 `work_get_context`，並提供任務與已知路徑。",
    "- 第一次呼叫某個 operation 前，讀取 `work-intelligence://agent/tool-contracts/<operation>` 取得該操作的完整契約（索引在 `work-intelligence://agent/tool-contracts`）；需要完整隱私規則與操作流程時，讀取 `work-intelligence://agent/work-intelligence/SKILL.md`；準備或修正記錄與報告時，再讀 `work-intelligence://agent/work-record-and-report-format.md`。",
    "- 工作完成後，在完成驗證與交接後透過 `work_write_idempotent` 執行 operation `work_finalize_session`；只回報實際確認的成果、變更檔案與驗證結果。若專案不是 tracked，或無法確認狀態，不要建立 Work Intelligence 記錄。",
  ].join("\n");
  options.print(`\n可貼入其他專案的 AGENTS.md 或 CLAUDE.md：\n\`\`\`markdown\n${snippet}\n\`\`\``);
}

export function inspectAgentSkillCopies(
  homeDirectory: string,
  repositoryRoot: string,
  codexHomeDirectory?: string,
  claudeConfigDirectory?: string,
): AgentSetupFinding[] {
  const options = normalizePlanOptions({ homeDirectory, repositoryRoot, codexHomeDirectory, claudeConfigDirectory });
  const sourcePath = join(options.repositoryRoot, SKILL_SOURCE_RELATIVE_PATH);
  const source = readRegularFile(sourcePath);
  const ids = ["codexSkill", "codexLegacySkill", "claudeSkill"] as const;
  return ids.map((id) => {
    const path = targetPath(id, options);
    const current = readRegularFile(path);
    if (source.conflict || !source.bytes) {
      return { componentId: id, state: "unreadable", detail: "找不到 repo 內的 canonical work-intelligence skill。" };
    }
    if (current.conflict) return { componentId: id, state: "unreadable", detail: "無法安全讀取 user-scope skill。" };
    if (!current.bytes) {
      const detail =
        id === "codexLegacySkill"
          ? "尚未安裝 CODEX_HOME 下的 Codex legacy compatibility skill 複本。"
          : id === "codexSkill"
            ? "尚未安裝 home/.agents/skills 下的 Codex canonical skill。"
            : "尚未安裝 Claude Code user-scope skill。";
      return { componentId: id, state: "missing", detail };
    }
    return sha256(current.bytes) === sha256(source.bytes)
      ? {
          componentId: id,
          state: "current",
          detail:
            id === "codexLegacySkill"
              ? "CODEX_HOME 下的 compatibility 複本與 canonical skill 內容完全相同。"
              : "內容與 repo 內的 canonical skill 完全相同。",
        }
      : {
          componentId: id,
          state: "stale",
          detail:
            id === "codexLegacySkill"
              ? "CODEX_HOME 下的 compatibility 複本與 repo 內版本不同。"
              : "user-scope skill 與 repo 內版本不同。",
        };
  });
}

export function inspectCodexHooksFeature(homeDirectory: string, codexHomeDirectory?: string): CodexHooksFeature {
  const path = join(resolve(codexHomeDirectory ?? join(homeDirectory, ".codex")), "config.toml");
  const file = readRegularFile(path);
  if (file.conflict) return "unknown";
  return codexHooksFeatureFromToml(file.bytes?.toString("utf8"));
}

export function createAgentSetupPlan(
  options: AgentSetupPlanOptions,
  mode: "install" | "uninstall" = "install",
): AgentSetupPlan {
  return mode === "install" ? installPlan(options) : uninstallPlan(options);
}

export function applyAgentSetupPlan(plan: AgentSetupPlan, options: AgentSetupApplyOptions = {}): AgentSetupApplyResult {
  if (plan.conflicts.length) return { applied: false, actions: [], conflicts: plan.conflicts };
  const appliedMutations: AgentSetupFileMutation[] = [];
  const createdBackups: string[] = [];
  const createdDirectories = new Set<string>();
  try {
    for (const mutation of plan.mutations) {
      const current = readCurrent(mutation.path);
      if (!sameNullableBuffer(current, mutation.before)) {
        return {
          applied: false,
          actions: [],
          conflicts: [`${mutation.path} 在預覽後已變更；沒有寫入，請重新預覽。`],
        };
      }
      if (mutation.backupPath && existsSync(mutation.backupPath)) {
        return { applied: false, actions: [], conflicts: [`備份目標已存在：${mutation.backupPath}。`] };
      }
    }

    for (const mutation of plan.mutations) {
      if (!mutation.before || !mutation.backupPath) continue;
      ensureDirectory(dirname(mutation.backupPath), createdDirectories);
      writeExclusiveAtomically(mutation.backupPath, mutation.before);
      createdBackups.push(mutation.backupPath);
    }
    for (const [index, mutation] of plan.mutations.entries()) {
      options.beforeWrite?.(mutation, index);
      ensureDirectory(dirname(mutation.path), createdDirectories);
      if (mutation.after === null) {
        if (existsSync(mutation.path)) unlinkSync(mutation.path);
      } else {
        writeAtomically(mutation.path, mutation.after, mutation.mode);
      }
      appliedMutations.push(mutation);
    }
    return { applied: true, actions: plan.actions, conflicts: [] };
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const mutation of appliedMutations.reverse()) {
      try {
        if (mutation.before === null) {
          if (existsSync(mutation.path)) unlinkSync(mutation.path);
        } else {
          writeAtomically(mutation.path, mutation.before, mutation.mode);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
      }
    }
    if (!rollbackErrors.length) {
      for (const backupPath of createdBackups) {
        try {
          rmSync(backupPath, { force: true });
        } catch (cleanupError) {
          rollbackErrors.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
        }
      }
      for (const directory of [...createdDirectories].sort((left, right) => right.length - left.length)) {
        try {
          rmdirSync(directory);
        } catch {
          // Keep directories that are no longer empty; empty ones are best-effort cleanup.
        }
      }
    }
    return {
      applied: false,
      actions: [],
      conflicts: [],
      error: [error instanceof Error ? error.message : "無法完成 Agent 設定。", ...rollbackErrors].join(
        "；rollback 失敗：",
      ),
    };
  }
}

export async function runAgentSetupCli(args: string[], dependencies: AgentSetupCliDependencies): Promise<number> {
  let mode: "install" | "uninstall" = "install";
  for (const arg of args) {
    if (arg === "--uninstall") mode = "uninstall";
    else return (dependencies.print(`不支援的參數：${arg}`), 1);
  }
  let exitCode = 0;
  try {
    const plan = createAgentSetupPlan(dependencies, mode);
    printPlan(plan, dependencies);
    if (plan.conflicts.length) {
      exitCode = 1;
    } else if (plan.mutations.length) {
      if (!dependencies.confirm || !(await dependencies.confirm("確認套用以上變更？輸入 yes 後才會寫入："))) {
        dependencies.print("已取消；設定未變更。");
      } else {
        const result = applyAgentSetupPlan(plan);
        if (!result.applied) {
          for (const conflict of result.conflicts) dependencies.print(`- 衝突：${conflict}`);
          if (result.error) dependencies.print(`錯誤：${result.error}`);
          exitCode = 1;
        } else {
          dependencies.print(mode === "install" ? "Agent 設定完成。" : "Work Intelligence 設定已解除安裝。");
          for (const action of result.actions) dependencies.print(`- ${action}`);
        }
      }
    }
  } catch (error) {
    dependencies.print(`錯誤：${error instanceof Error ? error.message : String(error)}`);
    exitCode = 1;
  }
  printProjectInstructionSnippet(dependencies);
  return exitCode;
}

export function defaultAgentSetupDependencies(
  print: (message: string) => void,
  confirm?: (question: string) => Promise<boolean>,
): AgentSetupCliDependencies {
  const homeDirectory = homedir();
  const codexHomeDirectory = process.env.CODEX_HOME?.trim();
  const claudeConfigDirectory = process.env.CLAUDE_CONFIG_DIR?.trim();
  return {
    homeDirectory,
    repositoryRoot: REPOSITORY_ROOT,
    ...(codexHomeDirectory ? { codexHomeDirectory } : {}),
    ...(claudeConfigDirectory ? { claudeConfigDirectory } : {}),
    print,
    ...(confirm ? { confirm } : {}),
  };
}
