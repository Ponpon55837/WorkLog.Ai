import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { getMcpRuntimeStatus } from "@work-intelligence/shared/mcp-runtime";
import type { AgentMcpRegistrationState, SystemAgentConnections, UserServiceStatus } from "@work-intelligence/core";
import { DEFAULT_SERVER_PORT } from "./server-port.js";
import { getUserServiceStatus } from "./user-service.js";
import {
  findLatestAutomaticBackup,
  inspectDatabaseReadOnlyMetadata,
  resolveBackupDirectory,
  type ReadOnlyDatabaseInspection,
} from "./database-inspection.js";
import {
  CODEX_POST_TOOL_USE_MATCHER,
  inspectAgentSkillCopies,
  LEGACY_CODEX_POST_TOOL_USE_MATCHER,
  type AgentSetupFinding,
  type CodexHooksFeature,
} from "./agent-setup.js";

const ROOT_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PACKAGE_MANAGER_SCHEMA = z.string().regex(/^pnpm@\d+\.\d+\.\d+(?:\+.*)?$/);
const ROOT_PACKAGE_SCHEMA = z.object({
  packageManager: PACKAGE_MANAGER_SCHEMA.optional(),
  engines: z.object({ pnpm: z.string().trim().min(1).optional() }).optional(),
});
const ENVIRONMENT_SCHEMA = z.object({
  WORK_INTELLIGENCE_DB: z.string().trim().min(1).optional(),
  WORK_INTELLIGENCE_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  WORK_INTELLIGENCE_BACKUP_DIR: z.string().trim().min(1).optional(),
});
const JSON_OBJECT_SCHEMA = z.record(z.string(), z.unknown());
const HEALTH_SCHEMA = z
  .object({
    ok: z.boolean(),
    app: z.literal("Work Intelligence"),
    version: z.string().optional(),
    schemaVersion: z.number().int().nonnegative().optional(),
    database: z.enum(["connected", "unavailable"]).optional(),
  })
  .passthrough();
const REQUIRED_DIST_FILES = [
  "apps/server/dist/index.js",
  "apps/server/dist/cli.js",
  "apps/server/dist/doctor.js",
  "apps/server/dist/server-port.js",
  "apps/mcp/dist/index.js",
  "apps/mcp/dist/finalize-reminder.js",
  "apps/mcp/dist/codex-finalize-reminder.js",
  "apps/web/dist/index.html",
  "packages/core/dist/index.js",
  "packages/project-policy/dist/index.js",
  "packages/schema/dist/index.js",
  "packages/shared/dist/index.js",
  "packages/storage/dist/index.js",
] as const;
const BUILD_SOURCE_DIRECTORIES = [
  "apps/server/src",
  "apps/mcp/src",
  "packages/core/src",
  "packages/project-policy/src",
  "packages/schema/src",
  "packages/shared/src",
  "packages/storage/src",
] as const;

export interface DoctorFinding {
  severity: "ok" | "warning" | "error";
  title: string;
  detail: string;
  recommendation?: string;
}

export type { ReadOnlyDatabaseInspection } from "./database-inspection.js";

export interface GlobalHookInspection {
  claudeConfigured: boolean;
  codexConfigured: boolean;
  /** Installed with the pre-dispatcher PostToolUse matcher; reported as stale rather than missing. */
  codexLegacyMatcher: boolean;
  /** Optional UserPromptSubmit hook that lets the Codex reminder state when the segment began. */
  codexSegmentStartConfigured: boolean;
  codexHooksFeature: CodexHooksFeature;
}

type AgentConfigReadState = "readable" | "missing" | "unreadable";

interface AgentJsonConfigInspection {
  state: AgentConfigReadState;
  config?: Record<string, unknown>;
}

interface CodexTomlConfigInspection {
  state: AgentConfigReadState;
  config?: ReturnType<typeof parseToml>;
}

interface AgentConnectionInspection {
  connections: SystemAgentConnections;
  claudeMcp: AgentMcpRegistrationState;
  codexMcp: AgentMcpRegistrationState;
  skillFindings: AgentSetupFinding[];
  globalHooks: GlobalHookInspection;
  claudeHookExists: boolean;
  codexHookExists: boolean;
  /** The Work Intelligence Claude Code plugin is enabled in the user's settings.json. */
  claudePluginEnabled: boolean;
  /** The Work Intelligence Codex plugin is enabled in config.toml. */
  codexPluginEnabled: boolean;
}

interface AgentConnectionInspectionOptions {
  homeDirectory?: string;
  repositoryRoot?: string;
  environment?: NodeJS.ProcessEnv;
}

function addFinding(
  findings: DoctorFinding[],
  severity: DoctorFinding["severity"],
  title: string,
  detail: string,
  recommendation?: string,
): void {
  findings.push({ severity, title, detail, recommendation });
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function inspectJsonConfigFile(path: string): AgentJsonConfigInspection {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const result = JSON_OBJECT_SCHEMA.safeParse(parsed);
    return result.success ? { state: "readable", config: result.data } : { state: "unreadable" };
  } catch (error) {
    return errorCode(error) === "ENOENT" ? { state: "missing" } : { state: "unreadable" };
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  const result = JSON_OBJECT_SCHEMA.safeParse(value);
  return result.success ? result.data : undefined;
}

function inspectCodexTomlConfig(codexHomeDirectory: string): CodexTomlConfigInspection {
  try {
    const configText = readFileSync(join(codexHomeDirectory, "config.toml"), "utf8");
    const config = parseToml(configText, { maxDepth: 128, unsafeKeyBehaviour: "throw" });
    return { state: "readable", config };
  } catch (error) {
    return errorCode(error) === "ENOENT" ? { state: "missing" } : { state: "unreadable" };
  }
}

function codexHooksFeatureFromConfig(inspection: CodexTomlConfigInspection): CodexHooksFeature {
  if (inspection.state === "unreadable") return "unknown";
  if (inspection.state === "missing") return "enabled";
  const featuresValue = inspection.config?.features;
  if (featuresValue === undefined) return "enabled";
  const features = record(featuresValue);
  if (!features) return "unknown";
  const configuredValues = [features.hooks, features.codex_hooks].filter((value) => value !== undefined);
  if (configuredValues.some((value) => typeof value !== "boolean")) return "unknown";
  return configuredValues.includes(false) ? "disabled" : "enabled";
}

function inspectCodexMcpState(inspection: CodexTomlConfigInspection): AgentMcpRegistrationState {
  if (inspection.state === "unreadable") return "unknown";
  if (inspection.state === "missing") return "missing";
  const mcpServersValue = inspection.config?.mcp_servers;
  if (mcpServersValue === undefined) return "missing";
  const mcpServers = record(mcpServersValue);
  if (!mcpServers) return "unknown";
  const workIntelligenceServer = mcpServers["work-intelligence"];
  if (workIntelligenceServer === undefined) return "missing";
  return record(workIntelligenceServer) ? "registered" : "unknown";
}

function entries(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function collectCommands(value: unknown): string[] {
  const stack: unknown[] = [value];
  const visited = new Set<object>();
  const commands: string[] = [];
  let inspected = 0;

  while (stack.length > 0 && inspected < 500) {
    const current = stack.pop();
    inspected += 1;
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    const currentRecord = record(current);
    if (!currentRecord || visited.has(current as object)) {
      continue;
    }
    visited.add(current as object);
    if (typeof currentRecord.command === "string") {
      commands.push(currentRecord.command);
      // Claude Code also accepts the exec form: `command` is the runtime and the script path sits in `args`.
      commands.push(...entries(currentRecord.args).filter((arg): arg is string => typeof arg === "string"));
    }
    stack.push(...Object.values(currentRecord));
  }
  return commands;
}

function normalizeConfigPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function commandPointsTo(command: string, scriptPath: string): boolean {
  const normalizedCommand = normalizeConfigPath(command.trim()).replace(/["']+$/g, "");
  const normalizedPath = normalizeConfigPath(scriptPath);
  if (!normalizedCommand.endsWith(normalizedPath)) {
    if (process.platform === "win32") return false;
    return parsePosixShellWords(command).some((part) => normalizeConfigPath(part) === normalizedPath);
  }
  const prefix = normalizedCommand.slice(0, -normalizedPath.length);
  if (prefix.length === 0 || /\s$/.test(prefix) || /["']$/.test(prefix)) return true;
  if (process.platform === "win32") return false;
  return parsePosixShellWords(command).some((part) => normalizeConfigPath(part) === normalizedPath);
}

function parsePosixShellWords(command: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;
  let hasWord = false;
  for (const char of command) {
    if (escaping) {
      word += char;
      hasWord = true;
      escaping = false;
    } else if (quote === "'") {
      if (char === "'") quote = undefined;
      else word += char;
      hasWord = true;
    } else if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (char === "\\") escaping = true;
      else word += char;
      hasWord = true;
    } else if (char === "'") {
      quote = "'";
      hasWord = true;
    } else if (char === '"') {
      quote = '"';
      hasWord = true;
    } else if (char === "\\") {
      escaping = true;
    } else if (/\s/.test(char)) {
      if (hasWord) words.push(word);
      word = "";
      hasWord = false;
    } else {
      word += char;
      hasWord = true;
    }
  }
  if (escaping) word += "\\";
  if (hasWord) words.push(word);
  return words;
}

function hasClaudeStopHook(config: Record<string, unknown> | undefined, scriptPath: string): boolean {
  const hooks = record(config?.hooks);
  return collectCommands(entries(hooks?.Stop)).some((command) => commandPointsTo(command, scriptPath));
}

/**
 * `legacy` means the Stop hook and a PostToolUse hook exist, but the PostToolUse matcher predates the MCP
 * dispatchers and misses `work_write_idempotent` finalize calls; re-running setup upgrades it.
 */
function codexGlobalHookState(
  config: Record<string, unknown> | undefined,
  scriptPath: string,
): "current" | "legacy" | "missing" {
  const hooks = record(config?.hooks);
  const matchersPointingToScript = entries(hooks?.PostToolUse)
    .map((entry) => record(entry))
    .filter((hookEntry) => collectCommands(hookEntry?.hooks).some((command) => commandPointsTo(command, scriptPath)))
    .map((hookEntry) => hookEntry?.matcher);
  const stopMatches = collectCommands(entries(hooks?.Stop)).some((command) => commandPointsTo(command, scriptPath));
  if (!stopMatches) return "missing";
  if (matchersPointingToScript.includes(CODEX_POST_TOOL_USE_MATCHER)) return "current";
  return matchersPointingToScript.includes(LEGACY_CODEX_POST_TOOL_USE_MATCHER) ? "legacy" : "missing";
}

/** Inspects only the global Claude and Codex hook configuration files. */
function inspectGlobalHookConfigs(
  homeDirectory: string,
  repositoryRoot: string,
  codexHomeDirectory: string,
  claudeConfigDirectory: string,
  codexHooksFeature: CodexHooksFeature,
): {
  inspection: GlobalHookInspection;
  claudeSettingsState: AgentConfigReadState;
  codexHooksState: AgentConfigReadState;
} {
  const claudeScript = resolve(repositoryRoot, "apps/mcp/dist/finalize-reminder.js");
  const codexScript = resolve(repositoryRoot, "apps/mcp/dist/codex-finalize-reminder.js");
  const claudeSettingsFile = inspectJsonConfigFile(join(claudeConfigDirectory, "settings.json"));
  const codexSettingsFile = inspectJsonConfigFile(join(codexHomeDirectory, "hooks.json"));
  const claudeSettings = claudeSettingsFile.config;
  const codexSettings = codexSettingsFile.config;
  const codexHookState = codexGlobalHookState(codexSettings, codexScript);
  return {
    inspection: {
      claudeConfigured: hasClaudeStopHook(claudeSettings, claudeScript),
      codexConfigured: codexHookState === "current",
      codexLegacyMatcher: codexHookState === "legacy",
      codexSegmentStartConfigured: collectCommands(entries(record(codexSettings?.hooks)?.UserPromptSubmit)).some(
        (command) => commandPointsTo(command, codexScript),
      ),
      codexHooksFeature,
    },
    claudeSettingsState: claudeSettingsFile.state,
    codexHooksState: codexSettingsFile.state,
  };
}

/** Inspects only the global Claude and Codex hook configuration files. */
export function inspectGlobalHooks(
  homeDirectory: string,
  repositoryRoot: string,
  codexHomeDirectory = join(homeDirectory, ".codex"),
  claudeConfigDirectory = join(homeDirectory, ".claude"),
): GlobalHookInspection {
  const codexConfig = inspectCodexTomlConfig(codexHomeDirectory);
  const codexHooksFeature = codexHooksFeatureFromConfig(codexConfig);
  return inspectGlobalHookConfigs(
    homeDirectory,
    repositoryRoot,
    codexHomeDirectory,
    claudeConfigDirectory,
    codexHooksFeature,
  ).inspection;
}

/**
 * Whether settings.json enables the Work Intelligence plugin (`enabledPlugins["work-intelligence@<marketplace>"]`).
 * The plugin brings its own MCP server, skill, and Stop hook, so it replaces the manual registration.
 */
export function claudePluginEnabled(settings: Record<string, unknown> | undefined): boolean {
  const enabled = record(settings?.enabledPlugins);
  return Object.entries(enabled ?? {}).some(([key, value]) => key.startsWith("work-intelligence@") && value === true);
}

/**
 * Whether config.toml enables the Work Intelligence plugin (`[plugins."work-intelligence@<marketplace>"]` with
 * `enabled = true`). It brings the MCP server and the skill; the Codex save-reminder hooks stay in hooks.json.
 */
export function codexPluginEnabled(config: Record<string, unknown> | undefined): boolean {
  return Object.entries(record(config?.plugins) ?? {}).some(
    ([key, value]) => key.startsWith("work-intelligence@") && record(value)?.enabled === true,
  );
}

function inspectClaudeMcpState(homeDirectory: string): AgentMcpRegistrationState {
  const file = inspectJsonConfigFile(join(homeDirectory, ".claude.json"));
  if (file.state === "unreadable") return "unknown";
  if (file.state === "missing") return "missing";
  return record(record(file.config?.mcpServers)?.["work-intelligence"]) ? "registered" : "missing";
}

/** Reuses Doctor's read-only checks for the System Status API and onboarding checklist. */
function inspectAgentConnectionDetails(options: AgentConnectionInspectionOptions = {}): AgentConnectionInspection {
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? environment.HOME ?? environment.USERPROFILE ?? "";
  const repositoryRoot = options.repositoryRoot ?? ROOT_DIRECTORY;
  const codexHomeDirectory = resolve(environment.CODEX_HOME?.trim() || join(homeDirectory, ".codex"));
  const claudeConfigDirectory = resolve(environment.CLAUDE_CONFIG_DIR?.trim() || join(homeDirectory, ".claude"));
  const claudeMcp = inspectClaudeMcpState(homeDirectory);
  const codexConfig = inspectCodexTomlConfig(codexHomeDirectory);
  const codexHooksFeature = codexHooksFeatureFromConfig(codexConfig);
  const globalHookConfigs = inspectGlobalHookConfigs(
    homeDirectory,
    repositoryRoot,
    codexHomeDirectory,
    claudeConfigDirectory,
    codexHooksFeature,
  );
  const globalHooks = globalHookConfigs.inspection;
  const codexMcp = inspectCodexMcpState(codexConfig);
  const codexPlugin = codexPluginEnabled(codexConfig.config);
  const skillFindings = inspectAgentSkillCopies(
    homeDirectory,
    repositoryRoot,
    codexHomeDirectory,
    claudeConfigDirectory,
  );
  const claudePlugin = claudePluginEnabled(inspectJsonConfigFile(join(claudeConfigDirectory, "settings.json")).config);
  const claudeHookExists = existsSync(resolve(repositoryRoot, "apps/mcp/dist/finalize-reminder.js"));
  const codexHookExists = existsSync(resolve(repositoryRoot, "apps/mcp/dist/codex-finalize-reminder.js"));
  const skillState = (
    componentId: AgentSetupFinding["componentId"],
  ): SystemAgentConnections["codex"]["canonicalSkill"] =>
    skillFindings.find((finding) => finding.componentId === componentId)?.state ?? "unreadable";
  const claudeHook = !claudeHookExists
    ? "missing"
    : globalHookConfigs.claudeSettingsState === "unreadable"
      ? "unknown"
      : globalHooks.claudeConfigured
        ? "installed"
        : "missing";
  const codexHook = !codexHookExists
    ? "missing"
    : globalHooks.codexHooksFeature === "disabled"
      ? "disabled"
      : globalHooks.codexHooksFeature === "unknown"
        ? "unknown"
        : globalHookConfigs.codexHooksState === "unreadable"
          ? "unknown"
          : globalHooks.codexConfigured
            ? "installed"
            : globalHooks.codexLegacyMatcher
              ? "stale"
              : "missing";

  return {
    connections: {
      codex: {
        mcpRegistered: codexMcp,
        canonicalSkill: skillState("codexSkill"),
        legacySkill: skillState("codexLegacySkill"),
        hook: codexHook,
      },
      claudeCode: {
        mcpRegistered: claudeMcp,
        skill: skillState("claudeSkill"),
        hook: claudeHook,
      },
    },
    claudeMcp,
    codexMcp,
    skillFindings,
    globalHooks,
    claudeHookExists,
    codexHookExists,
    claudePluginEnabled: claudePlugin,
    codexPluginEnabled: codexPlugin,
  };
}

/** Read-only snapshot of Agent MCP registration, skill copies, and configured hooks. */
export function inspectAgentConnections(options: AgentConnectionInspectionOptions = {}): SystemAgentConnections {
  return inspectAgentConnectionDetails(options).connections;
}

/** Opens an existing database strictly read-only and queries metadata only. */
export async function inspectDatabaseReadOnly(databasePath: string): Promise<ReadOnlyDatabaseInspection> {
  return inspectDatabaseReadOnlyMetadata(databasePath, { checkIntegrity: true });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return bytes + " B";
  }
  if (bytes < 1024 * 1024) {
    return (bytes / 1024).toFixed(1) + " KiB";
  }
  return (bytes / (1024 * 1024)).toFixed(1) + " MiB";
}

function expectedDistFiles(repositoryRoot: string): string[] {
  const expected = new Set<string>(REQUIRED_DIST_FILES);
  for (const sourceDirectory of BUILD_SOURCE_DIRECTORIES) {
    const sourcePath = resolve(repositoryRoot, sourceDirectory);
    const visit = (currentDirectory: string): void => {
      let children;
      try {
        children = readdirSync(currentDirectory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const child of children) {
        const childPath = join(currentDirectory, child.name);
        if (child.isDirectory()) {
          visit(childPath);
        } else if (child.isFile() && child.name.endsWith(".ts") && !child.name.endsWith(".test.ts")) {
          expected.add(
            join(sourceDirectory.replace(/\/src$/, "/dist"), relative(sourcePath, childPath).replace(/\.ts$/, ".js")),
          );
        }
      }
    };
    visit(sourcePath);
  }

  try {
    const webAssets = readdirSync(resolve(repositoryRoot, "apps/web/dist/assets"));
    if (!webAssets.some((fileName) => fileName.endsWith(".js"))) {
      expected.add("apps/web/dist/assets/*.js");
    }
    if (!webAssets.some((fileName) => fileName.endsWith(".css"))) {
      expected.add("apps/web/dist/assets/*.css");
    }
  } catch {
    expected.add("apps/web/dist/assets");
  }
  return [...expected];
}

function portIsAvailable(port: number): Promise<boolean> {
  return new Promise((resolveResult) => {
    const server = createServer();
    server.once("error", () => resolveResult(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolveResult(true));
    });
  });
}

async function checkApi(port: number): Promise<"healthy" | "occupied" | "offline"> {
  try {
    const response = await fetch("http://127.0.0.1:" + port + "/api/health", {
      signal: AbortSignal.timeout(2500),
    });
    const parsed = HEALTH_SCHEMA.safeParse(await response.json());
    if (response.ok && parsed.success && parsed.data.ok && parsed.data.database !== "unavailable") {
      return "healthy";
    }
  } catch {
    // A stopped server and an unexpected response are reported with the same safe guidance.
  }
  return (await portIsAvailable(port)) ? "offline" : "occupied";
}

function readPackageManagerVersion(): { required: string; installed?: string } {
  let required = "未知";
  try {
    const rootPackage: unknown = JSON.parse(readFileSync(join(ROOT_DIRECTORY, "package.json"), "utf8"));
    const parsed = ROOT_PACKAGE_SCHEMA.safeParse(rootPackage);
    if (parsed.success) {
      // packageManager pins one version; engines.pnpm (what this repository declares) gives a range such as ">=11.16.0".
      required = parsed.data.packageManager?.slice("pnpm@".length).split("+")[0] ?? parsed.data.engines?.pnpm ?? "未知";
    }
  } catch {
    // Report an unknown requirement without exposing the file contents.
  }

  const userAgent = process.env.npm_config_user_agent ?? "";
  const detected = /^pnpm\/(\d+\.\d+\.\d+)/.exec(userAgent)?.[1];
  if (detected) {
    return { required, installed: detected };
  }
  try {
    const output = execFileSync("pnpm", ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      shell: process.platform === "win32",
    }).trim();
    const parsed = z
      .string()
      .regex(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/)
      .safeParse(output);
    return { required, installed: parsed.success ? parsed.data : undefined };
  } catch {
    return { required, installed: undefined };
  }
}

function versionParts(version: string): number[] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return match ? match.slice(1, 4).map(Number) : undefined;
}

/** True when the installed pnpm meets the requirement: an exact version, or a ">=x.y.z" minimum. */
export function pnpmRequirementSatisfied(installed: string | undefined, required: string): boolean {
  if (!installed) return false;
  const minimum = /^>=\s*(\S+)$/.exec(required.trim())?.[1];
  if (!minimum) return installed === required;
  const have = versionParts(installed);
  const need = versionParts(minimum);
  if (!have || !need) return false;
  for (let index = 0; index < 3; index += 1) {
    if (have[index]! !== need[index]!) return have[index]! > need[index]!;
  }
  return true;
}

function nodeSupportsSqlite(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) {
    return false;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 5);
}

function envFailure(): DoctorFinding {
  return {
    severity: "error",
    title: "環境設定",
    detail: "WORK_INTELLIGENCE_DB、WORK_INTELLIGENCE_PORT 或 WORK_INTELLIGENCE_BACKUP_DIR 格式無效。",
    recommendation: "請確認資料庫路徑非空，並讓 port 為 1 到 65535 的整數。",
  };
}

export async function collectDoctorFindings(
  options: {
    homeDirectory?: string;
    repositoryRoot?: string;
    environment?: NodeJS.ProcessEnv;
    userServiceStatus?: UserServiceStatus;
  } = {},
): Promise<DoctorFinding[]> {
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? environment.HOME ?? environment.USERPROFILE ?? "";
  const repositoryRoot = options.repositoryRoot ?? ROOT_DIRECTORY;
  const parsedEnvironment = ENVIRONMENT_SCHEMA.safeParse(environment);
  const findings: DoctorFinding[] = [];

  const sqliteAvailable = await import("node:sqlite").then(() => true).catch(() => false);
  const nodeVersion = process.versions.node;
  const nodeSupported = nodeSupportsSqlite(nodeVersion) && sqliteAvailable;
  addFinding(
    findings,
    nodeSupported ? "ok" : "error",
    "Node.js",
    "目前版本 " +
      nodeVersion +
      "，node:sqlite " +
      (sqliteAvailable ? "可用" : "無法使用") +
      "；最低需求為 Node.js 22.5。",
    nodeSupported ? undefined : "請使用支援 node:sqlite 的 Node.js 22.5 以上版本。",
  );

  const packageManager = readPackageManagerVersion();
  const pnpmMatches = pnpmRequirementSatisfied(packageManager.installed, packageManager.required);
  addFinding(
    findings,
    pnpmMatches ? "ok" : "warning",
    "pnpm",
    packageManager.installed
      ? "目前版本 " + packageManager.installed + "；專案要求 " + packageManager.required + "。"
      : "無法取得 pnpm 版本；專案要求 " + packageManager.required + "。",
    pnpmMatches ? undefined : "使用符合 package.json 要求的 pnpm 版本執行 pnpm install 與 pnpm run doctor。",
  );

  const missingDist = expectedDistFiles(repositoryRoot).filter(
    (path) => path.includes("*") || !existsSync(resolve(repositoryRoot, path)),
  );
  const missingDistSummary =
    missingDist.slice(0, 8).join("、") + (missingDist.length > 8 ? " 等，共 " + missingDist.length + " 項" : "");
  addFinding(
    findings,
    missingDist.length === 0 ? "ok" : "warning",
    "Build 檔案",
    missingDist.length === 0
      ? "server、MCP、Web 與 workspace 的必要 dist 檔案都完整。"
      : "缺少必要 dist 檔案：" + missingDistSummary + "。",
    missingDist.length === 0 ? undefined : "在專案根目錄執行 pnpm build。",
  );

  const mcpRuntime = getMcpRuntimeStatus(repositoryRoot);
  const mcpRuntimeHealthy =
    mcpRuntime.monitoringAvailable &&
    mcpRuntime.activeProcesses > 0 &&
    !mcpRuntime.restartRequired &&
    !mcpRuntime.updateAvailable;
  const mcpRuntimeDetail =
    mcpRuntime.updateAvailable && !mcpRuntime.restartRequired
      ? `${mcpRuntime.updateAvailableProcesses} 個 MCP 連線有新版可用，仍可照常讀寫。`
      : mcpRuntime.restartRequired
        ? `${mcpRuntime.activeProcesses} 個可監測 MCP 連線中，${mcpRuntime.outdatedProcesses} 個需要重新連線。 ${mcpRuntime.message ?? ""}`.trim()
        : mcpRuntime.activeProcesses > 0 && mcpRuntime.monitoringAvailable
          ? `${mcpRuntime.activeProcesses} 個可監測 MCP 連線均使用目前建置。`
          : (mcpRuntime.message ?? "無法確認 MCP runtime 狀態。");
  addFinding(
    findings,
    mcpRuntimeHealthy ? "ok" : "warning",
    "MCP runtime",
    mcpRuntimeDetail,
    mcpRuntime.restartRequired
      ? "請在 Agent 用戶端重新連線 Work Intelligence MCP。"
      : mcpRuntime.updateAvailable
        ? "目前契約相容，可照常讀寫；收尾後重新連線即可載入新版。"
        : mcpRuntime.monitoringAvailable
          ? "尚無可監測的 MCP heartbeat；重新連線後可確認 Agent 使用的建置。"
          : "請確認建置完成後重新執行 doctor。",
  );

  const userService = options.userServiceStatus ?? getUserServiceStatus({ homeDirectory, repositoryRoot, environment });
  const userServiceLabel = {
    running: "正在執行",
    stopped: "已安裝但目前未執行",
    not_installed: "尚未安裝",
    unavailable: "無法判定服務管理器狀態",
    unsupported: "此作業系統不支援自動啟動服務",
  }[userService.state];
  const userServiceHealthy =
    (userService.state === "running" && userService.enabled !== false) ||
    userService.state === "not_installed" ||
    userService.state === "unsupported";
  addFinding(
    findings,
    userServiceHealthy ? "ok" : "warning",
    "登入自動啟動服務",
    `${userService.manager ?? "服務管理器未提供"}；${userServiceLabel}。資料庫：${userService.databasePath}；備份：${userService.backupDirectory}；日誌：${userService.logPath}。`,
    userService.state === "not_installed"
      ? "如需在登入時自動啟動，請先執行 pnpm build，再執行 pnpm service:install。"
      : userServiceHealthy
        ? undefined
        : "執行 pnpm service:status 查看狀態；若服務已停止，可重新執行 pnpm service:install。",
  );

  if (!parsedEnvironment.success) {
    findings.push(envFailure());
    return findings;
  }

  const dbPath = parsedEnvironment.data.WORK_INTELLIGENCE_DB
    ? resolve(process.cwd(), parsedEnvironment.data.WORK_INTELLIGENCE_DB)
    : resolve(repositoryRoot, "data", "work-intelligence.sqlite");
  const database = await inspectDatabaseReadOnly(dbPath);
  // Keep the database, doctor, and server on the same relative backup-directory rule.
  const backupDirectory = resolveBackupDirectory(dbPath, parsedEnvironment.data.WORK_INTELLIGENCE_BACKUP_DIR);
  const latestBackup = findLatestAutomaticBackup(dbPath, backupDirectory);
  const backupDetail = latestBackup ? latestBackup.toISOString() : "尚無自動備份";

  if (database.state === "missing") {
    addFinding(
      findings,
      "warning",
      "資料庫",
      dbPath + " 尚未建立；最近自動備份：" + backupDetail + "。",
      "第一次啟動 pnpm start 後會建立資料庫。",
    );
  } else if (database.state === "unreadable") {
    addFinding(
      findings,
      "error",
      "資料庫",
      dbPath + " 無法以唯讀模式檢查；大小與 schema 版本無法取得。",
      "確認檔案權限與 SQLite 狀態，再用備份還原或執行 pnpm db:backup。",
    );
  } else if (database.state === "unhealthy") {
    addFinding(
      findings,
      "error",
      "資料庫",
      dbPath +
        "，大小 " +
        formatBytes(database.bytes ?? 0) +
        "，integrity_check 失敗，schema v" +
        (database.schemaVersion ?? 0) +
        "；最近自動備份：" +
        backupDetail +
        "。",
      "停止寫入並檢查備份；診斷程序沒有修改資料庫。",
    );
  } else {
    addFinding(
      findings,
      "ok",
      "資料庫",
      dbPath +
        "，大小 " +
        formatBytes(database.bytes ?? 0) +
        "，integrity_check 正常，schema v" +
        (database.schemaVersion ?? 0) +
        "；最近自動備份：" +
        backupDetail +
        "。",
    );
  }

  if (database.maintenance === null) {
    addFinding(
      findings,
      "warning",
      "資料庫維護",
      "尚無維護紀錄。",
      "執行 pnpm db:maintain 建立備份、整理資料庫並重建搜尋索引。",
    );
  } else if (database.maintenance) {
    const maintenance = database.maintenance;
    if (maintenance.status === "completed") {
      addFinding(
        findings,
        "ok",
        "資料庫維護",
        `完成於 ${maintenance.completedAt ?? maintenance.startedAt}；備份 ${maintenance.backupFileName}；重新索引 ${maintenance.indexedSessions} 筆 Session、${maintenance.indexedKnowledge} 筆 Knowledge，共 ${maintenance.indexedChunks} 個搜尋段落與 ${maintenance.indexedPaths} 個路徑。`,
      );
    } else {
      addFinding(
        findings,
        "warning",
        "資料庫維護",
        maintenance.status === "running"
          ? `最近一次維護於 ${maintenance.startedAt} 開始但未完成；備份 ${maintenance.backupFileName}。`
          : `最近一次維護於 ${maintenance.completedAt ?? maintenance.startedAt} 未完成；備份 ${maintenance.backupFileName}；分類 ${maintenance.failureCode ?? "DATABASE_MAINTENANCE_FAILED"}。`,
        "確認 server 與 Agent 已停止，再次執行 pnpm db:maintain；如仍失敗，請依疑難排解從維護前備份還原。",
      );
    }
  }

  const port = parsedEnvironment.data.WORK_INTELLIGENCE_PORT ?? DEFAULT_SERVER_PORT;
  const apiState = await checkApi(port);
  if (apiState === "healthy") {
    addFinding(findings, "ok", "API", "127.0.0.1:" + port + " 的 /api/health 正常。");
  } else if (apiState === "occupied") {
    addFinding(
      findings,
      "warning",
      "API",
      "port " + port + " 已被占用，但回應不是可識別的 Work Intelligence API。",
      "停止占用該 port 的程式，或設定 WORK_INTELLIGENCE_PORT 後重新啟動。",
    );
  } else {
    addFinding(
      findings,
      "warning",
      "API",
      "port " + port + " 可用，但 /api/health 無法連線。",
      "在專案根目錄執行 pnpm start。",
    );
  }

  const agentInspection = inspectAgentConnectionDetails({ homeDirectory, repositoryRoot, environment });
  const { skillFindings, globalHooks, claudeHookExists, codexHookExists } = agentInspection;
  const claudeMcp = agentInspection.claudeMcp;
  const codexMcp = agentInspection.codexMcp;
  const claudePlugin = agentInspection.claudePluginEnabled;
  if (claudePlugin) {
    const duplicated = claudeMcp === "registered" || globalHooks.claudeConfigured;
    addFinding(
      findings,
      duplicated ? "warning" : "ok",
      "Claude Code plugin",
      duplicated
        ? "work-intelligence plugin 已啟用，但全域設定也註冊了 work-intelligence MCP 或 Stop hook；Agent 會看到兩份相同工具與提醒。"
        : "work-intelligence plugin 已啟用，提供 MCP、skill 與 Stop hook。",
      duplicated
        ? "保留一種接法即可：停用 plugin，或移除手動註冊。由 pnpm setup:agents 安裝的用 pnpm setup:agents --uninstall 移除（也會移除 Codex 的設定）；手動加入的請執行 claude mcp remove work-intelligence --scope user，並刪除 Claude settings.json 中指向 apps/mcp/dist/finalize-reminder.js 的 Stop hook。plugin 不會自動移除任何設定。"
        : undefined,
    );
  }
  if (!(claudePlugin && claudeMcp === "missing")) {
    addFinding(
      findings,
      claudeMcp === "registered" ? "ok" : "warning",
      "Claude MCP",
      claudeMcp === "registered"
        ? "全域設定已註冊 work-intelligence。"
        : claudeMcp === "missing"
          ? "未找到全域 work-intelligence MCP 註冊。"
          : "無法判定 Claude MCP 註冊狀態；.claude.json 無法讀取或不是有效 JSON。",
      claudeMcp === "registered"
        ? undefined
        : claudeMcp === "missing"
          ? "依 docs/agent-setup.md 以 user scope 註冊 work-intelligence。"
          : "確認 .claude.json 存在且可讀、格式有效後重新執行 pnpm run doctor。",
    );
  }
  const codexPlugin = agentInspection.codexPluginEnabled;
  if (codexPlugin) {
    const duplicateMcp = codexMcp === "registered";
    // The plugin brings the save-reminder hooks too; one still in hooks.json runs a second time.
    const duplicateHook = globalHooks.codexConfigured || globalHooks.codexLegacyMatcher;
    const duplicates = [
      duplicateMcp ? "config.toml 也註冊了 work-intelligence MCP" : "",
      duplicateHook ? "hooks.json 也設定了保存提醒 hook" : "",
    ].filter(Boolean);
    addFinding(
      findings,
      duplicates.length ? "warning" : "ok",
      "Codex plugin",
      duplicates.length
        ? `work-intelligence plugin 已啟用，但${duplicates.join("，")}；Agent 會看到兩份相同的工具或提醒。`
        : "work-intelligence plugin 已啟用，提供 MCP、skill 與保存提醒 hook；hook 需在 Codex 的 /hooks 審查並信任才會執行。",
      duplicates.length
        ? [
            "保留一種接法即可：停用 plugin，或移除手動設定。",
            duplicateMcp ? "執行 codex mcp remove work-intelligence。" : "",
            duplicateHook ? "刪除 Codex hooks.json 中指向 apps/mcp/dist/codex-finalize-reminder.js 的項目。" : "",
            "plugin 不會自動移除任何設定。",
          ].join("")
        : "在 Codex 執行 /hooks，檢視並信任 work-intelligence plugin 的 hooks。",
    );
  }
  if (!(codexPlugin && codexMcp === "missing")) {
    addFinding(
      findings,
      codexMcp === "registered" ? "ok" : "warning",
      "Codex MCP",
      codexMcp === "registered"
        ? "全域設定已註冊 work-intelligence。"
        : codexMcp === "missing"
          ? "未找到全域 work-intelligence MCP 註冊。"
          : "無法判定 Codex MCP 註冊狀態；config.toml 無法讀取或格式無法判定。",
      codexMcp === "registered"
        ? undefined
        : codexMcp === "missing"
          ? "依 docs/agent-setup.md 註冊 work-intelligence MCP。"
          : "確認 CODEX_HOME 下的 config.toml 存在且可讀、格式有效後重新執行 pnpm run doctor。",
    );
  }

  for (const finding of skillFindings) {
    if (claudePlugin && finding.componentId === "claudeSkill" && finding.state === "missing") continue;
    // The Codex plugin carries its own copy of the skill.
    if (codexPlugin && finding.componentId !== "claudeSkill" && finding.state === "missing") continue;
    const title =
      finding.componentId === "codexSkill"
        ? "Codex canonical work-intelligence skill"
        : finding.componentId === "codexLegacySkill"
          ? "Codex legacy compatibility skill"
          : "Claude Code work-intelligence skill";
    addFinding(
      findings,
      finding.state === "current" ? "ok" : "warning",
      title,
      finding.detail,
      finding.state === "current" ? undefined : "執行 pnpm setup:agents 預覽並依提示安裝或更新 skill。",
    );
  }

  const claudeHookState = agentInspection.connections.claudeCode.hook;
  if (!(claudePlugin && claudeHookState === "missing"))
    addFinding(
      findings,
      claudeHookState === "installed" ? "ok" : "warning",
      "Claude 全域 hook",
      claudeHookState === "unknown"
        ? "無法判定 Claude Stop hook 狀態；settings.json 無法讀取或不是有效 JSON。"
        : claudeHookExists
          ? globalHooks.claudeConfigured
            ? "全域 Stop hook 已設定指向目前專案的 dist 腳本；doctor 只檢查設定檔，沒有執行 hook。"
            : "dist 腳本存在，但目前 Claude 設定目錄的 settings.json 沒有指向它的 Stop hook。"
          : "apps/mcp/dist/finalize-reminder.js 不存在。",
      claudeHookState === "installed"
        ? "在 Claude Code 工作階段確認 Stop hook 執行與提醒結果。"
        : claudeHookState === "unknown"
          ? "確認 Claude 設定目錄中的 settings.json 存在且可讀、格式有效後重新執行 pnpm run doctor。"
          : "先執行 pnpm build，再依 docs/agent-setup.md 設定全域 Claude hook。",
    );
  const codexHookState = agentInspection.connections.codex.hook;
  const codexHooksDisabled = globalHooks.codexHooksFeature === "disabled";
  // The Codex plugin carries its own hooks; the Codex plugin finding above reports them.
  if (!(codexPlugin && (codexHookState === "missing" || codexHookState === "installed" || codexHookState === "stale")))
    addFinding(
      findings,
      codexHookState === "installed" ? "ok" : "warning",
      "Codex 全域 hook",
      codexHookState === "unknown"
        ? "無法判定 Codex hook 狀態；config.toml 或 hooks.json 無法讀取或格式無法判定。"
        : codexHooksDisabled
          ? "config.toml 明確停用了 Codex hooks；hooks.json 即使有設定也不代表會執行。"
          : codexHookExists
            ? globalHooks.codexConfigured
              ? globalHooks.codexSegmentStartConfigured
                ? "PostToolUse、Stop 與 UserPromptSubmit hook 已設定；Codex 仍需在 /hooks 審查並信任，doctor 沒有執行 hook。"
                : "PostToolUse 與 Stop hook 已設定，未設定 UserPromptSubmit；Codex 仍需在 /hooks 審查並信任，doctor 沒有執行 hook。"
              : globalHooks.codexLegacyMatcher
                ? "PostToolUse hook 仍使用 MCP dispatcher 之前的舊 matcher，漏掉 work_write_idempotent 的 finalize 呼叫。"
                : "dist 腳本存在，但目前 Codex hooks 設定目錄未同時設定指定的 PostToolUse 與 Stop hook。"
            : "apps/mcp/dist/codex-finalize-reminder.js 不存在。",
      codexHookState === "unknown"
        ? "確認 CODEX_HOME 下的 config.toml 與 hooks.json 存在且可讀、格式有效後重新執行 pnpm run doctor。"
        : codexHooksDisabled
          ? "如要使用此 hook，請先手動檢視並調整 Codex config.toml 的 [features].hooks 設定，再重跑 pnpm run doctor。"
          : codexHookExists && globalHooks.codexConfigured
            ? "在 Codex 執行 /hooks，檢視並信任 Work Intelligence hooks；再於工作階段確認執行結果。"
            : globalHooks.codexHooksFeature === "unknown"
              ? "無法安全判定 Codex hooks 開關；確認 config.toml 結構後重跑 pnpm run doctor。"
              : globalHooks.codexLegacyMatcher
                ? "執行 pnpm setup:agents，預覽後確認即可更新 matcher；更新後在 Codex /hooks 重新信任。"
                : "先執行 pnpm build，再依 docs/agent-setup.md 設定全域 Codex hook。",
    );
  return findings;
}

export function formatDoctorFindings(findings: DoctorFinding[]): string {
  const icon = { ok: "✓", warning: "⚠", error: "✗" } as const;
  const lines = ["Work Intelligence 唯讀診斷"];
  for (const finding of findings) {
    lines.push(icon[finding.severity] + " " + finding.title + "： " + finding.detail);
    if (finding.recommendation) {
      lines.push("  建議：" + finding.recommendation);
    }
  }
  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.filter((finding) => finding.severity === "warning").length;
  lines.push("結果：" + errors + " 個錯誤，" + warnings + " 個提醒。");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const findings = await collectDoctorFindings();
  console.log(formatDoctorFindings(findings));
  if (findings.some((finding) => finding.severity === "error")) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => {
    console.error("Work Intelligence 唯讀診斷無法完成；請確認 Node.js 環境後重試。");
    process.exitCode = 1;
  });
}
