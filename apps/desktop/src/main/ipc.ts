import { clipboard, dialog, ipcMain, shell } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import {
  allowMigrationFor,
  canApplyPreview,
  chosenPathProblem,
  DiagnosticsError,
  DiagnosticsPreviewStore,
  initialTab,
  isTrustedRepairSender,
  REPAIR_CHANNELS,
  repairInputSchemas,
  tabsFor,
  writeDesktopSettingsAtomic,
  writePrivateFile,
  type BackendSupervisor,
  type AppTabSelection,
  type RepairActionResult,
} from "@work-intelligence/desktop-core";
import type { AgentsPage } from "./agents.js";
import { offerCandidate } from "./candidate-offer.js";
import type { StorageRiskService } from "./storage-risk.js";
import type { BackendController } from "./backend.js";
import type { ChangePortController } from "./change-port.js";
import type { FirstRun } from "./first-run.js";
import type { LegacyGuard } from "./legacy.js";
import type { LegacyDisableController } from "./legacy-disable.js";
import type { DesktopPaths } from "./config.js";
import type { Logger } from "./log.js";
import type { RepairInfo } from "./repair-info.js";
import type { RepairSuccess } from "./repair-success.js";
import type { RepairWindow } from "./repair-window.js";
import type { RestoreController } from "./restore.js";
import type { ShellState } from "./state.js";
import type { UpdateController } from "./update-check.js";

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
  readonly firstRun: FirstRun;
  readonly agents: AgentsPage;
  readonly legacy: LegacyGuard;
  readonly legacyDisable: LegacyDisableController;
  readonly changePort: ChangePortController;
  readonly storage: StorageRiskService;
  readonly updates: UpdateController;
  /** 「從備份還原」: the page holds only one-time ids; main keeps every path. */
  readonly restore: RestoreController;
  /** 「複製到本機磁碟並改用」: for a candidate id, or (no id) the App's own database. */
  readonly copyToLocal: (candidateId: string | undefined) => Promise<RepairActionResult>;
  readonly log: Logger;
}

const parser =
  <T>(schema: Parser<T>) =>
  (raw: unknown) =>
    schema.safeParse(raw);

export function registerRepairIpc(options: IpcOptions): void {
  const {
    state,
    paths,
    window,
    info,
    backend,
    supervisor,
    success,
    firstRun,
    agents,
    legacy,
    legacyDisable,
    changePort,
    storage,
    updates,
    restore,
    log,
  } = options;

  /** The diagnostics text the user is reading, kept here (never in the page) until it is saved or expires. */
  const diagnosticPreviews = new DiagnosticsPreviewStore({ clock: Date.now });

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
    run: (input: T, senderId: number) => Promise<unknown>,
  ): void {
    ipcMain.handle(channel, async (event, raw: unknown) => {
      if (!isTrusted(event)) throw new Error("untrusted sender");
      const parsed = parse(raw);
      if (!parsed.success) return { ok: false, reason: "invalid" };
      return run(parsed.data, event.sender.id);
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
      // A network share or device path is refused before any preview touches it (the same rule as the first-run page).
      const problem = chosenPathProblem(file, process.platform, state.locale);
      if (problem) {
        log("[shell] repair refused the chosen database path");
        return { ok: false, reason: "invalid", message: problem };
      }
      // A read-only look by a separate short-lived child, and the storage verdict: nothing is written and the running
      // backend is untouched.
      await offerCandidate({ state, supervisor, storage }, file);
      return { ok: true, state: await info.snapshot() };
    }),
  );

  handle(
    REPAIR_CHANNELS.confirmDatabase,
    parser(repairInputSchemas.confirmDatabase),
    ({ candidateId, allowMigration, acknowledgeStorageRisk }) =>
      withBusy(async () => {
        // Refused storage, an update the storage forbids and a risky file without its ticked consent stop here, in main.
        const check = state.candidates.checkConfirm(
          candidateId,
          allowMigration === true,
          acknowledgeStorageRisk === true,
        );
        if (!check.ok) return { ok: false, reason: "invalid" };
        // A pending automatic retry must not start the old database while the user's choice runs.
        backend.recovery.cancel();
        const opensAtStart = success.opens();
        const outcome = await backend.start("change-db", {
          databasePath: check.entry.path,
          expectedIdentity: check.identity,
          allowSchemaMigration: allowMigrationFor(check.preview.needsMigration, check.entry.storageRisk),
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

  handle(REPAIR_CHANNELS.copyToLocal, parser(repairInputSchemas.copyToLocal), ({ candidateId }) =>
    withBusy(() => options.copyToLocal(candidateId)),
  );

  handle(REPAIR_CHANNELS.openFolder, parser(repairInputSchemas.openFolder), async ({ target }) => {
    const directory = await info.folderFor(target);
    if (!directory) return { ok: false };
    return { ok: (await shell.openPath(directory)) === "" };
  });

  handle(
    REPAIR_CHANNELS.previewDiagnostics,
    parser(repairInputSchemas.previewDiagnostics),
    async (_input, senderId) => {
      try {
        const { text, report } = await info.diagnosticsPreview();
        return { ok: true, previewId: diagnosticPreviews.put(senderId, text), text, report };
      } catch (error) {
        return { ok: false, reason: error instanceof DiagnosticsError ? "scan-failed" : "failed" };
      }
    },
  );

  handle(
    REPAIR_CHANNELS.saveDiagnostics,
    parser(repairInputSchemas.saveDiagnostics),
    async ({ previewId }, senderId) => {
      // An unknown, used, expired or foreign id is the same answer; the page previews again.
      const claim = diagnosticPreviews.claim(senderId, previewId);
      if (!claim) return { ok: false, reason: "expired" };
      const owner = window.window();
      if (!owner) {
        claim.release();
        return { ok: false, reason: "failed" };
      }
      try {
        const chosen = await dialog.showSaveDialog(owner, {
          defaultPath: "work-intelligence-diagnostics.json",
          filters: [{ name: "JSON", extensions: ["json"] }],
        });
        if (chosen.canceled || !chosen.filePath) {
          claim.release();
          return { ok: false, reason: "cancelled" };
        }
        // Exactly the previewed bytes: the text is not built again. Owner-only also over an existing file.
        await writePrivateFile(chosen.filePath, claim.bytes);
        return { ok: true };
      } catch {
        // Nothing was saved: the same preview may be tried again.
        claim.release();
        return { ok: false, reason: "failed" };
      }
    },
  );

  handle(REPAIR_CHANNELS.startAnyway, parser(repairInputSchemas.startAnyway), ({ operationId }) =>
    withBusy(async () => {
      const database = state.databasePath();
      if (!database || !state.retryIds.consume(operationId)) return { ok: false, reason: "invalid" };
      // The user said "仍要啟動": this database may start beside the old service until the App quits.
      legacy.allow(database);
      const opensAtStart = success.opens();
      const outcome = await backend.recovery.retryNow(operationId);
      success.finish(outcome, opensAtStart);
      if (outcome.ok) return { ok: true, state: await info.snapshot() };
      if (outcome.busy) return { ok: false, reason: "busy" };
      return { ok: false, reason: "failed", errorCode: outcome.code };
    }),
  );

  ipcMain.handle(REPAIR_CHANNELS.getTab, (event, raw: unknown): AppTabSelection => {
    if (!isTrusted(event) || !repairInputSchemas.getTab.safeParse(raw).success) throw new Error("untrusted sender");
    const tabs = tabsFor(state.needsSetup);
    // The tab main chose may no longer exist (Setup after the first run): the same rule picks another.
    const tab = tabs.includes(state.tab)
      ? state.tab
      : initialTab({ ...info.tabInputs(), remembered: state.tabMemory.recall() });
    return { tab, tabs };
  });

  // The page reports the tab the user selected; main keeps it in memory for this session and answers only yes or no.
  handle(REPAIR_CHANNELS.rememberTab, parser(repairInputSchemas.rememberTab), async ({ tab }) => {
    if (!state.tabMemory.remember(tab, state.needsSetup)) return { ok: false };
    state.tab = tab;
    return { ok: true };
  });

  handle(REPAIR_CHANNELS.copyCommand, parser(repairInputSchemas.copyCommand), async ({ target }) => {
    const detection = legacy.latest();
    if (detection?.kind !== "found") return { ok: false };
    // The text comes from main's own detection, never from the page.
    const text = target === "legacy-remove" ? detection.removeCommand : detection.fallbackRemoveCommand;
    if (!text) return { ok: false };
    clipboard.writeText(text);
    return { ok: true };
  });

  ipcMain.handle(REPAIR_CHANNELS.setupGetState, async (event, raw: unknown) => {
    if (!isTrusted(event) || !repairInputSchemas.setupGetState.safeParse(raw).success) {
      throw new Error("untrusted sender");
    }
    // The first look of the page starts the detection; the page polls while it runs.
    void firstRun.begin();
    return firstRun.snapshot();
  });

  handle(REPAIR_CHANNELS.setupUseDefaults, parser(repairInputSchemas.setupUseDefaults), (input) =>
    firstRun.useDefaults(input.launchAtLogin, input.startAnyway === true),
  );

  handle(REPAIR_CHANNELS.setupUseSource, parser(repairInputSchemas.setupUseSource), (input) =>
    firstRun.useSource(input),
  );

  handle(REPAIR_CHANNELS.setupChooseFile, parser(repairInputSchemas.setupChooseFile), () => firstRun.chooseFile());

  // The same single lock as every other page action: a copy never overlaps a retry, a port change or another start.
  handle(REPAIR_CHANNELS.setupCopyToLocal, parser(repairInputSchemas.setupCopyToLocal), (input) =>
    exclusive({ ok: false, reason: "busy" } as const, () =>
      firstRun.copyToLocal(input.sourceId, input.launchAtLogin === true),
    ),
  );

  handle(REPAIR_CHANNELS.setupLater, parser(repairInputSchemas.setupLater), async () => {
    firstRun.later();
    return { ok: true };
  });

  handle(REPAIR_CHANNELS.showView, parser(repairInputSchemas.showView), async () => {
    window.open("agent");
    return { ok: true };
  });

  ipcMain.handle(REPAIR_CHANNELS.agentsGetState, (event, raw: unknown) => {
    if (!isTrusted(event) || !repairInputSchemas.agentsGetState.safeParse(raw).success) {
      throw new Error("untrusted sender");
    }
    return agents.snapshot();
  });

  handle(REPAIR_CHANNELS.agentsPreview, parser(repairInputSchemas.agentsPreview), ({ adopt }) => agents.preview(adopt));
  handle(
    REPAIR_CHANNELS.agentsApply,
    parser(repairInputSchemas.agentsApply),
    async ({ previewId, acknowledgeUndiffable }) => {
      // A file whose diff was not shown is applied only after the user said so; the page's disabled button is not the guard.
      const shown = agents.snapshot().preview;
      if (shown?.id === previewId && !canApplyPreview(shown, acknowledgeUndiffable === true)) {
        return { ok: false, reason: "invalid", state: agents.snapshot() };
      }
      return agents.apply(previewId);
    },
  );
  handle(REPAIR_CHANNELS.agentsDiscard, parser(repairInputSchemas.agentsDiscard), async () => agents.discard());
  handle(REPAIR_CHANNELS.agentsUndo, parser(repairInputSchemas.agentsUndo), () => agents.undo());
  handle(REPAIR_CHANNELS.agentsSelfTest, parser(repairInputSchemas.agentsSelfTest), () => agents.selfTest());
  handle(REPAIR_CHANNELS.agentsUseCheckoutDatabase, parser(repairInputSchemas.agentsUseCheckoutDatabase), ({ agent }) =>
    agents.useCheckoutDatabase(agent),
  );

  /** One page action at a time, like the repair actions; the disable and its start never overlap another. */
  async function exclusive<T>(busy: T, task: () => Promise<T>): Promise<T> {
    if (state.busy) return busy;
    state.busy = true;
    state.touch();
    try {
      return await task();
    } finally {
      state.busy = false;
      state.touch();
    }
  }

  handle(REPAIR_CHANNELS.legacyDisablePreview, parser(repairInputSchemas.legacyDisablePreview), () =>
    legacyDisable.preview(),
  );
  handle(REPAIR_CHANNELS.legacyDisableConfirm, parser(repairInputSchemas.legacyDisableConfirm), (input) =>
    exclusive({ ok: false, reason: "busy" } as const, () =>
      legacyDisable.confirm(input.previewId, input.continueWhileBusy === true),
    ),
  );
  // One page action at a time, so a port change never overlaps a retry or a database change.
  handle(REPAIR_CHANNELS.portChange, parser(repairInputSchemas.portChange), ({ port }) =>
    exclusive({ ok: false, reason: "busy", busy: "operation" } as const, () => changePort.change(port)),
  );
  // Not behind the page-action lock: a check changes nothing, and a second click joins the one that runs.
  handle(REPAIR_CHANNELS.updateCheck, parser(repairInputSchemas.updateCheck), () => updates.check());
  handle(REPAIR_CHANNELS.updateOpenLink, parser(repairInputSchemas.updateOpenLink), async ({ target }) => ({
    ok: await updates.openLink(target),
  }));
  // Not behind the page-action lock: listing and choosing change nothing; the restore takes the lock itself after its checks.
  handle(REPAIR_CHANNELS.restoreList, parser(repairInputSchemas.restoreList), (_input, senderId) =>
    restore.list(senderId),
  );
  handle(REPAIR_CHANNELS.restorePick, parser(repairInputSchemas.restorePick), (_input, senderId) =>
    restore.pick(senderId),
  );
  handle(REPAIR_CHANNELS.restoreRun, parser(repairInputSchemas.restoreRun), ({ backupId }, senderId) =>
    restore.run(senderId, backupId),
  );
  handle(REPAIR_CHANNELS.legacyStartNow, parser(repairInputSchemas.legacyStartNow), () =>
    exclusive({ ok: false, reason: "busy" } as const, () => legacyDisable.startNow()),
  );
}
