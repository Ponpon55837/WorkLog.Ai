import { stat, statfs } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { dialog } from "electron";
import {
  removeCreatedDatabase,
  runCopyToLocal,
  setupMessages,
  writeDesktopSettingsAtomic,
  type BackendSupervisor,
  type RepairActionResult,
} from "@work-intelligence/desktop-core";
import type { BackendController } from "./backend.js";
import type { Logger } from "./log.js";
import type { RepairInfo } from "./repair-info.js";
import type { RepairSuccess } from "./repair-success.js";
import type { RepairWindow } from "./repair-window.js";
import { defaultSettings } from "./settings.js";
import type { ShellState } from "./state.js";
import type { DesktopPaths } from "./config.js";

export interface LocalCopyOptions {
  readonly state: ShellState;
  readonly paths: DesktopPaths;
  readonly window: RepairWindow;
  readonly info: RepairInfo;
  readonly backend: BackendController;
  readonly supervisor: BackendSupervisor;
  readonly success: RepairSuccess;
  readonly prepareRuntime: () => Promise<unknown>;
  /** A test build answers the native confirmation itself (the switch `autoConfirmCopy`). */
  readonly autoConfirm: boolean;
  readonly log: Logger;
}

const COPY_BASE_NAME = "work-intelligence-local";

/** A file name beside the App's default database that nothing uses yet; an existing file is never a target. */
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

/**
 * 「複製到本機磁碟並改用」 (DT-08) for the repair page: the source is a browsed candidate, or (no id) the App's own database.
 * The pure sequence is `runCopyToLocal`; this supplies the Electron and file-system effects.
 */
export function createLocalCopy(
  options: LocalCopyOptions,
): (candidateId: string | undefined) => Promise<RepairActionResult> {
  const { state, paths, window, info, backend, supervisor, success, log } = options;
  return async (candidateId) => {
    const text = setupMessages(state.locale);
    const source = candidateId === undefined ? state.databasePath() : (state.candidates.get(candidateId)?.path ?? null);
    if (source === null) return { ok: false, reason: "invalid" };
    const directory = dirname(defaultSettings().desired.databasePath);
    const opensAtStart = success.opens();
    // A pending automatic retry must not start the old database while the copy runs.
    backend.recovery.cancel();
    const result = await runCopyToLocal({
      confirm: async () => {
        if (options.autoConfirm) return true;
        const owner = window.window();
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
        const copied = await supervisor.copyDatabase(source, target);
        // A preview child that could not run is a failed copy; its detail stays out of the page.
        return copied.outcome === "checked" ? copied.result : { type: "copy-result", status: "failed" };
      },
      switchTo: async (target, identity) => {
        const outcome = await backend.start("change-db", {
          databasePath: target,
          expectedIdentity: identity,
          // The copy is local, and the click was the consent to update it.
          allowSchemaMigration: true,
        });
        if (outcome.ok && state.settings) await writeDesktopSettingsAtomic(paths.settingsFile, state.settings);
        return outcome;
      },
      removeCopy: (target, identity) => {
        removeCreatedDatabase(target, identity, []);
      },
      log,
    });
    if (result.ok) {
      if (candidateId !== undefined) state.candidates.remove(candidateId);
      success.finish({ ok: true }, opensAtStart);
      return { ok: true, state: await info.snapshot() };
    }
    if (result.reason !== "failed") return { ok: false, reason: result.reason };
    return { ok: false, reason: "failed", errorCode: result.errorCode, message: text.copyErrors[result.failure] };
  };
}
