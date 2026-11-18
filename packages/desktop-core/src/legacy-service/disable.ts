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
 * Windows: every process with its parent and command line, as base64 of the UTF-8 JSON so a non-ASCII checkout path
 * survives any console code page. The runner match ({@link matchesLegacyRunner}) and the tree walk happen in TypeScript,
 * never in PowerShell.
 */
const WINDOWS_PROCESSES_SCRIPT =
  "$p = @(Get-CimInstance Win32_Process | ForEach-Object { [ordered]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; name = [string]$_.Name; commandLine = [string]$_.CommandLine } }); " +
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
      /**
       * A read-only check that must fail: exit code 0 means the old service is still loaded or enabled (a tolerated stop
       * command did not work), so nothing may be removed.
       */
      readonly mustFail?: true;
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
        {
          kind: "command",
          stage: "stop",
          run: { command: "launchctl", args: ["print", launchdTarget(options.uid)] },
          tolerateFailure: false,
          mustFail: true,
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
        {
          kind: "command",
          stage: "stop",
          run: { command: "systemctl", args: ["--user", "is-enabled", LEGACY_SYSTEMD_UNIT] },
          tolerateFailure: false,
          mustFail: true,
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

/**
 * The plain-language sentences of 「詳細步驟」, in the user's language; `{name}` is a task or service name, `{path}` a
 * file path. The preview never shows the commands the steps run.
 */
export interface LegacyDisableStepText {
  /** Windows: stop the scheduled task `{name}`. */
  readonly stopTask: string;
  /** Windows: remove the scheduled task `{name}`. */
  readonly removeTask: string;
  readonly endRunners: string;
  /** macOS and Linux: stop the old service `{name}` and take it out of the login items. */
  readonly stopService: string;
  /** The read-only check that the old service is no longer loaded or enabled. */
  readonly checkStopped: string;
  /** Linux: let the system read its service list again. */
  readonly refreshService: string;
  readonly deleteFile: string;
  readonly other: string;
}

function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

function commandSentence(step: Extract<LegacyDisableStep, { kind: "command" }>, text: LegacyDisableStepText): string {
  const tool = path.win32.basename(step.run.command).toLowerCase();
  const first = step.run.args[0];
  if (tool === "schtasks.exe" || tool === "schtasks") {
    const name = legacyWindowsTaskTarget().replace(/^\\+/, "");
    if (first === "/End") return fill(text.stopTask, { name });
    if (first === "/Delete") return fill(text.removeTask, { name });
  } else if (tool === "launchctl") {
    if (first === "bootout") return fill(text.stopService, { name: LEGACY_LAUNCHD_LABEL });
    if (first === "print") return text.checkStopped;
  } else if (tool === "systemctl") {
    if (step.run.args.includes("disable")) return fill(text.stopService, { name: LEGACY_SYSTEMD_UNIT });
    if (step.run.args.includes("is-enabled")) return text.checkStopped;
    if (step.run.args.includes("daemon-reload")) return text.refreshService;
  }
  return text.other;
}

/** One plain sentence per step for 「詳細步驟」; execution never reads these. */
export function describeLegacyDisableSteps(plan: LegacyDisablePlan, text: LegacyDisableStepText): string[] {
  return plan.steps.map((step) => {
    if (step.kind === "command") return commandSentence(step, text);
    if (step.kind === "end-runners") return text.endRunners;
    return fill(text.deleteFile, { path: step.path });
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

/** One row of the Windows process list. */
export interface WindowsProcessEntry {
  readonly pid: number;
  readonly parentPid: number;
  readonly name: string;
  readonly commandLine: string;
}

/** Parses the base64 JSON {@link WINDOWS_PROCESSES_SCRIPT} prints; null when it is anything else. */
export function parseWindowsProcesses(stdout: string): WindowsProcessEntry[] | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(stdout.trim(), "base64")
        .toString("utf8")
        .replace(/^\uFEFF/, ""),
    ) as unknown;
    const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? [parsed] : null;
    if (!list) return null;
    return list.flatMap((entry: unknown) => {
      const { pid, parentPid, name, commandLine } = (entry ?? {}) as Record<string, unknown>;
      if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return [];
      return [
        {
          pid: pid as number,
          parentPid: Number.isSafeInteger(parentPid) ? (parentPid as number) : 0,
          name: typeof name === "string" ? name : "",
          commandLine: typeof commandLine === "string" ? commandLine : "",
        },
      ];
    });
  } catch {
    return null;
  }
}

/**
 * DT-13: the node.exe processes that run exactly this checkout's runner, and every descendant of theirs (pnpm, the old
 * server, conhost), found by walking parent ids. `taskkill /T` ends the roots' trees; the disable then waits until every
 * member is gone. The disable ends no member by its own pid: only the roots, whose command line names this checkout's
 * runner, are passed to `taskkill`. A parent id Windows reused can make the wait here run out (and nothing is removed).
 * Known limit: `taskkill /T` walks parent ids itself, so a process whose original parent has exited and whose parent id
 * Windows then gave to a runner would be ended with that runner's tree.
 */
export function legacyRunnerTrees(
  processes: readonly WindowsProcessEntry[],
  runnerPath: string,
): { roots: number[]; members: number[] } {
  const roots = processes
    .filter((entry) => entry.name.toLowerCase() === "node.exe" && matchesLegacyRunner(entry.commandLine, runnerPath))
    .map((entry) => entry.pid);
  const children = new Map<number, number[]>();
  for (const entry of processes) {
    if (entry.parentPid === entry.pid) continue;
    children.set(entry.parentPid, [...(children.get(entry.parentPid) ?? []), entry.pid]);
  }
  const members = new Set<number>();
  const queue = [...roots];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (members.has(pid)) continue;
    members.add(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return { roots, members: [...members] };
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
  /**
   * A step failed; `removed` says whether any part of the registration was already removed, `stopAttempted` whether a
   * stop step had already run (the old backend may have been ended in the middle of a write).
   */
  | {
      readonly outcome: "failed";
      readonly step: string;
      readonly detail: string;
      readonly removed: boolean;
      readonly stopAttempted: boolean;
    };

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
  let stopAttempted = false;
  try {
    for (const step of plan.steps.filter((entry) => entry.stage === "stop")) {
      stopAttempted = true;
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
    return { outcome: "failed", step: failure.step, detail: failure.message, removed, stopAttempted };
  }
  const after = await dependencies.detect();
  if (after.kind !== "none") {
    return {
      outcome: "failed",
      step: "verify",
      detail: "the old service is still registered",
      removed,
      stopAttempted,
    };
  }
  return { outcome: "disabled", endedProcesses: endedProcesses.length };
}

async function runCommandStep(
  step: Extract<LegacyDisableStep, { kind: "command" }>,
  dependencies: LegacyDisableDependencies,
): Promise<void> {
  const name = `${path.win32.basename(step.run.command)} ${step.run.args[0] ?? ""}`.trim();
  if (step.mustFail) {
    // Thrown or non-zero both mean "not loaded / not enabled": only a clean exit proves the service is still there.
    const result = await dependencies.runCommand(step.run.command, [...step.run.args]).catch(() => ({ code: -1 }));
    if (result.code === 0) throw new StepFailure(name, "the old service is still loaded or enabled");
    return;
  }
  let code: number;
  try {
    code = (await dependencies.runCommand(step.run.command, [...step.run.args])).code;
  } catch (error) {
    code = -1;
    if (!step.tolerateFailure) throw new StepFailure(name, error instanceof Error ? error.name : "error");
  }
  if (code !== 0 && !step.tolerateFailure) throw new StepFailure(name, `exit code ${code}`);
}

async function listWindowsProcesses(
  dependencies: Pick<LegacyDisableDependencies, "runCommand" | "environment">,
): Promise<{ processes: WindowsProcessEntry[] | null; code: number }> {
  const listed = await dependencies.runCommand(windowsPowerShell(dependencies.environment), [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    WINDOWS_PROCESSES_SCRIPT,
  ]);
  return { processes: listed.code === 0 ? parseWindowsProcesses(listed.stdout) : null, code: listed.code };
}

/**
 * Windows, for the preview: how many processes run this checkout's runner right now (a runner started by hand, or left
 * behind, is ended too even when the task reads as stopped). Null when the list could not be read.
 */
export async function countLegacyRunners(
  runnerPath: string,
  dependencies: Pick<LegacyDisableDependencies, "runCommand" | "environment">,
): Promise<number | null> {
  const { processes } = await listWindowsProcesses(dependencies).catch(() => ({ processes: null }));
  return processes ? legacyRunnerTrees(processes, runnerPath).roots.length : null;
}

/** Windows: end each process tree that runs this checkout's runner. Returns every process of those trees (DT-13). */
async function endRunners(runnerPath: string, dependencies: LegacyDisableDependencies): Promise<number[]> {
  const { processes, code } = await listWindowsProcesses(dependencies);
  // Without the list nothing can be proven stopped: refuse rather than guess, and keep the registration.
  if (!processes) throw new StepFailure("list-runners", `exit code ${code}`);
  const taskkill = windowsSystemTool("taskkill.exe", dependencies.environment);
  const { roots, members } = legacyRunnerTrees(processes, runnerPath);
  for (const pid of roots) {
    // An already-exited runner makes taskkill fail; the wait below is what proves the trees are gone.
    await dependencies.runCommand(taskkill, ["/PID", String(pid), "/T", "/F"]).catch(() => undefined);
  }
  return members;
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
