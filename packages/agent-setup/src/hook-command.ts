import { statSync } from "node:fs";
import { posix, win32 } from "node:path";
import {
  commandWords,
  isLauncherMcpRegistration,
  isLauncherShimCommand,
  isNodeExecutable,
  isPnpmExecutable,
  normalizeConfigPath,
  unwrapCmd,
} from "./commands.js";
import {
  CLAUDE_HOOK_ACTION,
  CLAUDE_PRE_TOOL_USE_MATCHER,
  CODEX_HOOK_ACTION,
  CODEX_POST_TOOL_USE_MATCHER,
  CODEX_PRE_TOOL_USE_MATCHER,
  COMPACT_SESSION_START_MATCHER,
  LEGACY_CODEX_POST_TOOL_USE_MATCHER,
  MCP_LAUNCHER_RELATIVE_PATH,
  MCP_SERVER_RELATIVE_PATH,
} from "./constants.js";
import { JSON_OBJECT } from "./files.js";
import { claudePluginEnabled } from "./plugins.js";

export type HookCommandKind = "launcher" | "checkout" | "other";

export interface HookCommandClassification {
  kind: HookCommandKind;
  action?: string;
  scriptPath?: string;
  current?: boolean;
}

export interface HookCommandOptions {
  platform?: NodeJS.Platform;
  shimPath?: string;
  args?: readonly string[];
}

export type HookAgent = "claude-code" | "codex";

export type HookInstallState = "installed" | "stale" | "missing" | "disabled" | "unknown";

export type HookInstallSource = "app" | "checkout" | "plugin";

export type HookStaleReason = "script-missing" | "shim-differs" | "matcher-outdated";

export interface HookEventInspection {
  event: string;
  matcher: string | null;
  required: boolean;
  state: HookInstallState;
  source: HookInstallSource | null;
  reason?: HookStaleReason;
}

export interface HookInstallation {
  agent: HookAgent;
  state: HookInstallState;
  source: HookInstallSource | null;
  events: HookEventInspection[];
}

export interface HookInspectionContext extends HookCommandOptions {
  pluginEnabled?: boolean;
  hooksDisabled?: boolean;
  isFile?: (path: string) => boolean;
}

export type McpRegistrationKind = "launcher" | "checkout" | "direct" | "other";

export interface McpRegistrationClassification {
  kind: McpRegistrationKind;
  source: "app" | "checkout" | null;
}

export interface McpRegistrationContext {
  platform?: NodeJS.Platform;
  isFile?: (path: string) => boolean;
}

interface HookRequirement {
  event: string;
  matcher: string | null;
  required: boolean;
  judge: (matcher: unknown) => "current" | "outdated" | undefined;
}

interface HookCandidate {
  state: "installed" | "stale";
  source: HookInstallSource | null;
  reason?: HookStaleReason;
}

const CHECKOUT_SCRIPT_ACTIONS: ReadonlyMap<string, string> = new Map([
  ["finalize-reminder.js", CLAUDE_HOOK_ACTION],
  ["codex-finalize-reminder.js", CODEX_HOOK_ACTION],
]);
const KNOWN_HOOK_ACTIONS: ReadonlySet<string> = new Set([CLAUDE_HOOK_ACTION, CODEX_HOOK_ACTION]);
const CHECKOUT_SCRIPT_DIRECTORY = "/apps/mcp/dist/";
const AGENT_ACTIONS: Readonly<Record<HookAgent, string>> = {
  "claude-code": CLAUDE_HOOK_ACTION,
  codex: CODEX_HOOK_ACTION,
};
const CLAUDE_PRE_TOOL_USE_TOOL_NAME = "mcp__work-intelligence__work_write_idempotent";
const CODEX_PRE_TOOL_USE_TOOL_NAME = "mcp__work_intelligence__work_write_idempotent";
const MAX_INSPECTED_NODES = 500;

// An absent, empty or "*" matcher selects everything; plain names match exactly.
function matcherSelects(matcher: unknown, value: string): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*") return true;
  if (typeof matcher !== "string") return false;
  if (/^[\w|]+$/.test(matcher)) return matcher.split("|").includes(value);
  try {
    return new RegExp(matcher).test(value);
  } catch {
    return false;
  }
}

const anyMatcher: HookRequirement["judge"] = () => "current";
const selecting =
  (value: string): HookRequirement["judge"] =>
  (matcher) =>
    matcherSelects(matcher, value) ? "current" : undefined;

const CLAUDE_REQUIREMENTS: readonly HookRequirement[] = [
  { event: "Stop", matcher: null, required: true, judge: anyMatcher },
  { event: "PreCompact", matcher: null, required: false, judge: anyMatcher },
  {
    event: "SessionStart",
    matcher: COMPACT_SESSION_START_MATCHER,
    required: false,
    judge: selecting(COMPACT_SESSION_START_MATCHER),
  },
  {
    event: "PreToolUse",
    matcher: CLAUDE_PRE_TOOL_USE_MATCHER,
    required: false,
    judge: selecting(CLAUDE_PRE_TOOL_USE_TOOL_NAME),
  },
];
const CODEX_REQUIREMENTS: readonly HookRequirement[] = [
  { event: "Stop", matcher: null, required: true, judge: anyMatcher },
  {
    event: "PostToolUse",
    matcher: CODEX_POST_TOOL_USE_MATCHER,
    required: true,
    judge: (matcher) =>
      matcher === CODEX_POST_TOOL_USE_MATCHER
        ? "current"
        : matcher === LEGACY_CODEX_POST_TOOL_USE_MATCHER
          ? "outdated"
          : undefined,
  },
  { event: "UserPromptSubmit", matcher: null, required: false, judge: anyMatcher },
  {
    event: "SessionStart",
    matcher: COMPACT_SESSION_START_MATCHER,
    required: false,
    judge: selecting(COMPACT_SESSION_START_MATCHER),
  },
  {
    event: "PreToolUse",
    matcher: CODEX_PRE_TOOL_USE_MATCHER,
    required: false,
    judge: selecting(CODEX_PRE_TOOL_USE_TOOL_NAME),
  },
];

function defaultIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function pathModule(platform: NodeJS.Platform | undefined): typeof posix {
  return (platform ?? process.platform) === "win32" ? win32 : posix;
}

// Collapses repeated separators, as JSON escapes doubled backslashes; a leading `//` (a UNC share) is kept.
function slashPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/(?!^)\/{2,}/g, "/");
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((part): part is string => typeof part === "string") : [];
}

// Bounded so a hostile config cannot make this expensive.
function collectHookCommands(value: unknown): Array<{ command: string; args: string[] }> {
  const stack: unknown[] = [value];
  const commands: Array<{ command: string; args: string[] }> = [];
  let inspected = 0;
  while (stack.length > 0 && inspected < MAX_INSPECTED_NODES) {
    const current = stack.pop();
    inspected += 1;
    if (Array.isArray(current)) stack.push(...current);
    else if (JSON_OBJECT(current)) {
      if (typeof current.command === "string")
        commands.push({ command: current.command, args: stringList(current.args) });
      stack.push(...Object.values(current));
    }
  }
  return commands;
}

export function classifyHookCommand(command: string, options: HookCommandOptions = {}): HookCommandClassification {
  const words = commandWords(command, options.platform ?? process.platform);
  if (!words) return { kind: "other" };
  const all = [...words, ...(options.args ?? [])];
  const [first, second] = all;
  if (first === undefined) return { kind: "other" };

  if (all.length === 2 && second !== undefined && KNOWN_HOOK_ACTIONS.has(second) && isLauncherShimCommand(first)) {
    return {
      kind: "launcher",
      action: second,
      scriptPath: first,
      current: options.shimPath === undefined || isLauncherShimCommand(first, options.shimPath),
    };
  }
  const scriptIndex = all.findIndex((word) => checkoutScriptName(word) !== undefined);
  const scriptPath = all[scriptIndex];
  if (scriptPath !== undefined && all.slice(0, scriptIndex).some(isNodeExecutable)) {
    const action = CHECKOUT_SCRIPT_ACTIONS.get(checkoutScriptName(scriptPath) ?? "");
    if (action !== undefined) return { kind: "checkout", action, scriptPath };
  }
  return { kind: "other" };
}

function checkoutScriptName(word: string): string | undefined {
  const normalized = slashPath(word);
  const basename = normalized.split("/").at(-1) ?? "";
  return CHECKOUT_SCRIPT_ACTIONS.has(basename) && normalized.endsWith(`${CHECKOUT_SCRIPT_DIRECTORY}${basename}`)
    ? basename
    : undefined;
}

function candidateFor(
  entry: { command: string; args: string[] },
  agent: HookAgent,
  context: HookInspectionContext,
  isFile: (path: string) => boolean,
): HookCandidate | undefined {
  const classified = classifyHookCommand(entry.command, {
    ...(context.platform ? { platform: context.platform } : {}),
    ...(context.shimPath ? { shimPath: context.shimPath } : {}),
    args: entry.args,
  });
  if (classified.action !== AGENT_ACTIONS[agent] || classified.scriptPath === undefined) return undefined;
  if (classified.kind === "launcher") {
    const usable = classified.current === true && (context.shimPath !== undefined || isFile(classified.scriptPath));
    return usable ? { state: "installed", source: "app" } : { state: "stale", source: null, reason: "shim-differs" };
  }
  return isFile(classified.scriptPath)
    ? { state: "installed", source: "checkout" }
    : { state: "stale", source: null, reason: "script-missing" };
}

function inspectEvent(
  hooks: Record<string, unknown> | undefined,
  requirement: HookRequirement,
  agent: HookAgent,
  context: HookInspectionContext,
  isFile: (path: string) => boolean,
): HookEventInspection | "malformed" {
  const entries: unknown = hooks?.[requirement.event];
  if (entries !== undefined && !Array.isArray(entries)) return "malformed";
  const candidates: HookCandidate[] = [];
  for (const entry of (entries ?? []) as unknown[]) {
    if (!JSON_OBJECT(entry)) continue;
    const verdict = requirement.judge(entry.matcher);
    if (verdict === undefined) continue;
    for (const command of collectHookCommands(entry.hooks)) {
      const candidate = candidateFor(command, agent, context, isFile);
      if (!candidate) continue;
      candidates.push(
        verdict === "outdated" ? { state: "stale", source: null, reason: "matcher-outdated" } : candidate,
      );
    }
  }
  const base = { event: requirement.event, matcher: requirement.matcher, required: requirement.required };
  const installed = candidates.filter((candidate) => candidate.state === "installed");
  const best = installed.find((candidate) => candidate.source === "app") ?? installed[0];
  if (best) return { ...base, state: "installed", source: best.source };
  const stale = candidates.find((candidate) => candidate.reason !== "matcher-outdated") ?? candidates[0];
  if (stale) return { ...base, state: "stale", source: null, ...(stale.reason ? { reason: stale.reason } : {}) };
  return { ...base, state: "missing", source: null };
}

function overallState(events: readonly HookEventInspection[]): HookInstallState {
  const required = events.filter((event) => event.required);
  if (required.some((event) => event.state === "missing")) return "missing";
  if (required.some((event) => event.state === "stale")) return "stale";
  return "installed";
}

function uniformInstallation(
  agent: HookAgent,
  requirements: readonly HookRequirement[],
  state: "unknown" | "disabled",
): HookInstallation {
  return {
    agent,
    state,
    source: null,
    events: requirements.map((requirement) => ({
      event: requirement.event,
      matcher: requirement.matcher,
      required: requirement.required,
      state,
      source: null,
    })),
  };
}

export function unknownHookInstallation(agent: HookAgent): HookInstallation {
  return uniformInstallation(agent, agent === "claude-code" ? CLAUDE_REQUIREMENTS : CODEX_REQUIREMENTS, "unknown");
}

// A checkout entry that works is installed, not stale. `config`: undefined is a missing file, an object the parsed
// JSON, anything else `unknown`.
export function inspectHookInstallation(
  config: unknown,
  agent: HookAgent,
  context: HookInspectionContext = {},
): HookInstallation {
  const requirements = agent === "claude-code" ? CLAUDE_REQUIREMENTS : CODEX_REQUIREMENTS;
  if (context.hooksDisabled === true) return uniformInstallation(agent, requirements, "disabled");
  if (config !== undefined && !JSON_OBJECT(config)) return uniformInstallation(agent, requirements, "unknown");
  const root = config;
  const hooks: unknown = root?.hooks;
  if (hooks !== undefined && !JSON_OBJECT(hooks)) return uniformInstallation(agent, requirements, "unknown");
  const disabled = context.hooksDisabled ?? (agent === "claude-code" && root?.disableAllHooks === true);
  if (disabled) return uniformInstallation(agent, requirements, "disabled");

  const isFile = context.isFile ?? defaultIsFile;
  const pluginEnabled = context.pluginEnabled ?? (agent === "claude-code" && claudePluginEnabled(root));
  const events: HookEventInspection[] = [];
  for (const requirement of requirements) {
    const inspected = inspectEvent(hooks, requirement, agent, context, isFile);
    if (inspected === "malformed") return uniformInstallation(agent, requirements, "unknown");
    events.push(
      pluginEnabled && inspected.state !== "installed"
        ? {
            event: inspected.event,
            matcher: inspected.matcher,
            required: inspected.required,
            state: "installed",
            source: "plugin",
          }
        : inspected,
    );
  }
  const state = overallState(events);
  return {
    agent,
    state,
    source: state === "installed" ? (events.find((event) => event.required)?.source ?? null) : null,
    events,
  };
}

const NODE_FLAGS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "-C",
  "--conditions",
  "--input-type",
]);

function nodeScriptArgument(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) return undefined;
    if (!argument.startsWith("-")) return argument;
    if (NODE_FLAGS_WITH_VALUE.has(argument)) index += 1;
  }
  return undefined;
}

function pnpmDirectory(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--dir" || argument === "-C") return args[index + 1];
    if (argument?.startsWith("--dir=")) return argument.slice("--dir=".length);
  }
  return undefined;
}

export function classifyMcpRegistration(
  value: unknown,
  context: McpRegistrationContext = {},
): McpRegistrationClassification {
  const other: McpRegistrationClassification = { kind: "other", source: null };
  if (!JSON_OBJECT(value) || typeof value.command !== "string") return other;
  const isFile = context.isFile ?? defaultIsFile;
  const path = pathModule(context.platform);
  const cwd = typeof value.cwd === "string" && value.cwd !== "" ? value.cwd : undefined;
  const { command, args } = unwrapCmd(value.command, stringList(value.args));
  if (isLauncherMcpRegistration({ command, args })) {
    return isFile(command) ? { kind: "launcher", source: "app" } : other;
  }
  if (isNodeExecutable(command)) {
    const script = nodeScriptArgument(args);
    if (script === undefined) return other;
    const resolved = cwd !== undefined && !path.isAbsolute(script) ? path.resolve(cwd, script) : script;
    const normalized = normalizeConfigPath(resolved);
    if (normalized.endsWith(`/${MCP_SERVER_RELATIVE_PATH}`)) {
      return isFile(resolved) ? { kind: "direct", source: null } : other;
    }
    if (normalized.endsWith(`/${MCP_LAUNCHER_RELATIVE_PATH}`) && isFile(resolved)) {
      return { kind: "checkout", source: "checkout" };
    }
    return other;
  }
  if (!isPnpmExecutable(command) || !args.includes("start:mcp")) return other;
  const directory = pnpmDirectory(args) ?? cwd;
  if (directory === undefined) return other;
  const root = cwd !== undefined && !path.isAbsolute(directory) ? path.resolve(cwd, directory) : directory;
  return isFile(path.join(root, MCP_LAUNCHER_RELATIVE_PATH)) ? { kind: "checkout", source: "checkout" } : other;
}
