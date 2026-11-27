import { randomUUID } from "node:crypto";
import { stat, statfs } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { dialog } from "electron";
import {
  COPY_PATH_DETAIL,
  errorMessageFor,
  isPositiveRisk,
  removeCreatedDatabase,
  runCopyToLocal,
  setupMessages,
  shellMessages,
  type BackendSupervisor,
  type CopyToLocalResult,
  type OperationJournal,
  type RepairActionResult,
  type RestartOutcome,
} from "@work-intelligence/desktop-core";
import type { DesktopDatabaseIdentity } from "@work-intelligence/schema";
import type { BackendController } from "./backend.js";
import type { Logger } from "./log.js";
import type { RepairInfo } from "./repair-info.js";
import type { RepairSuccess } from "./repair-success.js";
import type { StorageRiskService } from "./storage-risk.js";
import type { RepairWindow } from "./repair-window.js";
import { defaultSettings } from "./settings.js";
import type { ShellState } from "./state.js";
import type { DesktopPaths } from "./config.js";

export interface CopyRunnerOptions {
  readonly state: ShellState;
  readonly window: RepairWindow;
  readonly backend: BackendController;
  readonly supervisor: BackendSupervisor;
  readonly storage: StorageRiskService;
  readonly prepareRuntime: () => Promise<unknown>;
  readonly autoConfirm: boolean;
  readonly journal: OperationJournal;
  readonly log: Logger;
}

export interface LocalCopyOptions {
  readonly state: ShellState;
  readonly paths: DesktopPaths;
  readonly info: RepairInfo;
  readonly backend: BackendController;
  readonly supervisor: BackendSupervisor;
  readonly success: RepairSuccess;
  readonly runner: CopyRunner;
  readonly stopForCopy: () => Promise<boolean>;
  readonly log: Logger;
}

export type CopySwitch = (target: string, identity: DesktopDatabaseIdentity) => Promise<RestartOutcome>;

export type CopyRunner = (
  source: string,
  switchTo: CopySwitch,
  beforeCopy?: () => Promise<void>,
) => Promise<CopyToLocalResult>;

const COPY_BASE_NAME = "work-intelligence-local";

/** @internal test-only */
export function uniqueCopyTarget(directory: string, exists: (path: string) => boolean = existsSync): string {
  for (let index = 1; ; index += 1) {
    const name = index === 1 ? `${COPY_BASE_NAME}.sqlite` : `${COPY_BASE_NAME}-${index}.sqlite`;
    const candidate = join(directory, name);
    if (!exists(candidate) && !exists(`${candidate}-wal`) && !exists(`${candidate}-shm`)) return candidate;
  }
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/** How often a failed close of the copy's journal record is tried. */
const FINISH_ATTEMPTS = 3;

/** The copy sequence with its Electron and file-system effects (confirmation, sizes, free space, the child that copies). */
export function createCopyRunner(options: CopyRunnerOptions): CopyRunner {
  const { state, backend, supervisor, storage, journal, log } = options;
  const directory = dirname(defaultSettings().desired.databasePath);
  return async (source, switchTo, beforeCopy) => {
    const text = setupMessages(state.locale);
    /** The journal record of this copy, written before the first byte is copied (L-10). */
    let copyOperationId: string | null = null;
    const result = await runCopyToLocal({
      // A copy made beside a risk is no safer than the original: the target folder is classified, and none/unknown go on.
      targetFolderRisky: async () => isPositiveRisk((await storage.classify(uniqueCopyTarget(directory))).risk),
      confirm: async () => {
        const confirmed = await confirmCopy(options, text);
        // Only a confirmed copy takes over: a cancelled dialog leaves a pending automatic retry alone. While the copy
        // runs, that retry must not start the old database.
        if (confirmed) backend.recovery.cancel();
        return confirmed;
      },
      sourceBytes: async () => ({ database: await sizeOf(source), wal: await sizeOf(`${source}-wal`) }),
      freeBytes: async () => {
        try {
          const { bavail, bsize } = await statfs(directory);
          return Number(bavail) * Number(bsize);
        } catch {
          // The volume of a folder that does not exist yet is the nearest existing parent's; the copy tries anyway.
          return undefined;
        }
      },
      chooseTarget: async () => uniqueCopyTarget(directory),
      prepareRuntime: options.prepareRuntime,
      copyDatabase: async (target) => {
        // Journaled first: a crash from here until the settings name the copy leaves a record, and the next start deletes the
        // orphan copy (recovery checks the path is a copy file inside the App's own folder). A journal that cannot be
        // written fails the copy before anything is copied.
        copyOperationId = randomUUID();
        await journal.begin({
          operationId: copyOperationId,
          kind: "change-db",
          previousOwner: state.owner,
          details: { [COPY_PATH_DETAIL]: target },
        });
        try {
          await beforeCopy?.();
        } catch {
          return { type: "copy-result", status: "failed" };
        }
        const copied = await supervisor.copyDatabase(source, target);
        // A preview child that could not run is a failed copy; its detail stays out of the page.
        return copied.outcome === "checked" ? copied.result : { type: "copy-result", status: "failed" };
      },
      switchTo,
      removeCopy: (target, identity) => {
        removeCreatedDatabase(target, identity, []);
      },
      log,
    });
    const closing: string | null = copyOperationId;
    if (closing !== null) {
      // The copy is either the database now (the settings were written by `switchTo`) or already removed by the sequence.
      // A record left open would later be read as an orphan copy, so a failed close is tried again before it is given up.
      let closedRecord = false;
      for (let attempt = 1; attempt <= FINISH_ATTEMPTS && !closedRecord; attempt += 1) {
        try {
          await journal.finish(
            closing,
            result.ok ? "completed" : "failed",
            result.ok ? {} : { error: "the copy was not switched to" },
          );
          closedRecord = true;
        } catch (error) {
          log(
            `[shell] copy to local disk: the journal record was not closed, attempt ${attempt} (${error instanceof Error ? error.name : "unknown error"})`,
          );
        }
      }
    }
    return result;
  };
}

async function confirmCopy(options: CopyRunnerOptions, text: ReturnType<typeof setupMessages>): Promise<boolean> {
  if (options.autoConfirm) return true;
  const owner = options.window.window();
  const box = {
    type: "question" as const,
    message: text.copyConfirmMessage,
    detail: text.copyConfirmDetail,
    buttons: [text.copyConfirmYes, text.copyConfirmNo],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const { response } = owner ? await dialog.showMessageBox(owner, box) : await dialog.showMessageBox(box);
  return response === 0;
}

/**
 * 「複製到本機磁碟並改用」 (DT-08) for the repair page: the source is a browsed candidate, or (no id) the App's own database.
 */
export function createLocalCopy(
  options: LocalCopyOptions,
): (candidateId: string | undefined) => Promise<RepairActionResult> {
  const { state, paths, info, backend, supervisor, success, log } = options;
  const run = options.runner;
  /** The backend served before the copy and does not now: a failed or refused copy must not leave the App without it. */
  let wasRunning = false;

  async function restorePrevious(): Promise<boolean> {
    if (!wasRunning || supervisor.running !== undefined) return false;
    const restored = await backend.start("restart").catch(() => ({ ok: false as const, code: "REPAIR_REQUIRED" }));
    if (restored.ok) backend.presenter().clear();
    return restored.ok;
  }

  return async (candidateId) => {
    const text = setupMessages(state.locale);
    const source = candidateId === undefined ? state.databasePath() : (state.candidates.get(candidateId)?.path ?? null);
    if (source === null) return { ok: false, reason: "invalid" };
    const opensAtStart = success.opens();
    wasRunning = supervisor.running !== undefined;
    // The App's own database is copied with its backend stopped, so nothing written after the snapshot is left out.
    const copiesServingDatabase = candidateId === undefined && wasRunning;
    const result = await run(
      source,
      async (target, identity) => {
        const outcome = await backend.start("change-db", {
          databasePath: target,
          expectedIdentity: identity,
          // The copy is local, and the click was the consent to update it.
          allowSchemaMigration: true,
        });
        if (outcome.ok) await state.updateSettings(paths.settingsFile, (current) => current);
        return outcome;
      },
      async () => {
        if (copiesServingDatabase && !(await options.stopForCopy()))
          throw new Error("the backend could not be stopped");
      },
    );
    if (result.ok) {
      if (candidateId !== undefined) state.candidates.remove(candidateId);
      success.finish({ ok: true }, opensAtStart);
      return { ok: true, state: await info.snapshot() };
    }
    if (result.reason !== "failed") {
      await restorePrevious();
      return { ok: false, reason: result.reason };
    }
    if (result.backendCode === undefined) {
      await restorePrevious();
      return { ok: false, reason: "failed", errorCode: result.errorCode, message: text.copyErrors[result.failure] };
    }
    // The start on the copy failed: its real code is recorded and shown, as for a failed 「改用這個資料庫」, together with
    // the reassurance that the settings and the original are unchanged.
    success.finish({ ok: false, code: result.backendCode }, opensAtStart);
    const message = `${errorMessageFor(shellMessages(state.locale), result.backendCode).title} ${text.copyErrors["start-failed"]}`;
    // The failed switch stopped a backend that was serving: it serves its own database again, if it can.
    if (await restorePrevious()) {
      log("[shell] copy to local disk: the previous database is serving again");
      return { ok: false, reason: "failed", errorCode: result.backendCode, message };
    }
    backend.presenter().present(result.backendCode);
    return { ok: false, reason: "failed", errorCode: result.backendCode, message };
  };
}
