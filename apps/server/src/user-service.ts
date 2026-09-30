import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, posix, resolve, win32 } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { UserServiceManager, UserServiceState, UserServiceStatus } from "@work-intelligence/core";

export type UserServicePlatform = "darwin" | "linux" | "win32" | "unsupported";

export interface UserServiceFile {
  path: string;
  contents: string;
}

export interface UserServicePlan {
  platform: Exclude<UserServicePlatform, "unsupported">;
  manager: UserServiceManager;
  serviceName: string;
  serviceTarget: string;
  repositoryRoot: string;
  nodeExecutable: string;
  packageManagerExecutable: string;
  configPath: string;
  dataDirectory: string;
  databasePath: string;
  backupDirectory: string;
  logPath: string;
  directories: string[];
  files: UserServiceFile[];
}

export interface UserServiceOptions {
  platform?: UserServicePlatform;
  homeDirectory?: string;
  repositoryRoot?: string;
  environment?: NodeJS.ProcessEnv;
  nodeExecutable?: string;
  packageManagerExecutable?: string;
  userId?: string;
  uid?: number;
  configFileExists?: (path: string) => boolean;
  runCommand?: (command: string, args: string[]) => string;
}

type SupportedPlatform = Exclude<UserServicePlatform, "unsupported">;
type PathApi = typeof posix | typeof win32;
type RenderServicePlan = Omit<UserServicePlan, "files" | "directories">;

interface ServicePaths {
  platform: UserServicePlatform;
  manager: UserServiceManager | null;
  serviceName: string;
  serviceTarget: string;
  configPath: string | null;
  dataDirectory: string;
  databasePath: string;
  backupDirectory: string;
  logPath: string;
}

interface StoragePaths {
  dataDirectory: string;
  databasePath: string;
  backupDirectory: string;
}

const SERVICE_NAME = "Work Intelligence";
const LAUNCHD_LABEL = "ai.workintelligence.server";
const LINUX_UNIT_NAME = "work-intelligence.service";
const WINDOWS_TASK_NAME = "Work Intelligence";
const WINDOWS_TASK_PATH = "\\";
const ROOT_DIRECTORY = fileURLToPath(new URL("../../../", import.meta.url));
const RUNNER_RELATIVE_PATH = "scripts/service-runner.mjs";

function pathApi(platform: UserServicePlatform): PathApi {
  return platform === "win32" ? win32 : posix;
}

function platformFromValue(platform: NodeJS.Platform | undefined): UserServicePlatform {
  if (platform === "darwin" || platform === "linux" || platform === "win32") return platform;
  return "unsupported";
}

function defaultHomeDirectory(platform: UserServicePlatform, environment: NodeJS.ProcessEnv): string {
  if (platform === "win32") {
    const driveHome =
      environment.HOMEDRIVE && environment.HOMEPATH ? environment.HOMEDRIVE + environment.HOMEPATH : undefined;
    return environment.USERPROFILE ?? driveHome ?? homedir();
  }
  return environment.HOME ?? homedir();
}

function isAbsoluteForPlatform(value: string | undefined, platform: UserServicePlatform): value is string {
  return Boolean(value && pathApi(platform).isAbsolute(value));
}

function configuredStoragePaths(
  platform: UserServicePlatform,
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
): StoragePaths {
  const path = pathApi(platform);
  const configuredDatabase = environment.WORK_INTELLIGENCE_DB?.trim();
  const databasePath =
    configuredDatabase === ":memory:"
      ? configuredDatabase
      : configuredDatabase
        ? path.resolve(repositoryRoot, configuredDatabase)
        : path.resolve(repositoryRoot, "data", "work-intelligence.sqlite");
  const configuredBackupDirectory = environment.WORK_INTELLIGENCE_BACKUP_DIR?.trim();
  const backupDirectory = configuredBackupDirectory
    ? path.resolve(path.dirname(databasePath), configuredBackupDirectory)
    : path.join(path.dirname(databasePath), "backups");
  return { dataDirectory: path.dirname(databasePath), databasePath, backupDirectory };
}

function resolveServicePaths(options: UserServiceOptions = {}): ServicePaths {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? platformFromValue(process.platform);
  const path = pathApi(platform);
  const homeDirectory = options.homeDirectory ?? defaultHomeDirectory(platform, environment);
  const repositoryRoot = options.repositoryRoot ?? ROOT_DIRECTORY;
  const storage = configuredStoragePaths(platform, repositoryRoot, environment);
  const manager =
    platform === "darwin"
      ? "LaunchAgent"
      : platform === "linux"
        ? "systemd --user"
        : platform === "win32"
          ? "Task Scheduler"
          : null;

  if (platform === "darwin") {
    const serviceName = LAUNCHD_LABEL;
    return {
      platform,
      manager,
      serviceName,
      serviceTarget: `gui/${options.uid ?? process.getuid?.() ?? 501}/${serviceName}`,
      configPath: path.join(homeDirectory, "Library", "LaunchAgents", `${serviceName}.plist`),
      ...storage,
      logPath: path.join(homeDirectory, "Library", "Logs", "Work Intelligence", "server.log"),
    };
  }

  if (platform === "linux") {
    const stateRoot = isAbsoluteForPlatform(environment.XDG_STATE_HOME, platform)
      ? environment.XDG_STATE_HOME
      : path.join(homeDirectory, ".local", "state");
    const configRoot = isAbsoluteForPlatform(environment.XDG_CONFIG_HOME, platform)
      ? environment.XDG_CONFIG_HOME
      : path.join(homeDirectory, ".config");
    const serviceName = LINUX_UNIT_NAME;
    return {
      platform,
      manager,
      serviceName,
      serviceTarget: serviceName,
      configPath: path.join(configRoot, "systemd", "user", serviceName),
      ...storage,
      logPath: path.join(stateRoot, "work-intelligence", "logs", "server.log"),
    };
  }

  if (platform === "win32") {
    const localAppData = isAbsoluteForPlatform(environment.LOCALAPPDATA, platform)
      ? environment.LOCALAPPDATA
      : path.join(homeDirectory, "AppData", "Local");
    const appDataDirectory = path.join(localAppData, "Work Intelligence");
    const serviceDirectory = path.join(appDataDirectory, "service");
    return {
      platform,
      manager,
      serviceName: WINDOWS_TASK_NAME,
      serviceTarget: `${WINDOWS_TASK_PATH}${WINDOWS_TASK_NAME}`,
      configPath: path.join(serviceDirectory, "work-intelligence.task.xml"),
      ...storage,
      logPath: path.join(appDataDirectory, "logs", "server.log"),
    };
  }

  return {
    platform,
    manager,
    serviceName: SERVICE_NAME,
    serviceTarget: "",
    configPath: null,
    ...storage,
    logPath: path.join(homeDirectory, ".work-intelligence", "logs", "server.log"),
  };
}

function findPackageManagerExecutable(platform: SupportedPlatform, environment: NodeJS.ProcessEnv): string {
  const path = pathApi(platform);
  const entries = (environment.PATH ?? "").split(
    platform === process.platform ? delimiter : platform === "win32" ? ";" : ":",
  );
  const candidates = platform === "win32" ? ["pnpm.cmd", "pnpm.exe", "pnpm.bat", "pnpm"] : ["pnpm"];
  for (const entry of entries) {
    if (!entry) continue;
    for (const candidate of candidates) {
      const executable = path.resolve(entry, candidate);
      if (platform === process.platform && existsSync(executable)) return executable;
    }
  }
  throw new Error("找不到 pnpm 的絕對路徑；請在已安裝 pnpm 的終端機執行 service:install。");
}

function runSystemCommand(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function quoteWindowsArgument(value: string): string {
  if (value.length > 0 && !/[\s"]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

function quoteSystemdArgument(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "$$").replaceAll("%", "%%")}"`;
}

function renderLaunchAgent(plan: RenderServicePlan, runnerPath: string): string {
  const argumentsList = [
    plan.nodeExecutable,
    runnerPath,
    plan.repositoryRoot,
    plan.databasePath,
    plan.backupDirectory,
    plan.packageManagerExecutable,
    plan.logPath,
  ];
  const argumentsXml = argumentsList.map((argument) => `      <string>${escapeXml(argument)}</string>`).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${escapeXml(plan.serviceName)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    argumentsXml,
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${escapeXml(plan.repositoryRoot)}</string>`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>StandardOutPath</key>",
    `  <string>${escapeXml(plan.logPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${escapeXml(plan.logPath)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function renderSystemdUnit(plan: RenderServicePlan, runnerPath: string): string {
  const argumentsList = [
    plan.nodeExecutable,
    runnerPath,
    plan.repositoryRoot,
    plan.databasePath,
    plan.backupDirectory,
    plan.packageManagerExecutable,
    plan.logPath,
  ];
  const command = argumentsList.map(quoteSystemdArgument).join(" ");
  return [
    "[Unit]",
    "Description=Work Intelligence local server",
    "After=default.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${quoteSystemdArgument(plan.repositoryRoot)}`,
    `ExecStart=${command}`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function renderWindowsTask(plan: RenderServicePlan, runnerPath: string, userId: string): string {
  const argumentsList = [
    runnerPath,
    plan.repositoryRoot,
    plan.databasePath,
    plan.backupDirectory,
    plan.packageManagerExecutable,
    plan.logPath,
  ];
  const argumentsXml = argumentsList.map(quoteWindowsArgument).join(" ");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    `    <URI>${escapeXml(plan.serviceTarget)}</URI>`,
    "    <Description>Work Intelligence local server for the current user.</Description>",
    "  </RegistrationInfo>",
    "  <Triggers>",
    "    <LogonTrigger>",
    "      <Enabled>true</Enabled>",
    `      <UserId>${escapeXml(userId)}</UserId>`,
    "    </LogonTrigger>",
    "  </Triggers>",
    "  <Principals>",
    '    <Principal id="Author">',
    `      <UserId>${escapeXml(userId)}</UserId>`,
    "      <LogonType>InteractiveToken</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <Enabled>true</Enabled>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "  </Settings>",
    '  <Actions Context="Author">',
    "    <Exec>",
    `      <Command>${escapeXml(plan.nodeExecutable)}</Command>`,
    `      <Arguments>${escapeXml(argumentsXml)}</Arguments>`,
    `      <WorkingDirectory>${escapeXml(plan.repositoryRoot)}</WorkingDirectory>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\n");
}

function resolveCurrentUserId(platform: SupportedPlatform, options: UserServiceOptions): string {
  if (options.userId) return options.userId;
  if (platform !== "win32") return String(process.getuid?.() ?? 0);
  const output = (options.runCommand ?? runSystemCommand)("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
  const userId = output.match(/S-1-[0-9-]+/)?.[0];
  if (!userId) throw new Error("無法取得目前 Windows 使用者的 SID；服務尚未安裝。");
  return userId;
}

function buildPlan(options: UserServiceOptions = {}): UserServicePlan {
  const paths = resolveServicePaths(options);
  if (paths.platform === "unsupported" || !paths.manager || !paths.configPath) {
    throw new Error("開機自動啟動目前支援 macOS、Windows 與 Linux。");
  }
  const environment = options.environment ?? process.env;
  const path = pathApi(paths.platform);
  const repositoryRoot = options.repositoryRoot ?? resolve(ROOT_DIRECTORY);
  if (paths.databasePath === ":memory:") {
    throw new Error("登入啟動服務需要持久資料庫路徑，不能使用 WORK_INTELLIGENCE_DB=:memory:。");
  }
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const packageManagerExecutable =
    options.packageManagerExecutable ?? findPackageManagerExecutable(paths.platform, environment);
  const basePlan = {
    platform: paths.platform,
    manager: paths.manager,
    serviceName: paths.serviceName,
    serviceTarget: paths.serviceTarget,
    repositoryRoot,
    nodeExecutable,
    packageManagerExecutable,
    configPath: paths.configPath,
    dataDirectory: paths.dataDirectory,
    databasePath: paths.databasePath,
    backupDirectory: paths.backupDirectory,
    logPath: paths.logPath,
  } satisfies RenderServicePlan;
  const runnerPath = path.join(repositoryRoot, RUNNER_RELATIVE_PATH);
  const contents =
    paths.platform === "darwin"
      ? renderLaunchAgent(basePlan, runnerPath)
      : paths.platform === "linux"
        ? renderSystemdUnit(basePlan, runnerPath)
        : renderWindowsTask(basePlan, runnerPath, resolveCurrentUserId(paths.platform, options));
  const directories = [
    ...new Set([
      path.dirname(paths.configPath),
      path.dirname(paths.databasePath),
      paths.backupDirectory,
      path.dirname(paths.logPath),
    ]),
  ];
  return { ...basePlan, directories, files: [{ path: paths.configPath, contents }] };
}

function managerCommand(plan: UserServicePlan, runCommand: (command: string, args: string[]) => string): void {
  if (plan.platform === "darwin") {
    try {
      runCommand("launchctl", ["bootout", plan.serviceTarget]);
    } catch {
      // A first installation has nothing to unload.
    }
    const domain = plan.serviceTarget.slice(0, plan.serviceTarget.lastIndexOf("/"));
    runCommand("launchctl", ["bootstrap", domain, plan.configPath]);
    runCommand("launchctl", ["kickstart", "-k", plan.serviceTarget]);
    return;
  }
  if (plan.platform === "linux") {
    try {
      runCommand("systemctl", ["--user", "disable", "--now", plan.serviceName]);
    } catch {
      // A first installation has nothing to disable.
    }
    runCommand("systemctl", ["--user", "daemon-reload"]);
    runCommand("systemctl", ["--user", "enable", "--now", plan.serviceName]);
    return;
  }

  try {
    runCommand("schtasks.exe", ["/End", "/TN", plan.serviceTarget]);
  } catch {
    // A first installation has no scheduled task to stop.
  }
  runCommand("schtasks.exe", ["/Create", "/TN", plan.serviceTarget, "/XML", plan.configPath, "/F"]);
  runCommand("schtasks.exe", ["/Run", "/TN", plan.serviceTarget]);
}

function parseKeyValues(output: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 1).trim();
  }
  return values;
}

function serviceState(
  supported: boolean,
  installed: boolean,
  running: boolean | null,
  unavailable: boolean,
): UserServiceState {
  if (!supported) return "unsupported";
  if (running === true) return "running";
  if (unavailable) return "unavailable";
  return installed ? "stopped" : "not_installed";
}

export function createUserServicePlan(options: UserServiceOptions = {}): UserServicePlan {
  return buildPlan(options);
}

export function formatUserServicePreview(plan: UserServicePlan): string {
  const files = plan.files
    .map((file) => `將寫入：${file.path}\n--- ${file.path} ---\n${file.contents.trimEnd()}\n---`)
    .join("\n");
  return [
    `服務管理器：${plan.manager}`,
    "執行命令：pnpm start（正式模式）",
    `專案目錄：${plan.repositoryRoot}`,
    `資料庫：${plan.databasePath}`,
    `備份目錄：${plan.backupDirectory}`,
    `日誌：${plan.logPath}`,
    `確認後建立的資料夾：${plan.directories.join("、")}`,
    "此操作只為目前使用者設定登入啟動，不需要管理員權限；不會刪除資料庫、備份或日誌。",
    files,
  ].join("\n\n");
}

export async function installUserServiceWithConfirmation(
  plan: UserServicePlan,
  showPreview: (preview: string) => void,
  confirm: (prompt: string) => Promise<boolean>,
  runCommand = runSystemCommand,
): Promise<boolean> {
  showPreview(formatUserServicePreview(plan));
  if (!(await confirm("確認安裝目前使用者的登入啟動服務？"))) return false;
  installUserService(plan, runCommand);
  return true;
}

export function formatUserServiceStatus(status: UserServiceStatus): string {
  const stateLabel = {
    running: "執行中",
    stopped: "已安裝，未執行",
    not_installed: "尚未安裝",
    unavailable: "無法判定",
    unsupported: "此平台不支援",
  }[status.state];
  return [
    `服務管理器：${status.manager ?? "無"}`,
    `狀態：${stateLabel}`,
    `登入時啟動：${status.enabled === null ? "無法判定" : status.enabled ? "是" : "否"}`,
    `資料庫：${status.databasePath}`,
    `備份：${status.backupDirectory}`,
    `日誌：${status.logPath}`,
    ...(status.configPath ? [`服務設定：${status.configPath}`] : []),
  ].join("\n");
}

export function installUserService(plan: UserServicePlan, runCommand = runSystemCommand): void {
  for (const directory of plan.directories) mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const file of plan.files) writeFileSync(file.path, file.contents, { encoding: "utf8", mode: 0o600 });
  managerCommand(plan, runCommand);
}

export function uninstallUserService(plan: UserServicePlan, runCommand = runSystemCommand): void {
  if (plan.platform === "darwin") {
    try {
      runCommand("launchctl", ["bootout", plan.serviceTarget]);
    } catch {
      // The LaunchAgent may already be stopped.
    }
  } else if (plan.platform === "linux") {
    try {
      runCommand("systemctl", ["--user", "disable", "--now", plan.serviceName]);
    } catch {
      // The systemd unit may already be stopped.
    }
  } else {
    try {
      runCommand("schtasks.exe", ["/End", "/TN", plan.serviceTarget]);
    } catch {
      // The task may already be stopped.
    }
    runCommand("schtasks.exe", ["/Delete", "/TN", plan.serviceTarget, "/F"]);
  }
  for (const file of plan.files) rmSync(file.path, { force: true });
  if (plan.platform === "linux") runCommand("systemctl", ["--user", "daemon-reload"]);
}

export function getUserServiceStatus(options: UserServiceOptions = {}): UserServiceStatus {
  const paths = resolveServicePaths(options);
  const supported = paths.platform !== "unsupported";
  const runCommand = options.runCommand ?? runSystemCommand;
  const installedFromFile = paths.configPath ? (options.configFileExists ?? existsSync)(paths.configPath) : false;
  let installed = installedFromFile;
  let enabled: boolean | null = installedFromFile ? true : false;
  let running: boolean | null = installedFromFile ? false : false;
  let unavailable = false;

  if ((paths.platform === "darwin" || paths.platform === "linux") && !installedFromFile) {
    return {
      supported,
      state: serviceState(supported, false, false, false),
      manager: paths.manager,
      enabled: false,
      running: false,
      configPath: paths.configPath,
      databasePath: paths.databasePath,
      backupDirectory: paths.backupDirectory,
      logPath: paths.logPath,
    };
  }

  try {
    if (paths.platform === "darwin") {
      const output = runCommand("launchctl", ["print", paths.serviceTarget]);
      installed = true;
      enabled = true;
      running = /\bstate = running\b|\bpid = \d+/i.test(output);
    } else if (paths.platform === "linux") {
      const output = runCommand("systemctl", [
        "--user",
        "show",
        paths.serviceName,
        "--property=LoadState",
        "--property=ActiveState",
        "--property=UnitFileState",
      ]);
      const values = parseKeyValues(output);
      if (values.LoadState !== "not-found") installed = true;
      enabled = values.UnitFileState
        ? values.UnitFileState === "enabled" || values.UnitFileState === "enabled-runtime"
        : null;
      running = values.ActiveState ? values.ActiveState === "active" : false;
    } else if (paths.platform === "win32") {
      const output = runCommand("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$task = Get-ScheduledTask -TaskName 'Work Intelligence' -TaskPath '\\' -ErrorAction SilentlyContinue; if ($null -eq $task) { '{}' } else { [ordered]@{ state = [string]$task.State; enabled = [bool]$task.Settings.Enabled } | ConvertTo-Json -Compress }",
      ]);
      const task = JSON.parse(output.trim() || "{}") as { state?: string; enabled?: boolean };
      installed = typeof task.state === "string";
      enabled = typeof task.enabled === "boolean" ? task.enabled : installed ? null : false;
      running = task.state ? task.state.toLowerCase() === "running" : installed ? false : false;
    }
  } catch {
    unavailable = true;
    if (!installedFromFile) {
      installed = false;
      enabled = null;
      running = null;
    }
  }

  const state = serviceState(supported, installed, running, unavailable);
  return {
    supported,
    state,
    manager: paths.manager,
    enabled,
    running,
    configPath: paths.configPath,
    databasePath: paths.databasePath,
    backupDirectory: paths.backupDirectory,
    logPath: paths.logPath,
  };
}
