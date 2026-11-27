import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import process from "node:process";
import { windowsPowerShell } from "@work-intelligence/shared/windows-system-tool";
import {
  LEGACY_DEFAULT_PORT,
  LEGACY_LAUNCHD_LABEL,
  LEGACY_SYSTEMD_UNIT,
  legacyServiceDefinitionPath,
  legacyWindowsTaskTarget,
} from "./constants.js";
import { decodeLegacyDefinition, interpretLegacyDefinition, type InterpretedDefinition } from "./parse.js";
import type {
  DetectLegacyServiceOptions,
  LegacyServiceCommandResult,
  LegacyServiceCommandRunner,
  LegacyServiceDetection,
  LegacyServiceEnabled,
  LegacyServiceFileStat,
  LegacyServicePlatform,
  LegacyServiceRunning,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 2000;
const MAX_DEFINITION_BYTES = 64 * 1024;
const MISSING_CODES = new Set(["ENOENT", "ENOTDIR"]);
const LAUNCHD_NOT_FOUND_CODE = 113;

export const LAUNCHCTL = "/bin/launchctl";
const TASK_STATE_DISABLED = 1;
const TASK_STATE_QUEUED = 2;
const TASK_STATE_READY = 3;
const TASK_STATE_RUNNING = 4;
const WINDOWS_TASK_SCRIPT =
  "$t = Get-ScheduledTask -TaskPath '\\' -TaskName 'Work Intelligence' -ErrorAction SilentlyContinue; " +
  "if ($null -eq $t) { '{}' } else { " +
  "$logon = [bool]($t.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' -and $_.Enabled -ne $false }); " +
  "$xml = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Export-ScheduledTask -TaskPath '\\' -TaskName 'Work Intelligence'))); " +
  "[ordered]@{ state = [int]$t.State; enabled = [bool]$t.Settings.Enabled; logon = $logon; xml = $xml } | ConvertTo-Json -Compress }";

type LegacyServiceRegistration = "registered" | "absent" | "unknown";

interface ServiceQuery {
  registration: LegacyServiceRegistration;
  running: LegacyServiceRunning;
  enabled?: LegacyServiceEnabled;
  launchdRunAtLoad?: boolean;
  taskXml?: string;
}

function isSupportedPlatform(platform: NodeJS.Platform): platform is LegacyServicePlatform {
  return platform === "darwin" || platform === "linux" || platform === "win32";
}

async function withinDeadline<T>(promise: Promise<T>, milliseconds: number): Promise<T | undefined> {
  if (milliseconds <= 0) {
    promise.catch(() => undefined);
    return undefined;
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), milliseconds);
  });
  try {
    return await Promise.race([promise.catch(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function createLegacyCommandRunner(timeoutMs: number): LegacyServiceCommandRunner {
  return (command, args) =>
    new Promise<LegacyServiceCommandResult>((resolve) => {
      execFile(
        command,
        args,
        { encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (!error) return resolve({ stdout, code: 0 });
          const { code, killed } = error as NodeJS.ErrnoException & { killed?: boolean };
          resolve({ stdout: killed ? "" : stdout, code: killed ? -1 : typeof code === "number" ? code : 1 });
        },
      );
    });
}

async function defaultLstat(path: string): Promise<LegacyServiceFileStat | null> {
  try {
    const stat = await lstat(path);
    return { isSymbolicLink: stat.isSymbolicLink(), isFile: stat.isFile(), size: stat.size };
  } catch (error) {
    if (MISSING_CODES.has((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}

async function defaultReadText(path: string): Promise<string> {
  return decodeLegacyDefinition(await readFile(path));
}

function launchdTarget(uid: number | undefined): string {
  return `gui/${uid ?? process.getuid?.() ?? 501}/${LEGACY_LAUNCHD_LABEL}`;
}

function keyValues(stdout: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index > 0) values[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return values;
}

function windowsTaskState(state: unknown): LegacyServiceRunning {
  if (state === TASK_STATE_RUNNING) return "running";
  return state === TASK_STATE_DISABLED || state === TASK_STATE_QUEUED || state === TASK_STATE_READY
    ? "stopped"
    : "unknown";
}

function parseWindowsTask(stdout: string): ServiceQuery | undefined {
  let task: { state?: unknown; enabled?: unknown; logon?: unknown; xml?: unknown };
  try {
    task = JSON.parse(stdout.replace(/^\uFEFF/, "").trim()) as typeof task;
  } catch {
    return undefined;
  }
  if (task === null || typeof task !== "object" || Array.isArray(task)) return undefined;
  if (task.state === undefined)
    return Object.keys(task).length === 0 ? { registration: "absent", running: "unknown" } : undefined;
  const taskEnabled = task.enabled === true && task.state !== TASK_STATE_DISABLED;
  const enabled: LegacyServiceEnabled =
    typeof task.enabled !== "boolean" || typeof task.logon !== "boolean"
      ? "unknown"
      : taskEnabled && task.logon
        ? "enabled"
        : "disabled";
  return {
    registration: "registered",
    running: windowsTaskState(task.state),
    enabled,
    ...(typeof task.xml === "string" ? { taskXml: Buffer.from(task.xml, "base64").toString("utf8") } : {}),
  };
}

function linuxEnabled(unitFileState: string | undefined): LegacyServiceEnabled {
  if (!unitFileState) return "unknown";
  return unitFileState === "enabled" || unitFileState === "enabled-runtime" ? "enabled" : "disabled";
}

async function queryService(
  platform: LegacyServicePlatform,
  options: DetectLegacyServiceOptions,
  run: (command: string, args: string[]) => Promise<LegacyServiceCommandResult | undefined>,
): Promise<ServiceQuery> {
  const unknown: ServiceQuery = { registration: "unknown", running: "unknown" };
  if (platform === "darwin") {
    const result = await run(LAUNCHCTL, ["print", launchdTarget(options.uid)]);
    if (result?.code === LAUNCHD_NOT_FOUND_CODE) return { registration: "absent", running: "unknown" };
    if (result?.code !== 0) return unknown;
    return {
      registration: "registered",
      running: /\bstate = running\b|\bpid = \d+/i.test(result.stdout) ? "running" : "stopped",
      launchdRunAtLoad: /\brunatload\b|\brun at load\b/i.test(result.stdout),
    };
  }
  if (platform === "linux") {
    // `show` prints KEY=VALUE pairs that no locale changes.
    const result = await run("systemctl", [
      "--user",
      "show",
      LEGACY_SYSTEMD_UNIT,
      "--property=LoadState",
      "--property=ActiveState",
      "--property=UnitFileState",
    ]);
    const values = keyValues(result?.stdout ?? "");
    if (result?.code !== 0 || !values.LoadState) return unknown;
    if (values.LoadState === "not-found") return { registration: "absent", running: "unknown" };
    const active = values.ActiveState;
    return {
      registration: "registered",
      running: active === "active" ? "running" : active === "inactive" || active === "failed" ? "stopped" : "unknown",
      enabled: linuxEnabled(values.UnitFileState),
    };
  }
  const result = await run(windowsPowerShell(options.environment), [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    WINDOWS_TASK_SCRIPT,
  ]);
  return (result?.code === 0 ? parseWindowsTask(result.stdout) : undefined) ?? unknown;
}

function launchdEnabled(query: ServiceQuery, text: string | undefined): LegacyServiceEnabled {
  if (text !== undefined) return /<key>RunAtLoad<\/key>\s*<true\s*\/>/.test(text) ? "enabled" : "disabled";
  return query.launchdRunAtLoad ? "enabled" : "unknown";
}

async function readDefinition(
  stat: LegacyServiceFileStat | undefined,
  path: string,
  read: (path: string) => Promise<string>,
  remaining: () => number,
): Promise<string | undefined> {
  if (!stat?.isFile || stat.isSymbolicLink || stat.size > MAX_DEFINITION_BYTES) return undefined;
  return withinDeadline(read(path), remaining());
}

export function legacyDefinitionDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function detectLegacyService(options: DetectLegacyServiceOptions): Promise<LegacyServiceDetection> {
  const { platform } = options;
  if (!isSupportedPlatform(platform)) return { kind: "none" };
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const remaining = (): number => Math.max(0, deadline - Date.now());
  const runner = options.runCommand ?? createLegacyCommandRunner(timeoutMs);
  const run = (command: string, args: string[]): Promise<LegacyServiceCommandResult | undefined> =>
    withinDeadline(runner(command, args), remaining());
  const definitionFile = legacyServiceDefinitionPath({
    platform,
    homeDirectory: options.homeDirectory,
    environment: options.environment,
  });

  let stat: LegacyServiceFileStat | null | undefined;
  try {
    stat = await withinDeadline(
      (options.lstatFile ?? defaultLstat)(definitionFile).then((value) => value ?? null),
      remaining(),
    );
  } catch {
    stat = undefined;
  }
  const present = stat !== null;
  if (!present && platform !== "win32") return { kind: "none" };

  const query = await queryService(platform, options, run);
  if (query.registration === "absent") return { kind: "none" };

  let definitionPath = definitionFile;
  let definitionSource: "file" | "task-query" = "file";
  let text: string | undefined;
  if (stat) {
    text = await readDefinition(stat, definitionFile, options.readTextFile ?? defaultReadText, remaining);
  } else if (!present) {
    if (query.registration === "unknown") return { kind: "unknown" };
    if (!query.taskXml?.includes("<Task")) return { kind: "none" };
    definitionPath = legacyWindowsTaskTarget();
    definitionSource = "task-query";
    text = query.taskXml;
  }

  const interpreted: InterpretedDefinition =
    text === undefined ? { recognised: false } : interpretLegacyDefinition(platform, text);
  const enabled =
    platform === "darwin" && query.registration === "registered"
      ? launchdEnabled(query, interpreted.recognised ? text : undefined)
      : query.enabled;
  const { repositoryRoot, databasePath, backupDirectory, port } = interpreted;
  return {
    kind: "found",
    platform,
    definitionPath,
    definitionSource,
    recognised: interpreted.recognised,
    ...(repositoryRoot ? { repositoryRoot } : {}),
    ...(databasePath ? { databasePath } : {}),
    ...(backupDirectory ? { backupDirectory } : {}),
    ...(interpreted.recognised ? { port: port ?? LEGACY_DEFAULT_PORT } : {}),
    ...(interpreted.recognised && text !== undefined ? { definitionDigest: legacyDefinitionDigest(text) } : {}),
    running: query.running,
    ...(enabled === undefined ? {} : { enabled }),
  };
}
