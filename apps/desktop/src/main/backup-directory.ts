import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  backupDirectoryVerdict,
  busyDetailOf,
  displayPath,
  type BackendSupervisor,
  type BackupDirectoryChooseResult,
  type OperationCoordinator,
  type RepairBackupDirectorySection,
  type RestartOutcome,
  type StorageRiskResult,
} from "@work-intelligence/desktop-core";
import type { BackendController } from "./backend.js";
import type { DesktopPaths } from "./config.js";
import type { Logger } from "./log.js";
import type { ShellState } from "./state.js";

export interface BackupDirectoryOptions {
  readonly state: ShellState;
  readonly paths: Pick<DesktopPaths, "settingsFile">;
  readonly coordinator: Pick<OperationCoordinator, "current">;
  readonly supervisor: Pick<BackendSupervisor, "running" | "queryActivity">;
  readonly backend: Pick<BackendController, "start" | "presenter" | "recovery">;
  /** The storage verdict of a folder (the same classifier the database uses). */
  readonly classify: (folder: string) => Promise<Pick<StorageRiskResult, "risk">>;
  /** The native folder dialog; the path, or null when cancelled. */
  readonly chooseFolder: () => Promise<string | null>;
  /** The native question about a folder on risky storage; true: use it anyway. */
  readonly confirmRisk: (risk: Exclude<StorageRiskResult["risk"], "none">) => Promise<boolean>;
  /** Writes and removes a file in the folder; false when that is not possible. Injectable for tests. */
  readonly probeWritable?: (folder: string) => Promise<boolean>;
  readonly homeDirectory: string;
  readonly platform?: NodeJS.Platform;
  /** The folder the "last backup" is read from changed. */
  readonly backupsChanged: () => void;
  readonly log: Logger;
}

export interface BackupDirectoryController {
  section(): RepairBackupDirectorySection | undefined;
  choose(): Promise<BackupDirectoryChooseResult>;
}

/**
 * A file written and removed again proves the App can put a backup there; a folder that only looks writable does not. It
 * creates nothing but the probe file (a folder that does not exist is not writable), and it runs only after the storage
 * verdict allowed the folder, so a refused location is never touched.
 */
async function writableFolder(folder: string): Promise<boolean> {
  const probe = join(folder, `.work-intelligence-write-test-${randomUUID()}`);
  try {
    await writeFile(probe, "", { flag: "wx" });
    await unlink(probe);
    return true;
  } catch {
    await unlink(probe).catch(() => undefined);
    return false;
  }
}

/**
 * 「更換備份位置」 (Settings tab). The page sends nothing; main opens the native folder dialog and reads every path. Order:
 * choose, classify its storage (a network drive is refused, an external, cloud-synced or hard-linked folder needs a yes),
 * prove the folder writable (only now: a refused location is never written to), refuse while the service does work that a restart would cut short, write the settings,
 * restart the service so it uses the folder, and put the old folder back if that restart fails. Backups made before are
 * never moved or deleted.
 */
export function createBackupDirectory(options: BackupDirectoryOptions): BackupDirectoryController {
  const { state, paths, coordinator, supervisor, backend, log } = options;
  const platform = options.platform ?? process.platform;
  const probeWritable = options.probeWritable ?? writableFolder;

  async function setFolder(folder: string): Promise<void> {
    await state.updateSettings(paths.settingsFile, (current) =>
      current.desired.backupDirectory === folder
        ? null
        : { ...current, desired: { ...current.desired, backupDirectory: folder } },
    );
  }

  /** The service reads the folder when it starts: restart it, or put the old folder back. */
  async function restartOn(previous: string): Promise<BackupDirectoryChooseResult | null> {
    if (supervisor.running === undefined) return null;
    backend.recovery.cancel();
    const restarted = await backend
      .start("restart")
      .catch((): RestartOutcome => ({ ok: false, code: "REPAIR_REQUIRED" }));
    if (restarted.ok) return null;
    const restored = await setFolder(previous).then(
      () => true,
      () => false,
    );
    if (!restored) {
      // The settings still name the new folder: saying "not changed", or starting again as if it were the old one, would be false.
      log("[shell] backup folder not restored");
      if (restarted.busy)
        return { ok: false, reason: "not-restored", backendRunning: supervisor.running !== undefined };
      backend.recovery.handleFailure(restarted.code);
      return { ok: false, reason: "not-restored", backendRunning: false };
    }
    if (restarted.busy) return { ok: false, reason: "busy", busy: { source: "unknown" } };
    log(`[shell] restart after the backup folder change failed (${restarted.code})`);
    const again = await backend.start("restart").catch((): RestartOutcome => ({ ok: false, code: "REPAIR_REQUIRED" }));
    if (again.ok) {
      backend.presenter().clear();
      return { ok: false, reason: "failed", backendRunning: true };
    }
    if (!again.busy) backend.recovery.handleFailure(again.code);
    return { ok: false, reason: "start-failed", backendRunning: false };
  }

  return {
    section() {
      const folder = state.backupDirectory();
      return folder === null ? undefined : { display: displayPath(folder, options.homeDirectory, platform) };
    },
    async choose() {
      const previous = state.backupDirectory();
      if (previous === null) return { ok: false, reason: "no-settings" };
      const activity = supervisor.running === undefined ? null : await supervisor.queryActivity();
      const busy = busyDetailOf({ current: coordinator.current(), pageAction: false, activity });
      if (busy) return { ok: false, reason: "busy", busy };
      const folder = await options.chooseFolder();
      if (folder === null) return { ok: false, reason: "cancelled" };
      if (!isAbsolute(folder)) return { ok: false, reason: "not-writable" };
      const { risk } = await options.classify(folder);
      const verdict = backupDirectoryVerdict(risk);
      if (verdict === "refuse" && risk !== "none") return { ok: false, reason: "refused", risk };
      if (verdict === "confirm" && risk !== "none" && !(await options.confirmRisk(risk))) {
        return { ok: false, reason: "declined", risk };
      }
      if (!(await probeWritable(folder))) return { ok: false, reason: "not-writable" };
      // Something may have started while the dialogs were open.
      const late = busyDetailOf({
        current: coordinator.current(),
        pageAction: false,
        activity: supervisor.running === undefined ? null : await supervisor.queryActivity(),
      });
      if (late) return { ok: false, reason: "busy", busy: late };
      try {
        await setFolder(folder);
      } catch (error) {
        log(`[shell] backup folder not saved: ${error instanceof Error ? error.name : "unknown"}`);
        return { ok: false, reason: "failed" };
      }
      const failed = await restartOn(previous);
      if (failed) return failed;
      options.backupsChanged();
      state.touch();
      log("[shell] backup folder changed");
      return { ok: true, display: displayPath(folder, options.homeDirectory, platform), existingBackupsStayed: true };
    },
  };
}
