import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { commandWords, isLauncherMcpRegistration, isLauncherShimCommand } from "./commands.js";
import { CLAUDE_HOOK_ACTION, CODEX_HOOK_ACTION } from "./constants.js";
import { JSON_OBJECT, readRegularFile } from "./files.js";
import { normalizePlanOptions, targetPath } from "./paths.js";
import { claudePluginEnabled, codexPluginEnabled } from "./plugins.js";
import { codexWorkIntelligenceServer } from "./toml.js";
import type { AgentSetupPlanOptions } from "./types.js";

export type AgentId = "codex" | "claude-code" | "claude-desktop";

/**
 * Who owns a registration: the desktop App (`desktop-managed`, runs the fixed launcher shim), a person or
 * `pnpm setup:agents` (`manual`), the Work Intelligence plugin of that Agent (`plugin`), a Claude Desktop extension
 * bundle (`mcpb`), or an entry that exists but cannot be classified (`unknown`).
 */
export type RegistrationSource = "desktop-managed" | "manual" | "plugin" | "mcpb" | "unknown";

export type RegistrationKind = "mcp" | "hook";

export interface AgentRegistration {
  agent: AgentId;
  kind: RegistrationKind;
  source: RegistrationSource;
  /** The file the registration was found in (the Agent's config, never its contents). */
  location: string;
}

/** The same Agent and kind registered by more than one source, so its tools or hooks would run twice. */
export interface AgentRegistrationDuplicate {
  code: "duplicate-registration";
  agent: AgentId;
  kind: RegistrationKind;
  sources: RegistrationSource[];
}

export interface AgentRegistrationInspection {
  registrations: AgentRegistration[];
  duplicates: AgentRegistrationDuplicate[];
  /** Config files that exist but could not be read as the expected format, so nothing is claimed about them. */
  unreadable: string[];
}

export interface AgentInspectOptions extends AgentSetupPlanOptions {
  /** Claude Desktop's config directory; defaults to the per-platform location under the home directory. */
  claudeDesktopConfigDirectory?: string;
}

const SERVER_NAME = "work-intelligence";
const FINALIZE_REMINDER_MARKER = "finalize-reminder";
const HOOK_ACTIONS: ReadonlySet<string> = new Set([CLAUDE_HOOK_ACTION, CODEX_HOOK_ACTION]);

function claudeDesktopDirectory(options: AgentInspectOptions): string {
  if (options.claudeDesktopConfigDirectory) return options.claudeDesktopConfigDirectory;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return join(options.homeDirectory, "AppData", "Roaming", "Claude");
  if (platform === "darwin") return join(options.homeDirectory, "Library", "Application Support", "Claude");
  return join(options.homeDirectory, ".config", "Claude");
}

function classifyMcpEntry(value: unknown): RegistrationSource {
  if (isLauncherMcpRegistration(value)) return "desktop-managed";
  return JSON_OBJECT(value) && typeof value.command === "string" ? "manual" : "unknown";
}

/** The `finalize-reminder` commands in a hooks config, as the sources that wrote them. */
function hookSources(root: Record<string, unknown> | undefined): Set<RegistrationSource> {
  const sources = new Set<RegistrationSource>();
  const hooks = root?.hooks;
  if (!JSON_OBJECT(hooks)) return sources;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!JSON_OBJECT(value)) return;
    if (typeof value.command === "string" && value.command.includes(FINALIZE_REMINDER_MARKER)) {
      const words = commandWords(value.command);
      sources.add(
        words?.[0] && isLauncherShimCommand(words[0]) && HOOK_ACTIONS.has(words[1] ?? "")
          ? "desktop-managed"
          : "manual",
      );
    }
    Object.values(value).forEach(visit);
  };
  Object.values(hooks).forEach(visit);
  return sources;
}

function findDuplicates(registrations: AgentRegistration[]): AgentRegistrationDuplicate[] {
  const grouped = new Map<string, { agent: AgentId; kind: RegistrationKind; sources: Set<RegistrationSource> }>();
  for (const { agent, kind, source } of registrations) {
    const key = `${agent}:${kind}`;
    const group = grouped.get(key) ?? { agent, kind, sources: new Set<RegistrationSource>() };
    group.sources.add(source);
    grouped.set(key, group);
  }
  return [...grouped.values()]
    .filter((group) => group.sources.size > 1)
    .map((group) => ({
      code: "duplicate-registration",
      agent: group.agent,
      kind: group.kind,
      sources: [...group.sources].sort(),
    }));
}

/**
 * Read-only: which registrations of the Work Intelligence MCP server and finalize hooks exist per Agent and where
 * they come from, and which Agent registers the same thing twice. Files that are missing are simply not listed;
 * files that exist but do not parse are reported in `unreadable`. Claude Desktop is best effort: its manual stdio
 * entry in `claude_desktop_config.json` and an installed extension in `extensions-installations.json`.
 */
export function inspectAgentRegistrations(options: AgentInspectOptions): AgentRegistrationInspection {
  const normalized = normalizePlanOptions(options);
  const registrations: AgentRegistration[] = [];
  const unreadable: string[] = [];
  const add = (agent: AgentId, kind: RegistrationKind, source: RegistrationSource, location: string): void => {
    registrations.push({ agent, kind, source, location });
  };
  const readJsonObject = (path: string): Record<string, unknown> | undefined => {
    const file = readRegularFile(path);
    if (file.conflict) unreadable.push(path);
    if (!file.bytes) return undefined;
    try {
      const value: unknown = JSON.parse(file.bytes.toString("utf8"));
      if (JSON_OBJECT(value)) return value;
    } catch {
      // Reported below with the other unparseable files.
    }
    unreadable.push(path);
    return undefined;
  };
  const addHooks = (agent: AgentId, path: string, root: Record<string, unknown> | undefined): void => {
    for (const source of hookSources(root)) add(agent, "hook", source, path);
  };

  const codexConfigPath = targetPath("codexMcp", normalized);
  const codexConfig = readRegularFile(codexConfigPath);
  if (codexConfig.conflict) unreadable.push(codexConfigPath);
  if (codexConfig.bytes) {
    try {
      const text = codexConfig.bytes.toString("utf8");
      const config = parseToml(text, { maxDepth: 128, unsafeKeyBehaviour: "throw" });
      if (codexPluginEnabled(config)) {
        add("codex", "mcp", "plugin", codexConfigPath);
        add("codex", "hook", "plugin", codexConfigPath);
      }
      const server = codexWorkIntelligenceServer(text);
      if (server !== undefined) add("codex", "mcp", classifyMcpEntry(server), codexConfigPath);
    } catch {
      unreadable.push(codexConfigPath);
    }
  }
  const codexHooksPath = targetPath("codexStopHook", normalized);
  addHooks("codex", codexHooksPath, readJsonObject(codexHooksPath));

  const claudeJsonPath = targetPath("claudeMcp", normalized);
  const claudeServers = readJsonObject(claudeJsonPath)?.mcpServers;
  if (JSON_OBJECT(claudeServers) && claudeServers[SERVER_NAME] !== undefined) {
    add("claude-code", "mcp", classifyMcpEntry(claudeServers[SERVER_NAME]), claudeJsonPath);
  }
  const claudeSettingsPath = targetPath("claudeStopHook", normalized);
  const claudeSettings = readJsonObject(claudeSettingsPath);
  if (claudePluginEnabled(claudeSettings)) {
    add("claude-code", "mcp", "plugin", claudeSettingsPath);
    add("claude-code", "hook", "plugin", claudeSettingsPath);
  }
  addHooks("claude-code", claudeSettingsPath, claudeSettings);

  const desktopDirectory = claudeDesktopDirectory(options);
  const desktopConfigPath = join(desktopDirectory, "claude_desktop_config.json");
  const desktopServers = readJsonObject(desktopConfigPath)?.mcpServers;
  if (JSON_OBJECT(desktopServers) && desktopServers[SERVER_NAME] !== undefined) {
    add("claude-desktop", "mcp", classifyMcpEntry(desktopServers[SERVER_NAME]), desktopConfigPath);
  }
  const extensionsPath = join(desktopDirectory, "extensions-installations.json");
  const extensions = readJsonObject(extensionsPath)?.extensions;
  if (JSON_OBJECT(extensions) && Object.keys(extensions).some((id) => id.includes(SERVER_NAME))) {
    add("claude-desktop", "mcp", "mcpb", extensionsPath);
  }

  return { registrations, duplicates: findDuplicates(registrations), unreadable };
}
