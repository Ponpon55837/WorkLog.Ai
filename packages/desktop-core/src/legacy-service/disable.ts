import { lstat, readdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { windowsPowerShell, windowsSystemTool } from "@work-intelligence/shared/windows-system-tool";
import {
  LEGACY_DEFAULT_PORT,
  LEGACY_LAUNCHD_LABEL,
  LEGACY_RUNNER_RELATIVE_PATH,
  LEGACY_SYSTEMD_UNIT,
  legacyWindowsTaskTarget,
} from "./constants.js";
import { legacyDefinitionDigest } from "./detect.js";
import { decodeLegacyDefinition } from "./parse.js";
import type {
  LegacyServiceCommandRunner,
  LegacyServiceDetection,
  LegacyServiceFound,
  LegacyServicePlatform,
} from "./types.js";

/** How long the old backend gets to let go of the port (and, on Windows, for the ended trees to vanish). */
const DEFAULT_STOP_WAIT_MS = 15_000;
const STOP_POLL_MS = 250;
/** Copies of apps/server/src/transfer-workspace.ts (desktop-core must not import the server). */
const TRANSFER_ROOT_NAME = ".work-intelligence-transfer";
const TRANSFER_MARKER_FILE = ".wi-transfer";
const TRANSFER_MARKER_CONTENT = "work-intelligence transfer directory v1\n";
const IMPORT_DIRECTORY = /^import-[A-Za-z0-9]{6}$/;
const ACTIVE_TRANSFER_AGE_MS = 60 * 60 * 1000;
/** Copy of the staging name packages/storage/src/backup.ts gives an in-progress backup. */
const BACKUP_STAGING = /^\.wi-(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i;
/**
 * Windows: every node.exe with its command line, as base64 of the UTF-8 JSON so a non-ASCII checkout path survives any
 * console code page. The match itself happens in {@link matchesLegacyRunner}, never in PowerShell.
 */
const WINDOWS_NODE_PROCESSES_SCRIPT =
  "$p = @(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { [ordered]@{ pid = [int]$_.ProcessId; commandLine = [string]$_.CommandLine } }); " +
  "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $p -Compress)))";

/** One OS command, as an argv array that is never passed through a shell. */
export interface LegacyDisableCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * One step of the disable. `stop` steps end the old backend; `remove` steps only run once it is proven stopped.
 * A tolerated command may fail (the service was already stopped or unloaded); the final detection is the authority.
 */
export type LegacyDisableStep =
  | {
      readonly kind: "command";
      readonly stage: "stop" | "remove";
      readonly run: LegacyDisableCommand;
      readonly tolerateFailure: boolean;
    }
  /** Windows: end the process trees whose command line names this checkout's runner (`taskkill /PID <pid> /T /F`). */
  | { readonly kind: "end-runners"; readonly stage: "stop"; readonly runnerPath: string }
  /** Remove the definition file, only while it still is the regular file with the planned digest. */
  | { readonly kind: "remove-definition"; readonly stage: "remove"; readonly path: string };

/** What a confirmed disable will do; built only from a recognised detection. */
export interface LegacyDisablePlan {
  readonly platform: LegacyServicePlatform;
  readonly definitionPath: string;
  readonly definitionSource: "file" | "task-query";
  readonly definitionDigest: string;
  readonly repositoryRoot: string;
  readonly databasePath?: string;
  readonly backupDirectory?: string;
  readonly port: number;
  readonly wasRunning: boolean;
  /** Windows ends the old backend at once (no graceful shutdown); macOS and Linux send it SIGTERM. */
  readonly hardStop: boolean;
  readonly steps: readonly LegacyDisableStep[];
}

export interface PlanLegacyDisableOptions {
  /** macOS `gui/<uid>/…`; defaults to the current process uid, else 501 (as detection does). */
  readonly uid?: number;
  /** Windows: where System32 is (`SystemRoot`). */
  readonly environment?: NodeJS.ProcessEnv;
}

function launchdTarget(uid: number | undefined): string {
  return `gui/${uid ?? process.getuid?.() ?? 501}/${LEGACY_LAUNCHD_LABEL}`;
}

/** The runner `service:install` starts for `repositoryRoot`: `<root>\scripts\service-runner.mjs` on Windows. */
export function legacyRunnerPath(platform: LegacyServicePlatform, repositoryRoot: string): string {
  return (platform === "win32" ? path.win32 : path.posix).join(repositoryRoot, LEGACY_RUNNER_RELATIVE_PATH);
}

/** Whether {@link planLegacyDisable} would plan for this detection (the views offer the button only then). */
export function canDisableLegacyService(detection: LegacyServiceDetection | null | undefined): boolean {
  return (
    detection?.kind === "found" && detection.recognised && !!detection.repositoryRoot && !!detection.definitionDigest
  );
}

/**
 * The plan for a recognised definition, or null: an unrecognised one, or one without the checkout or its digest, is
 * never touched (the user gets the manual commands instead). Same order as `pnpm service:uninstall`.
 */
export function planLegacyDisable(
  detection: LegacyServiceDetection,
  options: PlanLegacyDisableOptions = {},
): LegacyDisablePlan | null {
  if (detection.kind !== "found" || !canDisableLegacyService(detection)) return null;
  const { platform, repositoryRoot, definitionDigest } = detection;
  if (!repositoryRoot || !definitionDigest) return null;
  const base = {
    platform,
    definitionPath: detection.definitionPath,
    definitionSource: detection.definitionSource,
    definitionDigest,
    repositoryRoot,
    ...(detection.databasePath ? { databasePath: detection.databasePath } : {}),
    ...(detection.backupDirectory ? { backupDirectory: detection.backupDirectory } : {}),
    port: detection.port ?? LEGACY_DEFAULT_PORT,
    wasRunning: detection.running !== "stopped",
  };
  const removeFile: LegacyDisableStep[] =
    detection.definitionSource === "file"
      ? [{ kind: "remove-definition", stage: "remove", path: detection.definitionPath }]
      : [];
  if (platform === "darwin") {
    return {
      ...base,
      hardStop: false,
      steps: [
        {
          kind: "command",
          stage: "stop",
          run: { command: "launchctl", args: ["bootout", launchdTarget(options.uid)] },
          tolerateFailure: true,
        },
        ...removeFile,
      ],
    };
  }
  if (platform === "linux") {
    return {
      ...base,
      hardStop: false,
      steps: [
        {
          kind: "command",
          stage: "stop",
          run: { command: "systemctl", args: ["--user", "disable", "--now", LEGACY_SYSTEMD_UNIT] },
          tolerateFailure: true,
        },
        ...removeFile,
        {
          kind: "command",
          stage: "remove",
          run: { command: "systemctl", args: ["--user", "daemon-reload"] },
          tolerateFailure: true,
        },
      ],
    };
  }
  const environment = options.environment ?? process.env;
  const schtasks = windowsSystemTool("schtasks.exe", environment);
  return {
    ...base,
    hardStop: true,
    steps: [
      {
        kind: "command",
        stage: "stop",
        run: { command: schtasks, args: ["/End", "/TN", legacyWindowsTaskTarget()] },
        tolerateFailure: true,
      },
      { kind: "end-runners", stage: "stop", runnerPath: legacyRunnerPath(platform, repositoryRoot) },
      {
        kind: "command",
        stage: "remove",
        run: { command: schtasks, args: ["/Delete", "/TN", legacyWindowsTaskTarget(), "/F"] },
        tolerateFailure: false,
      },
      ...removeFile,
    ],
  };
}

/** Quotes one argv entry for display only (the steps never run through a shell). */
function displayArgument(value: string): string {
  return /^[A-Za-z0-9_./:=\\-]+$/.test(value) ? value : `"${value.replaceAll('"', '\\"')}"`;
}

/** One line per step for 「詳細步驟」. */
export function describeLegacyDisableSteps(plan: LegacyDisablePlan): string[] {
  return plan.steps.map((step) => {
    if (step.kind === "command") {
      return [path.win32.basename(step.run.command), ...step.run.args].map(displayArgument).join(" ");
    }
    if (step.kind === "end-runners") return `taskkill /PID <${displayArgument(step.runnerPath)} 的程序> /T /F`;
    return `${plan.platform === "win32" ? "Remove-Item" : "rm"} ${displayArgument(step.path)}`;
  });
}

const PATH_BOUNDARY = new Set(["", " ", "\t", '"', "'", "="]);

/**
 * Whether a Windows command line runs exactly `runnerPath`: case-insensitive, `/` and `\` treated alike, repeated
 * separators collapsed, and the path must stand alone (not a suffix of a longer path such as `D:\x\C:\repo\…`).
 */
export function matchesLegacyRunner(commandLine: string, runnerPath: string): boolean {
  const normalise = (value: string): string =>
    value
      .replaceAll("/", "\\")
      .replace(/\\{2,}/g, "\\")
      .toLowerCase();
  const haystack = normalise(commandLine);
  const needle = normalise(path.win32.normalize(runnerPath));
  if (needle.length === 0) return false;
  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + 1)) {
    const before = haystack.charAt(index - 1);
    const after = haystack.charAt(index + needle.length);
    if (PATH_BOUNDARY.has(before) && PATH_BOUNDARY.has(after)) return true;
  }
  return false;
}

/** Parses the base64 JSON {@link WINDOWS_NODE_PROCESSES_SCRIPT} prints; null when it is anything else. */
export function parseWindowsNodeProcesses(stdout: string): { pid: number; commandLine: string }[] | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(stdout.trim(), "base64")
        .toString("utf8")
        .replace(/^\uFEFF/, ""),
    ) as unknown;
    const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? [parsed] : null;
    if (!list) return null;
    return list.flatMap((entry: unknown) => {
      const { pid, commandLine } = (entry ?? {}) as { pid?: unknown; commandLine?: unknown };
      return Number.isSafeInteger(pid) && (pid as number) > 0 && typeof commandLine === "string"
        ? [{ pid: pid as number, commandLine }]
        : [];
    });
  } catch {
    return null;
  }
}

/** What may be in the middle of writing the old service's data. */
export interface LegacyBusyReport {
  /** An import directory under the transfer workspace beside the database, with its marker and under an hour old. */
  readonly importRunning: boolean;
  /** A backup staging directory whose owner process is still alive. */
  readonly backupRunning: boolean;
}

export interface LegacyBusyOptions {
  readonly databasePath?: string;
  readonly backupDirectory?: string;
  readonly now?: number;
  readonly isProcessAlive?: (pid: number) => boolean;
}

export function legacyProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function names(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch {
    return [];
  }
}

async function activeImport(root: string, now: number): Promise<boolean> {
  for (const name of await names(root)) {
    if (!IMPORT_DIRECTORY.test(name)) continue;
    const directory = path.join(root, name);
    try {
      const stats = await lstat(directory);
      if (!stats.isDirectory() || now - stats.mtimeMs >= ACTIVE_TRANSFER_AGE_MS) continue;
      const marker = path.join(directory, TRANSFER_MARKER_FILE);
      if ((await lstat(marker)).isFile() && (await readFile(marker, "utf8")) === TRANSFER_MARKER_CONTENT) return true;
    } catch {
      // Gone between listing and checking: nothing is running there.
    }
  }
  return false;
}

/** Read-only: whether the old service looks busy importing or backing up. Unreadable places count as not busy. */
export async function detectLegacyBusy(options: LegacyBusyOptions): Promise<LegacyBusyReport> {
  const now = options.now ?? Date.now();
  const alive = options.isProcessAlive ?? legacyProcessIsAlive;
  const importRunning = options.databasePath
    ? await activeImport(path.join(path.dirname(options.databasePath), TRANSFER_ROOT_NAME), now)
    : false;
  let backupRunning = false;
  if (options.backupDirectory) {
    for (const name of await names(options.backupDirectory)) {
      const match = BACKUP_STAGING.exec(name);
      const pid = match ? Number(match[1]) : 0;
      if (Number.isSafeInteger(pid) && pid > 0 && alive(pid)) {
        backupRunning = true;
        break;
      }
    }
  }
  return { importRunning, backupRunning };
}

/** The disable's side effects, injected so every branch is testable without a real service. */
export interface LegacyDisableDependencies {
  /** Runs an OS command (no shell); the default is the detection runner with a longer deadline. */
  readonly runCommand: LegacyServiceCommandRunner;
  /** Detects again: before acting (the definition must be unchanged) and at the end (it must be gone). */
  readonly detect: () => Promise<LegacyServiceDetection>;
  readonly isPortFree: (port: number) => Promise<boolean>;
  readonly isProcessAlive: (pid: number) => boolean;
  /** Reads the definition file as raw bytes; must not follow a symbolic link (checked with `lstat` first). */
  readonly readDefinition: (file: string) => Promise<Buffer>;
  readonly lstat: (file: string) => Promise<{ isFile: boolean; isSymbolicLink: boolean } | null>;
  readonly unlink: (file: string) => Promise<void>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly now: () => number;
  readonly environment: NodeJS.ProcessEnv;
  /** Windows only; defaults to {@link DEFAULT_STOP_WAIT_MS}. */
  readonly stopWaitMs?: number;
}

export type LegacyDisableOutcome =
  /** Stopped (when it ran) and removed; detection no longer finds it. */
  | { readonly outcome: "disabled"; readonly endedProcesses: number }
  /** The definition is not the one previewed (edited, replaced, removed, or no longer recognised): nothing was done. */
  | { readonly outcome: "changed" }
  /** The old backend still holds the port (or its processes) after the bounded wait: nothing was removed. */
  | { readonly outcome: "still-running"; readonly port: number }
  /** A step failed; `removed` says whether any part of the registration was already removed. */
  | { readonly outcome: "failed"; readonly step: string; readonly detail: string; readonly removed: boolean };

/** The fields a re-detection must still show for the plan to be acted on. */
function samePlan(plan: LegacyDisablePlan, found: LegacyServiceFound): boolean {
  return (
    found.recognised &&
    found.platform === plan.platform &&
    found.definitionPath === plan.definitionPath &&
    found.definitionSource === plan.definitionSource &&
    found.definitionDigest === plan.definitionDigest &&
    found.repositoryRoot === plan.repositoryRoot &&
    (found.port ?? LEGACY_DEFAULT_PORT) === plan.port
  );
}

async function waitUntil(dependencies: LegacyDisableDependencies, ready: () => Promise<boolean>): Promise<boolean> {
  const deadline = dependencies.now() + (dependencies.stopWaitMs ?? DEFAULT_STOP_WAIT_MS);
  for (;;) {
    if (await ready()) return true;
    if (dependencies.now() >= deadline) return false;
    await dependencies.sleep(STOP_POLL_MS);
  }
}

class StepFailure extends Error {
  readonly step: string;
  constructor(step: string, detail: string) {
    super(detail);
    this.step = step;
  }
}

/**
 * Carries out a confirmed plan: detect again (stop with `changed` unless the definition is byte-for-byte the one
 * previewed), stop, wait until the port is free (and on Windows the ended processes are gone), then remove the
 * registration and the definition, and detect once more. Nothing is removed before the old backend is proven stopped,
 * and nothing but this checkout's runner trees, the fixed label, unit or task name and the planned file is touched.
 */
export async function executeLegacyDisable(
  plan: LegacyDisablePlan,
  dependencies: LegacyDisableDependencies,
): Promise<LegacyDisableOutcome> {
  const before = await dependencies.detect();
  if (before.kind !== "found" || !samePlan(plan, before)) return { outcome: "changed" };

  const endedProcesses: number[] = [];
  let removed = false;
  try {
    for (const step of plan.steps.filter((entry) => entry.stage === "stop")) {
      if (step.kind === "command") await runCommandStep(step, dependencies);
      else if (step.kind === "end-runners") endedProcesses.push(...(await endRunners(step.runnerPath, dependencies)));
    }
    const stopped = await waitUntil(
      dependencies,
      async () =>
        endedProcesses.every((pid) => !dependencies.isProcessAlive(pid)) && (await dependencies.isPortFree(plan.port)),
    );
    if (!stopped) return { outcome: "still-running", port: plan.port };
    for (const step of plan.steps.filter((entry) => entry.stage === "remove")) {
      if (step.kind === "command") await runCommandStep(step, dependencies);
      else if (step.kind === "remove-definition") await removeDefinition(plan, step.path, dependencies);
      removed = true;
    }
  } catch (error) {
    const failure =
      error instanceof StepFailure ? error : new StepFailure("unknown", error instanceof Error ? error.name : "error");
    return { outcome: "failed", step: failure.step, detail: failure.message, removed };
  }
  const after = await dependencies.detect();
  if (after.kind !== "none") {
    return { outcome: "failed", step: "verify", detail: "the old service is still registered", removed };
  }
  return { outcome: "disabled", endedProcesses: endedProcesses.length };
}

async function runCommandStep(
  step: Extract<LegacyDisableStep, { kind: "command" }>,
  dependencies: LegacyDisableDependencies,
): Promise<void> {
  const name = `${path.win32.basename(step.run.command)} ${step.run.args[0] ?? ""}`.trim();
  let code: number;
  try {
    code = (await dependencies.runCommand(step.run.command, [...step.run.args])).code;
  } catch (error) {
    code = -1;
    if (!step.tolerateFailure) throw new StepFailure(name, error instanceof Error ? error.name : "error");
  }
  if (code !== 0 && !step.tolerateFailure) throw new StepFailure(name, `exit code ${code}`);
}

/** Windows: end each process tree that runs this checkout's runner. Returns the ids it asked to end. */
async function endRunners(runnerPath: string, dependencies: LegacyDisableDependencies): Promise<number[]> {
  const listed = await dependencies.runCommand(windowsPowerShell(dependencies.environment), [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    WINDOWS_NODE_PROCESSES_SCRIPT,
  ]);
  const processes = listed.code === 0 ? parseWindowsNodeProcesses(listed.stdout) : null;
  // Without the list nothing can be proven stopped: refuse rather than guess, and keep the registration.
  if (!processes) throw new StepFailure("list-runners", `exit code ${listed.code}`);
  const taskkill = windowsSystemTool("taskkill.exe", dependencies.environment);
  const ids = processes.filter((entry) => matchesLegacyRunner(entry.commandLine, runnerPath)).map((entry) => entry.pid);
  for (const pid of ids) {
    // An already-exited runner makes taskkill fail; the wait below is what proves the trees are gone.
    await dependencies.runCommand(taskkill, ["/PID", String(pid), "/T", "/F"]).catch(() => undefined);
  }
  return ids;
}

/** Remove the definition only while it is still the regular file with the planned digest (never through a link). */
async function removeDefinition(
  plan: LegacyDisablePlan,
  file: string,
  dependencies: LegacyDisableDependencies,
): Promise<void> {
  const stats = await dependencies.lstat(file);
  // schtasks /Delete or launchctl may already have left it as the only remnant; gone is what we want.
  if (stats === null) return;
  if (!stats.isFile || stats.isSymbolicLink) throw new StepFailure("remove-definition", "not a regular file");
  const digest = legacyDefinitionDigest(decodeLegacyDefinition(await dependencies.readDefinition(file)));
  if (digest !== plan.definitionDigest) throw new StepFailure("remove-definition", "the definition changed");
  await dependencies.unlink(file);
}

/** The real file-system side of {@link LegacyDisableDependencies}. */
export const legacyDisableFileSystem: Pick<LegacyDisableDependencies, "readDefinition" | "lstat" | "unlink"> = {
  readDefinition: (file) => readFile(file),
  lstat: async (file) => {
    try {
      const stats = await lstat(file);
      return { isFile: stats.isFile(), isSymbolicLink: stats.isSymbolicLink() };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
  unlink: (file) => unlink(file),
};
