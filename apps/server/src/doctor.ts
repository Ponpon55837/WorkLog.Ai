import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEFAULT_SERVER_PORT } from "./server-port.js";

const ROOT_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PACKAGE_MANAGER_SCHEMA = z.string().regex(/^pnpm@\d+\.\d+\.\d+(?:\+.*)?$/);
const ROOT_PACKAGE_SCHEMA = z.object({
  packageManager: PACKAGE_MANAGER_SCHEMA,
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

export interface ReadOnlyDatabaseInspection {
  state: "missing" | "ok" | "unhealthy" | "unreadable";
  bytes?: number;
  integrity?: "ok" | "failed";
  schemaVersion?: number;
}

export interface GlobalHookInspection {
  claudeConfigured: boolean;
  codexConfigured: boolean;
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

function readJsonObject(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const result = JSON_OBJECT_SCHEMA.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  const result = JSON_OBJECT_SCHEMA.safeParse(value);
  return result.success ? result.data : undefined;
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
    return false;
  }
  const prefix = normalizedCommand.slice(0, -normalizedPath.length);
  return prefix.length === 0 || /\s$/.test(prefix) || /["']$/.test(prefix);
}

function hasClaudeStopHook(config: Record<string, unknown> | undefined, scriptPath: string): boolean {
  const hooks = record(config?.hooks);
  return collectCommands(entries(hooks?.Stop)).some((command) => commandPointsTo(command, scriptPath));
}

function hasCodexGlobalHooks(config: Record<string, unknown> | undefined, scriptPath: string): boolean {
  const hooks = record(config?.hooks);
  const postToolUseEntries = entries(hooks?.PostToolUse);
  const requiredMatcher = "^(apply_patch|.*work_finalize_session)$";
  const postToolUseMatches = postToolUseEntries.some((entry) => {
    const hookEntry = record(entry);
    return (
      hookEntry?.matcher === requiredMatcher &&
      collectCommands(hookEntry.hooks).some((command) => commandPointsTo(command, scriptPath))
    );
  });
  const stopMatches = collectCommands(entries(hooks?.Stop)).some((command) => commandPointsTo(command, scriptPath));
  return postToolUseMatches && stopMatches;
}

/** Inspects only the global Claude and Codex hook configuration files. */
export function inspectGlobalHooks(homeDirectory: string, repositoryRoot: string): GlobalHookInspection {
  const claudeScript = resolve(repositoryRoot, "apps/mcp/dist/finalize-reminder.js");
  const codexScript = resolve(repositoryRoot, "apps/mcp/dist/codex-finalize-reminder.js");
  const claudeSettings = readJsonObject(join(homeDirectory, ".claude", "settings.json"));
  const codexSettings = readJsonObject(join(homeDirectory, ".codex", "hooks.json"));
  return {
    claudeConfigured: hasClaudeStopHook(claudeSettings, claudeScript),
    codexConfigured: hasCodexGlobalHooks(codexSettings, codexScript),
  };
}

function inspectClaudeMcp(homeDirectory: string): boolean {
  const config = readJsonObject(join(homeDirectory, ".claude.json"));
  return record(record(config?.mcpServers)?.["work-intelligence"]) !== undefined;
}

function inspectCodexMcp(homeDirectory: string): boolean {
  try {
    const config = readFileSync(join(homeDirectory, ".codex", "config.toml"), "utf8");
    return /^\s*\[mcp_servers\.work-intelligence\]\s*$/m.test(config);
  } catch {
    return false;
  }
}

/** Opens an existing database strictly read-only and queries metadata only. */
export async function inspectDatabaseReadOnly(databasePath: string): Promise<ReadOnlyDatabaseInspection> {
  if (!existsSync(databasePath)) {
    return { state: "missing" };
  }
  let database: import("node:sqlite").DatabaseSync | undefined;
  try {
    const sqlite = await import("node:sqlite");
    database = new sqlite.DatabaseSync(databasePath, { readOnly: true });
    const checks = database.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check?: unknown }>;
    const integrityOk = checks.length > 0 && checks.every((row) => row.integrity_check === "ok");
    const migrationTable = database
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get() as { present?: number } | undefined;
    let schemaVersion = 0;
    if (migrationTable) {
      const row = database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
        { version?: number | null } | undefined;
      schemaVersion = Number(row?.version ?? 0);
      if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 0) {
        return { state: "unhealthy", bytes: statSync(databasePath).size, integrity: "failed" };
      }
    }
    return {
      state: integrityOk ? "ok" : "unhealthy",
      bytes: statSync(databasePath).size,
      integrity: integrityOk ? "ok" : "failed",
      schemaVersion,
    };
  } catch {
    return { state: "unreadable" };
  } finally {
    database?.close();
  }
}

function findLatestAutomaticBackup(databasePath: string, backupDirectory: string): Date | undefined {
  try {
    const prefix = basename(databasePath, extname(databasePath)) + "-automatic-";
    const files = readdirSync(backupDirectory);
    let latest: Date | undefined;
    for (const fileName of files) {
      if (!fileName.startsWith(prefix) || !fileName.endsWith(".sqlite")) {
        continue;
      }
      const modifiedAt = statSync(join(backupDirectory, fileName)).mtime;
      if (!latest || modifiedAt > latest) {
        latest = modifiedAt;
      }
    }
    return latest;
  } catch {
    return undefined;
  }
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
      required = parsed.data.packageManager.slice("pnpm@".length).split("+")[0] ?? "未知";
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
  } = {},
): Promise<DoctorFinding[]> {
  const homeDirectory = options.homeDirectory ?? process.env.HOME ?? process.env.USERPROFILE ?? "";
  const repositoryRoot = options.repositoryRoot ?? ROOT_DIRECTORY;
  const environment = options.environment ?? process.env;
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
  const pnpmMatches = packageManager.installed !== undefined && packageManager.installed === packageManager.required;
  addFinding(
    findings,
    pnpmMatches ? "ok" : "warning",
    "pnpm",
    packageManager.installed
      ? "目前版本 " + packageManager.installed + "；專案要求 " + packageManager.required + "。"
      : "無法取得 pnpm 版本；專案要求 " + packageManager.required + "。",
    pnpmMatches ? undefined : "使用 package.json 指定的 pnpm 版本執行 pnpm install 與 pnpm run doctor。",
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

  if (!parsedEnvironment.success) {
    findings.push(envFailure());
    return findings;
  }

  const dbPath = parsedEnvironment.data.WORK_INTELLIGENCE_DB
    ? resolve(process.cwd(), parsedEnvironment.data.WORK_INTELLIGENCE_DB)
    : resolve(repositoryRoot, "data", "work-intelligence.sqlite");
  const database = await inspectDatabaseReadOnly(dbPath);
  const backupDirectory = parsedEnvironment.data.WORK_INTELLIGENCE_BACKUP_DIR
    ? resolve(process.cwd(), parsedEnvironment.data.WORK_INTELLIGENCE_BACKUP_DIR)
    : join(dirname(dbPath), "backups");
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

  const claudeMcp = inspectClaudeMcp(homeDirectory);
  const codexMcp = inspectCodexMcp(homeDirectory);
  addFinding(
    findings,
    claudeMcp ? "ok" : "warning",
    "Claude MCP",
    claudeMcp ? "全域設定已註冊 work-intelligence。" : "未找到全域 work-intelligence MCP 註冊。",
    claudeMcp ? undefined : "依 docs/agent-setup.md 以 user scope 註冊 work-intelligence。",
  );
  addFinding(
    findings,
    codexMcp ? "ok" : "warning",
    "Codex MCP",
    codexMcp ? "全域設定已註冊 work-intelligence。" : "未找到全域 work-intelligence MCP 註冊。",
    codexMcp ? undefined : "依 docs/agent-setup.md 註冊 work-intelligence MCP。",
  );

  const globalHooks = inspectGlobalHooks(homeDirectory, repositoryRoot);
  const claudeHookExists = existsSync(resolve(repositoryRoot, "apps/mcp/dist/finalize-reminder.js"));
  const codexHookExists = existsSync(resolve(repositoryRoot, "apps/mcp/dist/codex-finalize-reminder.js"));
  addFinding(
    findings,
    claudeHookExists && globalHooks.claudeConfigured ? "ok" : "warning",
    "Claude 全域 hook",
    claudeHookExists
      ? globalHooks.claudeConfigured
        ? "全域 Stop hook 指向目前專案的 dist 腳本。"
        : "dist 腳本存在，但全域 ~/.claude/settings.json 沒有指向它的 Stop hook。"
      : "apps/mcp/dist/finalize-reminder.js 不存在。",
    claudeHookExists && globalHooks.claudeConfigured
      ? undefined
      : "先執行 pnpm build，再依 docs/agent-setup.md 設定全域 Claude hook。",
  );
  addFinding(
    findings,
    codexHookExists && globalHooks.codexConfigured ? "ok" : "warning",
    "Codex 全域 hook",
    codexHookExists
      ? globalHooks.codexConfigured
        ? "全域 PostToolUse 與 Stop hook 指向目前專案的 dist 腳本。"
        : "dist 腳本存在，但全域 ~/.codex/hooks.json 未同時設定指定的 PostToolUse 與 Stop hook。"
      : "apps/mcp/dist/codex-finalize-reminder.js 不存在。",
    codexHookExists && globalHooks.codexConfigured
      ? undefined
      : "先執行 pnpm build，再依 docs/agent-setup.md 設定全域 Codex hook，並在 /hooks 信任它。",
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
