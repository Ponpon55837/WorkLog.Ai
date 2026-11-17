import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import process from "node:process";
import { windowsSystemTool } from "@work-intelligence/shared/windows-system-tool";
import {
  LEGACY_DEFAULT_PORT,
  LEGACY_LAUNCHD_LABEL,
  LEGACY_SYSTEMD_UNIT,
  legacyServiceDefinitionPath,
  legacyWindowsTaskTarget,
} from "./constants.js";
import { decodeLegacyDefinition, interpretLegacyDefinition, type InterpretedDefinition } from "./parse.js";
import { legacyFallbackRemoveCommand, legacyRemoveCommand } from "./remove-command.js";
import type {
  DetectLegacyServiceOptions,
  LegacyServiceCommandResult,
  LegacyServiceCommandRunner,
  LegacyServiceDetection,
  LegacyServiceFileStat,
  LegacyServicePlatform,
  LegacyServiceRunning,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 2000;
/** A real definition is under 2 KB; anything bigger is not what the installer wrote. */
const MAX_DEFINITION_BYTES = 64 * 1024;
const MISSING_CODES = new Set(["ENOENT", "ENOTDIR"]);
/** `schtasks /Query /FO CSV` status column; other locales print translated words and stay "unknown". */
const WINDOWS_RUNNING_STATUS = "Running";
const WINDOWS_STOPPED_STATUSES = new Set(["Ready", "Disabled", "Queued"]);

function isSupportedPlatform(platform: NodeJS.Platform): platform is LegacyServicePlatform {
  return platform === "darwin" || platform === "linux" || platform === "win32";
}

/** The outcome of `promise` within `milliseconds`, or undefined when it timed out or rejected. */
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

/** The default read-only runner: `execFile` without a shell or window, killed after `timeoutMs` (code -1, no output). */
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

function windowsStatus(stdout: string): LegacyServiceRunning {
  const row = stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
  const columns = row
    ? [...row.matchAll(/"((?:[^"]|"")*)"/g)].map((match) => (match[1] ?? "").replaceAll('""', '"'))
    : [];
  // /FO CSV /NH rows are "TaskName","Next Run Time","Status".
  const status = columns[2]?.trim();
  if (status === WINDOWS_RUNNING_STATUS) return "running";
  return status !== undefined && WINDOWS_STOPPED_STATUSES.has(status) ? "stopped" : "unknown";
}

async function queryRunning(
  platform: LegacyServicePlatform,
  options: DetectLegacyServiceOptions,
  run: (command: string, args: string[]) => Promise<LegacyServiceCommandResult | undefined>,
): Promise<LegacyServiceRunning> {
  if (platform === "darwin") {
    const result = await run("launchctl", ["print", launchdTarget(options.uid)]);
    if (result?.code !== 0) return "unknown";
    return /\bstate = running\b|\bpid = \d+/i.test(result.stdout) ? "running" : "stopped";
  }
  if (platform === "linux") {
    const result = await run("systemctl", ["--user", "is-active", LEGACY_SYSTEMD_UNIT]);
    const state = result?.stdout.trim();
    if (state === "active") return "running";
    return state === "inactive" || state === "failed" ? "stopped" : "unknown";
  }
  const result = await run(windowsSystemTool("schtasks.exe", options.environment), [
    "/Query",
    "/TN",
    legacyWindowsTaskTarget(),
    "/FO",
    "CSV",
    "/NH",
  ]);
  return result?.code === 0 ? windowsStatus(result.stdout) : "unknown";
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

/**
 * Read-only check for the login service `pnpm service:install` (and `pnpm bootstrap`) leaves behind: two backends on one
 * database must not run silently. Nothing is written, stopped or deleted; every failure maps to `none`, an
 * unrecognised definition, or `running: "unknown"`. The whole call stays within `timeoutMs` (default 2 s).
 */
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
  // undefined: the path could not be inspected (permission, timeout), so something is there that is not provably ours.
  const present = stat !== null;
  let definitionPath = definitionFile;
  let definitionSource: "file" | "task-query" = "file";
  let text: string | undefined;

  if (stat) {
    text = await readDefinition(stat, definitionFile, options.readTextFile ?? defaultReadText, remaining);
  } else if (platform === "win32" && !present) {
    const query = await run(windowsSystemTool("schtasks.exe", options.environment), [
      "/Query",
      "/TN",
      legacyWindowsTaskTarget(),
      "/XML",
    ]);
    if (query?.code !== 0 || !query.stdout.includes("<Task")) return { kind: "none" };
    definitionPath = legacyWindowsTaskTarget();
    definitionSource = "task-query";
    text = query.stdout;
  } else if (!present) {
    return { kind: "none" };
  }

  const interpreted: InterpretedDefinition =
    text === undefined ? { recognised: false } : interpretLegacyDefinition(platform, text);
  const running = await queryRunning(platform, options, run);
  const { repositoryRoot, databasePath, port } = interpreted;
  return {
    kind: "found",
    platform,
    definitionPath,
    definitionSource,
    recognised: interpreted.recognised,
    ...(repositoryRoot ? { repositoryRoot } : {}),
    ...(databasePath ? { databasePath } : {}),
    ...(interpreted.recognised ? { port: port ?? LEGACY_DEFAULT_PORT } : {}),
    running,
    ...(repositoryRoot ? { removeCommand: legacyRemoveCommand(platform, repositoryRoot) } : {}),
    fallbackRemoveCommand: legacyFallbackRemoveCommand(platform, definitionFile),
  };
}
