/**
 * Adoption of hand-written checkout registrations ("改由桌面 App 管理"). The desktop App has no checkout, so a person
 * who registered `node <repo>/apps/mcp/dist/launcher.js` (or the finalize hooks) by hand can opt in to have those
 * entries rewritten in place to the launcher shim. Only forms setup itself writes are recognised; everything else is
 * reported and never touched. {@link findCheckoutRegistrations} is the read-only half and needs no checkout.
 */
import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  commandForAgentHook,
  commandForLauncherHook,
  commandWords,
  isLauncherMcpRegistration,
  isLauncherShimCommand,
  isNodeExecutable,
} from "./commands.js";
import {
  CLAUDE_HOOK_ACTION,
  CODEX_HOOK_ACTION,
  LAUNCHER_MCP_ARGUMENT,
  MCP_LAUNCHER_RELATIVE_PATH,
  MCP_SERVER_RELATIVE_PATH,
  TOML_BLOCK_END,
  TOML_BLOCK_START,
} from "./constants.js";
import { JSON_OBJECT, displayPath, readRegularFile } from "./files.js";
import { equalValue, stableJson } from "./json-config.js";
import { entryIndex, manifestPath, parseManifest, setEntry } from "./manifest.js";
import { normalizePlanOptions, targetPath } from "./paths.js";
import { parseTomlKeyPath } from "./toml.js";
import type { AgentInspectOptions, RegistrationKind } from "./inspect.js";
import type {
  AgentSetupAdoptedRegistration,
  AgentSetupComponentId,
  AgentSetupPlan,
  AgentSetupPlanOptions,
  HookComponentId,
  ManagedEntry,
} from "./types.js";

type CheckoutAgent = "codex" | "claude-code";

/** One registration that points at a checkout (or at least is not the launcher shim), found without any checkout. */
export interface CheckoutRegistration {
  agent: CheckoutAgent;
  kind: RegistrationKind;
  /** Which setup component the entry corresponds to; absent for a hook under an event setup does not manage. */
  componentId?: AgentSetupComponentId;
  /** The Agent config file the registration lives in. */
  location: string;
  /** The checkout root inferred from the script path, with the separators the entry uses. */
  repositoryRoot?: string;
  /** Whether {@link repositoryRoot} is still a directory on disk. */
  rootExists: boolean;
  /** Recorded in the setup manifest and still as setup wrote it; otherwise hand-written. */
  owned: boolean;
  /** A form setup can safely rewrite in place. */
  recognised: boolean;
  /** Why the entry is not recognised (zh-TW). */
  reason?: string;
  /** MCP only: `env.WORK_INTELLIGENCE_DB` (relative to the root), else `<root>/data/work-intelligence.sqlite`. */
  effectiveDatabase?: string;
}

/** What planning needs to adopt entries; built by {@link createAdoptContext}. */
export interface AdoptContext {
  plan: AgentSetupPlan;
  components: ManagedEntry[];
  homeDirectory: string;
  shimPath: string;
  platform: NodeJS.Platform;
  roots: ReadonlySet<string>;
  labelOf: (id: AgentSetupComponentId) => string;
}

interface ScanContext {
  components: readonly ManagedEntry[];
  platform: NodeJS.Platform;
}

interface McpAnalysis {
  recognised: boolean;
  reason?: string;
  root?: string;
  effectiveDatabase?: string;
  /** The relative `WORK_INTELLIGENCE_DB` as written, when it is relative. */
  relativeDatabase?: string;
  /** Set when the entry has no `WORK_INTELLIGENCE_DB`, so it used `<root>/data/work-intelligence.sqlite`. */
  missingDatabase?: true;
}

interface JsonMcpHit {
  info: CheckoutRegistration;
  analysis: McpAnalysis;
  entry: Record<string, unknown>;
}

interface HookHit {
  info: CheckoutRegistration;
  item: Record<string, unknown>;
  hook: Record<string, unknown>;
}

interface TomlStatement {
  kind: "header" | "pair";
  /** Offset of the first character of the statement's line. */
  start: number;
  /** Offset just after the statement's line terminator (or the end of the text). */
  eolEnd: number;
  path?: string[];
  array?: boolean;
  keyPath?: string[];
  valueStart?: number;
  valueEnd?: number;
}

interface TomlEdit {
  start: number;
  end: number;
  text: string;
}

interface TomlServerLayout {
  header: TomlStatement;
  body: TomlStatement[];
  envPairs: TomlStatement[];
  envHeader?: TomlStatement;
  /** Headers of tables that are neither the server's main table nor one of its sub-tables, as offsets. */
  otherHeaderStarts: number[];
  /** Headers of the server's sub-tables (`.env` included), as offsets. */
  subHeaderStarts: number[];
  /** End of the main table and of the sub-tables that directly follow it: where the managed block ends. */
  blockEnd: number;
}

interface TomlHit {
  info: CheckoutRegistration;
  analysis: McpAnalysis;
  layout?: TomlServerLayout;
  text: string;
  parsed: Record<string, unknown>;
}

const SERVER_NAME = "work-intelligence";
const DATABASE_ENV = "WORK_INTELLIGENCE_DB";
const FINALIZE_REMINDER_MARKER = "finalize-reminder";
const MAIN_TABLE = ["mcp_servers", SERVER_NAME];

const HOOK_COMPONENTS: Record<CheckoutAgent, Record<string, HookComponentId>> = {
  "claude-code": {
    Stop: "claudeStopHook",
    PreCompact: "claudePreCompactHook",
    PreToolUse: "claudePreToolUseHook",
    SessionStart: "claudeSessionStartHook",
  },
  codex: {
    PostToolUse: "codexPostToolUseHook",
    Stop: "codexStopHook",
    UserPromptSubmit: "codexUserPromptSubmitHook",
    PreToolUse: "codexPreToolUseHook",
    SessionStart: "codexSessionStartHook",
  },
};
const HOOK_SCRIPTS: Record<CheckoutAgent, string> = {
  "claude-code": "finalize-reminder.js",
  codex: "codex-finalize-reminder.js",
};
const HOOK_ACTIONS: Record<CheckoutAgent, string> = {
  "claude-code": CLAUDE_HOOK_ACTION,
  codex: CODEX_HOOK_ACTION,
};

function flavorOf(platform: NodeJS.Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

/** Roots are compared with one separator and, for Windows, without case, so `C:\Repo` equals `c:/repo/`. */
function comparableRoot(root: string, platform: NodeJS.Platform): string {
  const normalized = root
    .replaceAll("\\", "/")
    .replace(/(?<=.)\/+/g, "/")
    .replace(/(?<=.)\/$/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** The checkout root of a script path that ends with one of `relativePaths`, or why it cannot be told. */
function rootOfScript(
  scriptPath: string,
  relativePaths: readonly string[],
  platform: NodeJS.Platform,
): { root: string } | { reason: string } {
  const normalized = scriptPath.replaceAll("\\", "/");
  const haystack = platform === "win32" ? normalized.toLowerCase() : normalized;
  for (const relativePath of relativePaths) {
    const suffix = `/${relativePath}`;
    if (haystack === relativePath) return { reason: "script 路徑不是絕對路徑，無法判斷 checkout 位置" };
    if (!haystack.endsWith(suffix)) continue;
    const root = scriptPath.slice(0, scriptPath.length - suffix.length);
    return root !== "" && flavorOf(platform).isAbsolute(root)
      ? { root }
      : { reason: "script 路徑不是絕對路徑，無法判斷 checkout 位置" };
  }
  return { reason: `script 路徑不是 ${relativePaths.map((path) => `<checkout>/${path}`).join(" 或 ")}` };
}

function analyseMcpServer(server: unknown, platform: NodeJS.Platform): McpAnalysis | undefined {
  if (isLauncherMcpRegistration(server)) return undefined;
  if (!JSON_OBJECT(server) || typeof server.command !== "string") {
    return { recognised: false, reason: "不是 command 形式的 MCP 註冊" };
  }
  const args = Array.isArray(server.args) ? server.args : undefined;
  const scripts = [MCP_LAUNCHER_RELATIVE_PATH, MCP_SERVER_RELATIVE_PATH];
  let root: string | undefined;
  for (const argument of args ?? []) {
    if (typeof argument !== "string") continue;
    const found = rootOfScript(argument, scripts, platform);
    if ("root" in found) {
      root = found.root;
      break;
    }
  }
  const fail = (reason: string): McpAnalysis => ({ recognised: false, reason, ...(root ? { root } : {}) });
  if (!isNodeExecutable(server.command)) return fail("command 不是 node（例如 pnpm 啟動）");
  if (!args || args.length !== 1 || typeof args[0] !== "string") return fail("args 不是單一 script 路徑");
  const found = rootOfScript(args[0], scripts, platform);
  if (!("root" in found)) return fail(found.reason);
  const flavor = flavorOf(platform);
  const env = server.env;
  if (env !== undefined && !JSON_OBJECT(env)) return fail("env 結構不受支援");
  const database = JSON_OBJECT(env) ? env[DATABASE_ENV] : undefined;
  if (database === undefined) {
    return {
      recognised: true,
      root: found.root,
      effectiveDatabase: flavor.join(found.root, "data", "work-intelligence.sqlite"),
      missingDatabase: true,
    };
  }
  if (typeof database !== "string" || database === "" || database === ":memory:" || database.startsWith("file:")) {
    return { recognised: false, reason: `${DATABASE_ENV} 不是一般檔案路徑`, root: found.root };
  }
  return flavor.isAbsolute(database)
    ? { recognised: true, root: found.root, effectiveDatabase: database }
    : {
        recognised: true,
        root: found.root,
        effectiveDatabase: flavor.resolve(found.root, database),
        relativeDatabase: database,
      };
}

function analyseHookCommand(
  command: string,
  agent: CheckoutAgent,
  platform: NodeJS.Platform,
): { recognised: boolean; reason?: string; root?: string } | undefined {
  const words = commandWords(command);
  if (words?.[0] && isLauncherShimCommand(words[0]) && words[1] === HOOK_ACTIONS[agent] && words.length === 2) {
    return undefined;
  }
  const script = words?.[1];
  const found = script ? rootOfScript(script, [`apps/mcp/dist/${HOOK_SCRIPTS[agent]}`], platform) : undefined;
  const root = found && "root" in found ? found.root : undefined;
  const fail = (reason: string) => ({ recognised: false, reason, ...(root ? { root } : {}) });
  if (!words || words.length !== 2 || words[0] !== "node" || script === undefined) {
    return fail("指令不是 setup 寫入的 node <script> 形式");
  }
  if (!found || !("root" in found)) return fail(found?.reason ?? "指令不是 setup 寫入的形式");
  if (command !== commandForAgentHook(script, "linux") && command !== commandForAgentHook(script, "win32")) {
    return fail("指令的引號形式不是 setup 寫入的形式");
  }
  return { recognised: true, root: found.root };
}

function isOwned(components: readonly ManagedEntry[], id: AgentSetupComponentId, value: unknown): boolean {
  const entry = components[entryIndex(components as ManagedEntry[], id)];
  return (entry?.kind === "json-property" || entry?.kind === "json-array-item") && equalValue(entry.expected, value);
}

function scanClaudeMcp(root: Record<string, unknown>, context: ScanContext, location: string): JsonMcpHit | undefined {
  const servers = root.mcpServers;
  const entry = JSON_OBJECT(servers) ? servers[SERVER_NAME] : undefined;
  if (entry === undefined) return undefined;
  const analysis = analyseMcpServer(entry, context.platform);
  if (!analysis || !JSON_OBJECT(entry)) return undefined;
  return {
    analysis,
    entry,
    info: {
      agent: "claude-code",
      kind: "mcp",
      componentId: "claudeMcp",
      location,
      ...(analysis.root ? { repositoryRoot: analysis.root } : {}),
      rootExists: analysis.root ? existsSync(analysis.root) : false,
      owned: isOwned(context.components, "claudeMcp", entry),
      recognised: analysis.recognised,
      ...(analysis.reason ? { reason: analysis.reason } : {}),
      ...(analysis.effectiveDatabase ? { effectiveDatabase: analysis.effectiveDatabase } : {}),
    },
  };
}

function scanHooks(
  root: Record<string, unknown>,
  agent: CheckoutAgent,
  context: ScanContext,
  location: string,
): HookHit[] {
  const hits: HookHit[] = [];
  const hooks = root.hooks;
  if (!JSON_OBJECT(hooks)) return hits;
  for (const [event, items] of Object.entries(hooks)) {
    if (!Array.isArray(items)) continue;
    const componentId = HOOK_COMPONENTS[agent][event];
    for (const item of items) {
      if (!JSON_OBJECT(item)) continue;
      const candidates = Array.isArray(item.hooks) ? item.hooks : [item];
      for (const hook of candidates) {
        if (!JSON_OBJECT(hook) || typeof hook.command !== "string") continue;
        if (!hook.command.includes(FINALIZE_REMINDER_MARKER)) continue;
        const analysis = analyseHookCommand(hook.command, agent, context.platform);
        if (!analysis) continue;
        const reason = componentId ? analysis.reason : `事件 ${event} 不在 setup 管理的 hook 範圍`;
        hits.push({
          item,
          hook,
          info: {
            agent,
            kind: "hook",
            ...(componentId ? { componentId } : {}),
            location,
            ...(analysis.root ? { repositoryRoot: analysis.root } : {}),
            rootExists: analysis.root ? existsSync(analysis.root) : false,
            owned: componentId ? isOwned(context.components, componentId, item) : false,
            recognised: analysis.recognised && componentId !== undefined,
            ...(reason ? { reason } : {}),
          },
        });
      }
    }
  }
  // Two hooks for one component: rewriting either would leave the other, so none is safe to pick.
  const counts = new Map<string, number>();
  for (const { info } of hits)
    if (info.componentId) counts.set(info.componentId, (counts.get(info.componentId) ?? 0) + 1);
  for (const { info } of hits) {
    if (info.componentId && (counts.get(info.componentId) ?? 0) > 1 && info.recognised) {
      info.recognised = false;
      info.reason = "同一個事件有多個 finalize hook，無法判斷要改寫哪一個";
    }
  }
  return hits;
}

function skipBlanks(text: string, position: number): number {
  let index = position;
  while (text[index] === " " || text[index] === "\t") index += 1;
  return index;
}

function afterLine(text: string, position: number): number {
  const newline = text.indexOf("\n", position);
  return newline < 0 ? text.length : newline + 1;
}

/** The end offset of the TOML value that starts at `start`, or -1 when it is malformed. */
function scanTomlValue(text: string, start: number): number {
  const first = text[start];
  if (first === '"' || first === "'") {
    const triple = text.startsWith(first.repeat(3), start);
    if (!triple) {
      let index = start + 1;
      while (index < text.length) {
        const char = text[index];
        if (char === "\n") return -1;
        if (first === '"' && char === "\\") index += 2;
        else if (char === first) return index + 1;
        else index += 1;
      }
      return -1;
    }
    let index = start + 3;
    while (index < text.length) {
      if (first === '"' && text[index] === "\\") index += 2;
      else if (text.startsWith(first.repeat(3), index)) {
        index += 3;
        while (text[index] === first) index += 1;
        return index;
      } else index += 1;
    }
    return -1;
  }
  if (first === "[" || first === "{") {
    let depth = 0;
    let index = start;
    while (index < text.length) {
      const char = text[index];
      if (char === '"' || char === "'") {
        const end = scanTomlValue(text, index);
        if (end < 0) return -1;
        index = end;
        continue;
      }
      if (char === "#") {
        index = afterLine(text, index);
        continue;
      }
      if (char === "[" || char === "{") depth += 1;
      if (char === "]" || char === "}") {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
      index += 1;
    }
    return -1;
  }
  let index = start;
  while (index < text.length && text[index] !== "\n" && text[index] !== "#") index += 1;
  while (index > start && /\s/.test(text[index - 1] ?? "")) index -= 1;
  return index > start ? index : -1;
}

function findHeaderClose(text: string, open: number, array: boolean): number {
  let index = open;
  while (index < text.length) {
    const char = text[index];
    if (char === "\n") return -1;
    if (char === '"' || char === "'") {
      const end = scanTomlValue(text, index);
      if (end < 0) return -1;
      index = end;
      continue;
    }
    if (char === "]" && (!array || text[index + 1] === "]")) return index;
    index += 1;
  }
  return -1;
}

/** Splits a config.toml into table headers and key/value statements with exact offsets; undefined when malformed. */
function scanTomlStatements(text: string): TomlStatement[] | undefined {
  const statements: TomlStatement[] = [];
  let position = 0;
  while (position < text.length) {
    const lineStart = position;
    position = skipBlanks(text, position);
    const char = text[position];
    if (char === undefined) break;
    if (char === "\r" || char === "\n" || char === "#") {
      position = afterLine(text, position);
      continue;
    }
    if (char === "[") {
      const array = text[position + 1] === "[";
      const open = position + (array ? 2 : 1);
      const close = findHeaderClose(text, open, array);
      const path = close < 0 ? undefined : parseTomlKeyPath(text.slice(open, close));
      if (close < 0 || !path) return undefined;
      const contentEnd = close + (array ? 2 : 1);
      const lineEnd = afterLine(text, contentEnd);
      const rest = text.slice(contentEnd, lineEnd).trim();
      if (rest !== "" && !rest.startsWith("#")) return undefined;
      statements.push({ kind: "header", start: lineStart, eolEnd: lineEnd, path, array });
      position = lineEnd;
      continue;
    }
    let index = position;
    while (index < text.length && text[index] !== "=") {
      const current = text[index];
      if (current === "\n") return undefined;
      if (current === '"' || current === "'") {
        const end = scanTomlValue(text, index);
        if (end < 0) return undefined;
        index = end;
      } else index += 1;
    }
    const keyPath = index < text.length ? parseTomlKeyPath(text.slice(position, index)) : undefined;
    if (!keyPath) return undefined;
    const valueStart = skipBlanks(text, index + 1);
    const valueEnd = scanTomlValue(text, valueStart);
    if (valueEnd < 0) return undefined;
    const lineEnd = afterLine(text, valueEnd);
    const rest = text.slice(valueEnd, lineEnd).trim();
    if (rest !== "" && !rest.startsWith("#")) return undefined;
    statements.push({ kind: "pair", start: lineStart, eolEnd: lineEnd, keyPath, valueStart, valueEnd });
    position = lineEnd;
  }
  return statements;
}

function startsWithPath(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((key, index) => path[index] === key);
}

function samePath(path: readonly string[], other: readonly string[]): boolean {
  return path.length === other.length && startsWithPath(path, other);
}

/** Where the `[mcp_servers.work-intelligence]` table and its `env` live; undefined for any other TOML shape. */
function layoutTomlServer(statements: readonly TomlStatement[]): TomlServerLayout | undefined {
  let header: TomlStatement | undefined;
  let envHeader: TomlStatement | undefined;
  const body: TomlStatement[] = [];
  const envPairs: TomlStatement[] = [];
  const otherHeaderStarts: number[] = [];
  const subHeaderStarts: number[] = [];
  let current: string[] = [];
  for (const statement of statements) {
    if (statement.kind === "header") {
      const path = statement.path ?? [];
      current = path;
      if (statement.array && startsWithPath(path, MAIN_TABLE)) return undefined;
      if (samePath(path, MAIN_TABLE)) {
        if (header) return undefined;
        header = statement;
      } else if (samePath(path, [...MAIN_TABLE, "env"])) {
        if (envHeader) return undefined;
        envHeader = statement;
        subHeaderStarts.push(statement.start);
      } else if (startsWithPath(path, MAIN_TABLE)) subHeaderStarts.push(statement.start);
      else otherHeaderStarts.push(statement.start);
      continue;
    }
    const full = [...current, ...(statement.keyPath ?? [])];
    if (!startsWithPath(full, MAIN_TABLE)) continue;
    if (samePath(current, MAIN_TABLE)) body.push(statement);
    else if (samePath(current, [...MAIN_TABLE, "env"])) envPairs.push(statement);
    else if (!startsWithPath(current, MAIN_TABLE)) return undefined;
  }
  if (!header) return undefined;
  // The block must cover the sub-tables that directly follow the main table, or uninstall would orphan them.
  let blockEnd = header.eolEnd;
  let after = false;
  for (const statement of statements) {
    if (statement === header) {
      after = true;
      continue;
    }
    if (!after) continue;
    if (statement.kind === "header" && !startsWithPath(statement.path ?? [], MAIN_TABLE)) break;
    blockEnd = statement.eolEnd;
  }
  return { header, body, envPairs, envHeader, otherHeaderStarts, subHeaderStarts, blockEnd };
}

function pairValue(text: string, statement: TomlStatement): string {
  return text.slice(statement.valueStart, statement.valueEnd);
}

function findBodyPair(layout: TomlServerLayout, key: string): TomlStatement | undefined {
  const matches = layout.body.filter((statement) => samePath(statement.keyPath ?? [], [key]));
  return matches.length === 1 ? matches[0] : undefined;
}

/** The string literal of `WORK_INTELLIGENCE_DB` wherever the table keeps it (own table, dotted key, inline env). */
function findDatabaseToken(text: string, layout: TomlServerLayout): { start: number; end: number } | undefined {
  const quoted = (statement: TomlStatement) =>
    statement.valueStart !== undefined &&
    statement.valueEnd !== undefined &&
    (text[statement.valueStart] === '"' || text[statement.valueStart] === "'") &&
    !text.startsWith(text[statement.valueStart]!.repeat(3), statement.valueStart)
      ? { start: statement.valueStart, end: statement.valueEnd }
      : undefined;
  const own = layout.envPairs.find((statement) => samePath(statement.keyPath ?? [], [DATABASE_ENV]));
  if (own) return quoted(own);
  const dotted = layout.body.find((statement) => samePath(statement.keyPath ?? [], ["env", DATABASE_ENV]));
  if (dotted) return quoted(dotted);
  const inline = findBodyPair(layout, "env");
  if (!inline || inline.valueStart === undefined) return undefined;
  const value = pairValue(text, inline);
  const pattern = new RegExp(
    `(?:^|[{,]\\s*)(?:"${DATABASE_ENV}"|'${DATABASE_ENV}'|${DATABASE_ENV})\\s*=\\s*("(?:[^"\\\\\\r\\n]|\\\\.)*"|'[^'\\r\\n]*')`,
  );
  const match = pattern.exec(value);
  if (!match?.[1]) return undefined;
  const start = inline.valueStart + match.index + match[0].length - match[1].length;
  return { start, end: start + match[1].length };
}

/** Where the end marker goes: after the main table and the sub-tables that directly follow it. */
function sectionEnd(layout: TomlServerLayout): number {
  return layout.blockEnd;
}

/** Where and what to insert so a table without `WORK_INTELLIGENCE_DB` gets one; undefined for a shape not handled. */
function databaseInsertion(text: string, layout: TomlServerLayout, database: string): TomlEdit | undefined {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const line = (key: string) => `${key} = ${JSON.stringify(database)}`;
  const onNewLine = (position: number, content: string): TomlEdit => ({
    start: position,
    end: position,
    text: text.slice(0, position).endsWith("\n") || position === 0 ? content + newline : newline + content,
  });
  const dotted = layout.body.filter((statement) => statement.keyPath?.[0] === "env" && statement.keyPath.length > 1);
  const inline = findBodyPair(layout, "env");
  if (layout.envHeader) {
    const last = layout.envPairs.at(-1) ?? layout.envHeader;
    return onNewLine(last.eolEnd, line(DATABASE_ENV));
  }
  if (dotted.length) return onNewLine(dotted.at(-1)!.eolEnd, line(`env.${DATABASE_ENV}`));
  if (inline) {
    if (inline.valueStart === undefined || text[inline.valueStart] !== "{") return undefined;
    const empty = /^\{\s*\}/.test(text.slice(inline.valueStart));
    return {
      start: inline.valueStart + 1,
      end: inline.valueStart + 1,
      text: ` ${DATABASE_ENV} = ${JSON.stringify(database)}${empty ? "" : ","}`,
    };
  }
  if (layout.body.some((statement) => statement.keyPath?.[0] === "env")) return undefined;
  const last = layout.body.at(-1) ?? layout.header;
  return onNewLine(last.eolEnd, `env = { ${DATABASE_ENV} = ${JSON.stringify(database)} }`);
}

function scanCodexToml(text: string, context: ScanContext, location: string): TomlHit | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(text, { maxDepth: 128, unsafeKeyBehaviour: "throw" }) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const servers = parsed.mcp_servers;
  const server = JSON_OBJECT(servers) ? servers[SERVER_NAME] : undefined;
  if (server === undefined) return undefined;
  const analysis = analyseMcpServer(server, context.platform);
  if (!analysis) return undefined;

  const statements = scanTomlStatements(text);
  const layout = statements ? layoutTomlServer(statements) : undefined;
  let reason = analysis.reason;
  if (analysis.recognised) {
    if (!layout) {
      reason = "config.toml 不是單純的 [mcp_servers.work-intelligence] 表格形式";
    } else {
      const command = findBodyPair(layout, "command");
      const args = findBodyPair(layout, "args");
      const commandValue = command ? pairValue(text, command) : "";
      if (
        !command ||
        !args ||
        !/^(?:"[^"\n]*"|'[^'\n]*')$/.test(commandValue) ||
        !pairValue(text, args).startsWith("[")
      ) {
        reason = "command 或 args 不是可安全改寫的單純寫法";
      } else if (analysis.relativeDatabase !== undefined && !findDatabaseToken(text, layout)) {
        reason = `${DATABASE_ENV} 不是可安全改寫的單純寫法`;
      } else if (analysis.missingDatabase && !databaseInsertion(text, layout, analysis.effectiveDatabase ?? "")) {
        reason = `env 不是可安全補上 ${DATABASE_ENV} 的單純寫法`;
      } else if (layout.subHeaderStarts.some((start) => start >= layout.blockEnd)) {
        reason = "MCP 註冊的子表格與主表格不相連";
      } else {
        const markers = markerRange(text);
        if (markers === "invalid") reason = "安裝區塊標記不完整";
        else if (markers && !blockHoldsOnlyServer(markers, layout)) reason = "安裝區塊內含 MCP 註冊以外的內容";
      }
    }
  }
  const expected = ownedTomlBlock(context.components);
  return {
    analysis,
    layout,
    text,
    parsed,
    info: {
      agent: "codex",
      kind: "mcp",
      componentId: "codexMcp",
      location,
      ...(analysis.root ? { repositoryRoot: analysis.root } : {}),
      rootExists: analysis.root ? existsSync(analysis.root) : false,
      owned: expected !== undefined && text.includes(expected),
      recognised: analysis.recognised && reason === undefined,
      ...(reason ? { reason } : {}),
      ...(analysis.effectiveDatabase ? { effectiveDatabase: analysis.effectiveDatabase } : {}),
    },
  };
}

function ownedTomlBlock(components: readonly ManagedEntry[]): string | undefined {
  const entry = components[entryIndex(components as ManagedEntry[], "codexMcp")];
  return entry?.kind === "toml-block" ? entry.expected : undefined;
}

/** The setup block markers: their offsets, `undefined` when absent, `"invalid"` when not exactly one pair. */
function markerRange(text: string): { start: number; end: number } | undefined | "invalid" {
  const starts = text.split(TOML_BLOCK_START).length - 1;
  const ends = text.split(TOML_BLOCK_END).length - 1;
  if (starts === 0 && ends === 0) return undefined;
  const start = text.indexOf(TOML_BLOCK_START);
  const end = text.indexOf(TOML_BLOCK_END);
  return starts === 1 && ends === 1 && start < end ? { start, end } : "invalid";
}

function blockHoldsOnlyServer(markers: { start: number; end: number }, layout: TomlServerLayout): boolean {
  const insideStart = layout.header.start >= markers.start && sectionEnd(layout) <= markers.end;
  const inside = (start: number) => start >= markers.start && start <= markers.end;
  return (
    insideStart && layout.otherHeaderStarts.every((start) => !inside(start)) && layout.subHeaderStarts.every(inside)
  );
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
  const file = readRegularFile(path);
  if (!file.bytes) return undefined;
  try {
    const value: unknown = JSON.parse(file.bytes.toString("utf8"));
    return JSON_OBJECT(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function conflictOnce(plan: AgentSetupPlan, message: string): void {
  if (!plan.conflicts.includes(message)) plan.conflicts.push(message);
}

/** Whether this entry is to be rewritten; reports why not (as a conflict) for unrecognised or unlisted entries. */
function shouldAdopt(info: CheckoutRegistration, context: AdoptContext): boolean {
  // Setup's own checkout entries are migrated by the ordinary launcher plan.
  if (info.owned) return false;
  const label = `${info.componentId ? context.labelOf(info.componentId) : "hook"}（${displayPath(info.location, context.homeDirectory)}）`;
  if (!info.recognised || !info.repositoryRoot) {
    conflictOnce(
      context.plan,
      `${label}：無法安全改寫既有的 checkout 註冊（${info.reason ?? "未知形式"}）；保留且拒絕修改。`,
    );
    return false;
  }
  if (!context.roots.has(comparableRoot(info.repositoryRoot, context.platform))) {
    conflictOnce(
      context.plan,
      `${label}：指向的 checkout ${info.repositoryRoot} 不在改由桌面 App 管理的清單內；保留且拒絕修改。`,
    );
    return false;
  }
  return true;
}

function recordAdoption(context: AdoptContext, info: CheckoutRegistration, root: string): void {
  const adopted: AgentSetupAdoptedRegistration = {
    agent: info.agent,
    kind: info.kind,
    componentId: info.componentId!,
    location: info.location,
    repositoryRoot: root,
    ...(info.effectiveDatabase ? { effectiveDatabase: info.effectiveDatabase } : {}),
  };
  (context.plan.adopted ??= []).push(adopted);
  context.plan.actions.push(
    `改由桌面 App 管理 ${context.labelOf(adopted.componentId)}：${displayPath(info.location, context.homeDirectory)}` +
      `（原指向 checkout：${root}）` +
      (info.effectiveDatabase ? `；資料庫維持 ${info.effectiveDatabase}` : "") +
      "。",
  );
}

function announceDatabase(context: AdoptContext, analysis: McpAnalysis, label: string): void {
  if (analysis.missingDatabase) {
    context.plan.actions.push(
      `${label} 原未設定 ${DATABASE_ENV}（使用 checkout 內的資料庫），已寫入絕對路徑「${analysis.effectiveDatabase}」，實際使用的資料庫不變。`,
    );
    return;
  }
  if (analysis.relativeDatabase === undefined) return;
  context.plan.actions.push(
    `${label} 的 ${DATABASE_ENV} 原為相對路徑「${analysis.relativeDatabase}」，已依 checkout 改寫為絕對路徑「${analysis.effectiveDatabase}」，實際使用的資料庫不變。`,
  );
}

export function createAdoptContext(input: {
  plan: AgentSetupPlan;
  options: AgentSetupPlanOptions;
  components: ManagedEntry[];
  shimPath: string;
  platform: NodeJS.Platform;
  labels: ReadonlyMap<AgentSetupComponentId, string>;
}): AdoptContext {
  const roots = (input.options.adopt?.repositoryRoots ?? []).filter((root): root is string => typeof root === "string");
  return {
    plan: input.plan,
    components: input.components,
    homeDirectory: input.options.homeDirectory,
    shimPath: input.shimPath,
    platform: input.platform,
    roots: new Set(roots.map((root) => comparableRoot(root, input.platform))),
    labelOf: (id) => input.labels.get(id) ?? id,
  };
}

/**
 * Read-only and checkout-free: every registration of the Work Intelligence MCP server or finalize hook that is not
 * the launcher shim, per Agent config, with the checkout root it points at, whether that root still exists, whether
 * setup owns it, whether it is a form setup can rewrite safely (and why not), and the database an MCP entry uses.
 * Claude Desktop is out of scope; a plugin-enabled Agent is listed like any other.
 */
export function findCheckoutRegistrations(options: AgentInspectOptions): CheckoutRegistration[] {
  const normalized = normalizePlanOptions(options);
  const platform = options.platform ?? process.platform;
  const components = parseManifest(readRegularFile(manifestPath(normalized.homeDirectory)).bytes).manifest.components;
  const context: ScanContext = { components, platform };
  const found: CheckoutRegistration[] = [];

  const codexConfigPath = targetPath("codexMcp", normalized);
  const codexConfig = readRegularFile(codexConfigPath);
  if (codexConfig.bytes) {
    const hit = scanCodexToml(codexConfig.bytes.toString("utf8"), context, codexConfigPath);
    if (hit) found.push(hit.info);
  }
  const codexHooksPath = targetPath("codexStopHook", normalized);
  const codexHooks = readJsonObject(codexHooksPath);
  if (codexHooks) found.push(...scanHooks(codexHooks, "codex", context, codexHooksPath).map((hit) => hit.info));

  const claudeJsonPath = targetPath("claudeMcp", normalized);
  const claudeJson = readJsonObject(claudeJsonPath);
  const claudeMcp = claudeJson ? scanClaudeMcp(claudeJson, context, claudeJsonPath) : undefined;
  if (claudeMcp) found.push(claudeMcp.info);
  const claudeSettingsPath = targetPath("claudeStopHook", normalized);
  const claudeSettings = readJsonObject(claudeSettingsPath);
  if (claudeSettings) {
    found.push(...scanHooks(claudeSettings, "claude-code", context, claudeSettingsPath).map((hit) => hit.info));
  }
  return found;
}

/** Rewrites a recognised hand-written Claude `mcpServers.work-intelligence` entry in place; true when changed. */
export function adoptClaudeMcp(root: Record<string, unknown>, context: AdoptContext, location: string): boolean {
  const hit = scanClaudeMcp(root, context, location);
  if (!hit || !shouldAdopt(hit.info, context)) return false;
  const { entry, analysis, info } = hit;
  entry.command = context.shimPath;
  entry.args = [LAUNCHER_MCP_ARGUMENT];
  if (analysis.relativeDatabase !== undefined && JSON_OBJECT(entry.env)) {
    entry.env[DATABASE_ENV] = analysis.effectiveDatabase;
  } else if (analysis.missingDatabase) {
    // The launcher gives an entry without this variable the App's database; an explicit one always wins.
    entry.env = { ...(JSON_OBJECT(entry.env) ? entry.env : {}), [DATABASE_ENV]: analysis.effectiveDatabase };
  }
  setEntry(context.components, {
    id: "claudeMcp",
    kind: "json-property",
    expected: structuredClone(entry),
    adopted: true,
  });
  recordAdoption(context, info, analysis.root!);
  announceDatabase(context, analysis, context.labelOf("claudeMcp"));
  return true;
}

/** Rewrites the recognised hand-written finalize hooks of one Agent in place; true when anything changed. */
export function adoptHooks(
  root: Record<string, unknown>,
  agent: CheckoutAgent,
  context: AdoptContext,
  location: string,
): boolean {
  let changed = false;
  for (const { info, item, hook } of scanHooks(root, agent, context, location)) {
    if (!shouldAdopt(info, context) || !info.componentId) continue;
    hook.command = commandForLauncherHook(context.shimPath, HOOK_ACTIONS[agent], context.platform);
    setEntry(context.components, {
      id: info.componentId as HookComponentId,
      kind: "json-array-item",
      // Only this hook is ours: a group's sibling hooks belong to the user and must survive uninstall and undo.
      expected: Array.isArray(item.hooks)
        ? { ...structuredClone(item), hooks: [structuredClone(hook)] }
        : structuredClone(item),
      adopted: true,
    });
    recordAdoption(context, info, info.repositoryRoot!);
    changed = true;
  }
  return changed;
}

/**
 * Rewrites a recognised hand-written `[mcp_servers.work-intelligence]` table in place: only the `command` and `args`
 * values (and a relative `WORK_INTELLIGENCE_DB`) change; every other byte stays, line endings included. A table
 * without the setup block markers gets them around it so uninstall can find what setup owns. The result is parsed
 * again and compared with the expectation; anything that does not match is left alone and reported.
 */
export function adoptCodexToml(text: string, context: AdoptContext, location: string): string | undefined {
  const hit = scanCodexToml(text, context, location);
  if (!hit || !shouldAdopt(hit.info, context) || !hit.layout) return undefined;
  const { layout, analysis, info } = hit;
  const command = findBodyPair(layout, "command");
  const args = findBodyPair(layout, "args");
  if (!command || !args || command.valueStart === undefined || args.valueStart === undefined) return undefined;
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const edits: TomlEdit[] = [
    { start: command.valueStart, end: command.valueEnd!, text: JSON.stringify(context.shimPath) },
    { start: args.valueStart, end: args.valueEnd!, text: `[${JSON.stringify(LAUNCHER_MCP_ARGUMENT)}]` },
  ];
  if (analysis.relativeDatabase !== undefined) {
    const token = findDatabaseToken(text, layout);
    if (!token) return undefined;
    edits.push({ ...token, text: JSON.stringify(analysis.effectiveDatabase) });
  }
  if (!markerRange(text)) {
    const end = sectionEnd(layout);
    edits.push({ start: layout.header.start, end: layout.header.start, text: TOML_BLOCK_START + newline });
    edits.push({
      start: end,
      end,
      text: (text.slice(0, end).endsWith("\n") ? "" : newline) + TOML_BLOCK_END + newline,
    });
  }
  if (analysis.missingDatabase) {
    // Pushed after the end marker, which sorts first at the same offset, so the new line lands inside the block.
    const insertion = databaseInsertion(text, layout, analysis.effectiveDatabase ?? "");
    if (!insertion) return undefined;
    edits.push(insertion);
  }
  let next = text;
  for (const edit of [...edits].sort((left, right) => right.start - left.start || right.end - left.end)) {
    next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
  }

  const expected = structuredClone(hit.parsed);
  const expectedServer = JSON_OBJECT(expected.mcp_servers) ? expected.mcp_servers[SERVER_NAME] : undefined;
  if (!JSON_OBJECT(expectedServer)) return undefined;
  expectedServer.command = context.shimPath;
  expectedServer.args = [LAUNCHER_MCP_ARGUMENT];
  if (analysis.relativeDatabase !== undefined && JSON_OBJECT(expectedServer.env)) {
    expectedServer.env[DATABASE_ENV] = analysis.effectiveDatabase;
  } else if (analysis.missingDatabase) {
    expectedServer.env = {
      ...(JSON_OBJECT(expectedServer.env) ? expectedServer.env : {}),
      [DATABASE_ENV]: analysis.effectiveDatabase,
    };
  }
  try {
    const reparsed = parseToml(next, { maxDepth: 128, unsafeKeyBehaviour: "throw" });
    if (stableJson(reparsed) !== stableJson(expected)) throw new Error("mismatch");
  } catch {
    conflictOnce(
      context.plan,
      `${context.labelOf("codexMcp")}（${displayPath(location, context.homeDirectory)}）：改寫後的內容與預期不符；保留且拒絕修改。`,
    );
    return undefined;
  }
  const blockStart = next.indexOf(TOML_BLOCK_START);
  let blockEnd = next.indexOf(TOML_BLOCK_END, blockStart) + TOML_BLOCK_END.length;
  if (next.startsWith("\r\n", blockEnd)) blockEnd += 2;
  else if (next[blockEnd] === "\n") blockEnd += 1;
  setEntry(context.components, {
    id: "codexMcp",
    kind: "toml-block",
    expected: next.slice(blockStart, blockEnd),
    adopted: true,
  });
  recordAdoption(context, info, analysis.root!);
  announceDatabase(context, analysis, context.labelOf("codexMcp"));
  return next;
}
