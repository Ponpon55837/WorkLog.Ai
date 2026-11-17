import { writeFile } from "node:fs/promises";
import { dialog, ipcMain, shell } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import {
  isTrustedRepairSender,
  previewToCandidate,
  REPAIR_CHANNELS,
  repairInputSchemas,
  writeDesktopSettingsAtomic,
  type BackendSupervisor,
  type RepairActionResult,
} from "@work-intelligence/desktop-core";
import type { BackendController } from "./backend.js";
import type { DesktopPaths } from "./config.js";
import type { Logger } from "./log.js";
import type { RepairInfo } from "./repair-info.js";
import type { RepairSuccess } from "./repair-success.js";
import type { RepairWindow } from "./repair-window.js";
import type { ShellState } from "./state.js";

interface Parser<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

export interface IpcOptions {
  readonly state: ShellState;
  readonly paths: DesktopPaths;
  readonly window: RepairWindow;
  readonly info: RepairInfo;
  readonly backend: BackendController;
  readonly supervisor: BackendSupervisor;
  readonly success: RepairSuccess;
  readonly log: Logger;
}

const parser =
  <T>(schema: Parser<T>) =>
  (raw: unknown) =>
    schema.safeParse(raw);

export function registerRepairIpc(options: IpcOptions): void {
  const { state, paths, window, info, backend, supervisor, success, log } = options;

  function isTrusted(event: IpcMainInvokeEvent): boolean {
    const frame = event.senderFrame;
    return isTrustedRepairSender({
      frameUrl: frame?.url ?? "",
      isMainFrame: frame !== null && frame !== undefined && frame.parent === null,
      fromRepairWindow: window.contents() !== null && event.sender === window.contents(),
    });
  }

  /** Registers a channel: the sender is checked first, then the input is parsed; only then does the handler run. */
  function handle<T>(
    channel: string,
    parse: (raw: unknown) => { success: true; data: T } | { success: false },
    run: (input: T) => Promise<unknown>,
  ): void {
    ipcMain.handle(channel, async (event, raw: unknown) => {
      if (!isTrusted(event)) throw new Error("untrusted sender");
      const parsed = parse(raw);
      if (!parsed.success) return { ok: false, reason: "invalid" };
      return run(parsed.data);
    });
  }

  async function withBusy(task: () => Promise<RepairActionResult>): Promise<RepairActionResult> {
    if (state.busy) return { ok: false, reason: "busy" };
    state.busy = true;
    try {
      return await task();
    } catch (error) {
      log(`[shell] repair action failed: ${error instanceof Error ? error.message : "unknown error"}`);
      return { ok: false, reason: "failed" };
    } finally {
      state.busy = false;
    }
  }

  ipcMain.handle(REPAIR_CHANNELS.getState, async (event, raw: unknown) => {
    if (!isTrusted(event) || !repairInputSchemas.getState.safeParse(raw).success) throw new Error("untrusted sender");
    return info.snapshot();
  });

  handle(REPAIR_CHANNELS.retryStart, parser(repairInputSchemas.retryStart), ({ operationId }) =>
    withBusy(async () => {
      if (!state.retryIds.consume(operationId)) return { ok: false, reason: "invalid" };
      const opensAtStart = success.opens();
      const outcome = await backend.recovery.retryNow(operationId);
      success.finish(outcome, opensAtStart);
      if (outcome.ok) return { ok: true, state: await info.snapshot() };
      // A restart already running is not an error: the page shows "restarting" and polls.
      if (outcome.busy) return { ok: false, reason: "busy" };
      return { ok: false, reason: "failed", errorCode: outcome.code };
    }),
  );

  handle(REPAIR_CHANNELS.chooseDatabase, parser(repairInputSchemas.chooseDatabase), () =>
    withBusy(async () => {
      const owner = window.window();
      if (!owner) return { ok: false, reason: "failed" };
      const picked = await dialog.showOpenDialog(owner, {
        properties: ["openFile"],
        filters: [{ name: "SQLite", extensions: ["sqlite", "sqlite3", "db"] }],
      });
      const file = picked.filePaths[0];
      if (picked.canceled || !file) return { ok: false, reason: "cancelled" };
      const id = state.candidates.add(file);
      // A read-only look by a separate short-lived child: nothing is written and the running backend is untouched.
      state.candidates.setPreview(id, previewToCandidate(await supervisor.preview(file)));
      return { ok: true, state: await info.snapshot() };
    }),
  );

  handle(
    REPAIR_CHANNELS.confirmDatabase,
    parser(repairInputSchemas.confirmDatabase),
    ({ candidateId, allowMigration }) =>
      withBusy(async () => {
        const check = state.candidates.checkConfirm(candidateId, allowMigration === true);
        if (!check.ok) return { ok: false, reason: "invalid" };
        // A pending automatic retry must not start the old database while the user's choice runs.
        backend.recovery.cancel();
        const opensAtStart = success.opens();
        const outcome = await backend.start("change-db", {
          databasePath: check.entry.path,
          expectedIdentity: check.identity,
          allowSchemaMigration: check.preview.needsMigration,
        });
        if (!outcome.ok) {
          if (outcome.busy) return { ok: false, reason: "busy" };
          success.finish(outcome, opensAtStart);
          backend.presenter().present(outcome.code);
          return { ok: false, reason: "failed", errorCode: outcome.code };
        }
        state.candidates.remove(candidateId);
        if (state.settings) await writeDesktopSettingsAtomic(paths.settingsFile, state.settings);
        success.finish(outcome, opensAtStart);
        return { ok: true, state: await info.snapshot() };
      }),
  );

  handle(REPAIR_CHANNELS.openFolder, parser(repairInputSchemas.openFolder), async ({ target }) => {
    const directory = await info.folderFor(target);
    if (!directory) return { ok: false };
    return { ok: (await shell.openPath(directory)) === "" };
  });

  handle(REPAIR_CHANNELS.exportDiagnostics, parser(repairInputSchemas.exportDiagnostics), async () => {
    const owner = window.window();
    if (!owner) return { ok: false, reason: "failed" };
    const chosen = await dialog.showSaveDialog(owner, {
      defaultPath: "work-intelligence-diagnostics.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (chosen.canceled || !chosen.filePath) return { ok: false, reason: "cancelled" };
    try {
      await writeFile(chosen.filePath, await info.diagnosticsText(), { mode: 0o600 });
      return { ok: true };
    } catch {
      return { ok: false, reason: "failed" };
    }
  });
}
