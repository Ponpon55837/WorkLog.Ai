import { dialog, ipcMain, shell } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { homedir } from "node:os";
import {
  allowMigrationFor,
  canApplyPreview,
  chosenPathProblem,
  DiagnosticsError,
  DiagnosticsPreviewStore,
  initialTab,
  isTrustedRepairSender,
  openSystemSettings,
  REPAIR_CHANNELS,
  repairInputSchemas,
  tabsFor,
  writePrivateFile,
  type BackendSupervisor,
  type OperationJournal,
  type OperationKind,
  type AppTabSelection,
  type RepairActionResult,
  type RepairBusyReason,
  type RepairBusyWhat,
} from "@work-intelligence/desktop-core";
import type { AgentsPage } from "./agents.js";
import { busyReasonOf, checkActivity } from "./activity-gate.js";
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
import type { LoginItemController } from "./login-item.js";
import type { BackupDirectoryController } from "./backup-directory.js";
import type { MaintenanceController } from "./maintenance.js";
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
  readonly loginItem: LoginItemController;
  /** 「整理資料庫」: takes the page-action lock itself, after its checks and the native confirmation. */
  readonly maintenance: MaintenanceController;
  /** 「更換備份位置」: the page sends nothing; main opens the folder dialog. Runs under the page-action lock. */
  readonly backupDirectory: BackupDirectoryController;
  readonly updates: UpdateController;
  /** 「從備份還原」: the page holds only one-time ids; main keeps every path. */
  readonly restore: RestoreController;
  /** Holds the recovery notices the Status tab shows. */
  readonly journal: Pick<OperationJournal, "acknowledgeNotice">;
  /** 「複製到本機磁碟並改用」: for a candidate id, or (no id) the App's own database. */
  readonly copyToLocal: (candidateId: string | undefined) => Promise<RepairActionResult>;
  /** The coordinator's running operation, if any: what a busy refusal names. */
  readonly currentOperation: () => OperationKind | null;
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
    loginItem,
    maintenance,
    backupDirectory,
    storage,
    updates,
    restore,
    journal,
    currentOperation,
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

  /** What holds the App right now: the running operation first, then the page action that holds the lock. */
  function busyReason(): RepairBusyReason {
    const operation = currentOperation();
    if (operation !== null) return { source: "operation", what: operation };
    return state.busyAction === null ? { source: "unknown" } : { source: "operation", what: state.busyAction };
  }

  /** A busy answer from a controller that holds the lock itself gets the reason the page will say. */
  function tagBusy<T extends { readonly ok: boolean }>(result: T): T {
    if (result.ok || (result as { reason?: string }).reason !== "busy") return result;
    return { ...result, busyReason: busyReason() };
  }

  async function withBusy(
    action: RepairBusyWhat,
    task: () => Promise<RepairActionResult>,
  ): Promise<RepairActionResult> {
    if (state.busy) return { ok: false, reason: "busy", busyReason: busyReason() };
    state.busy = true;
    state.busyAction = action;
    try {
      return await task();
    } catch (error) {
      log(`[shell] repair action failed: ${error instanceof Error ? error.message : "unknown error"}`);
      return { ok: false, reason: "failed" };
    } finally {
      state.busy = false;
      state.busyAction = null;
    }
  }

  /** One page action at a time, like the repair actions; the disable and its start never overlap another. */
  async function exclusive<T extends { readonly ok: boolean }>(
    action: RepairBusyWhat,
    busy: () => NoInfer<Extract<T, { readonly ok: false }>>,
    task: () => Promise<T>,
  ): Promise<T> {
    if (state.busy) return busy();
    state.busy = true;
    state.busyAction = action;
    state.touch();
    try {
      return await task();
    } finally {
      state.busy = false;
      state.busyAction = null;
      state.touch();
    }
  }

  ipcMain.handle(REPAIR_CHANNELS.getState, async (event, raw: unknown) => {
    if (!isTrusted(event) || !repairInputSchemas.getState.safeParse(raw).success) throw new Error("untrusted sender");
    return info.snapshot();
  });

  handle(REPAIR_CHANNELS.retryStart, parser(repairInputSchemas.retryStart), ({ operationId }) =>
    withBusy("takeover", async () => {
      if (!state.retryIds.consume(operationId)) return { ok: false, reason: "invalid" };
      const opensAtStart = success.opens();
      const outcome = await backend.recovery.retryNow(operationId);
      success.finish(outcome, opensAtStart);
      if (outcome.ok) return { ok: true, state: await info.snapshot() };
      // A restart already running is not an error: the page shows "restarting" and polls.
      if (outcome.busy) return { ok: false, reason: "busy", busyReason: busyReason() };
      return { ok: false, reason: "failed", errorCode: outcome.code };
    }),
  );

  handle(REPAIR_CHANNELS.chooseDatabase, parser(repairInputSchemas.chooseDatabase), () =>
    withBusy("change-db", async () => {
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
      withBusy("change-db", async () => {
        // Refused storage, an update the storage forbids and a risky file without its ticked consent stop here, in main.
        const check = state.candidates.checkConfirm(
          candidateId,
          allowMigration === true,
          acknowledgeStorageRisk === true,
        );
        if (!check.ok) return { ok: false, reason: "invalid" };
        // Switching stops the running backend: not while the Dashboard imports, backs up or exports (M-02).
        const gate = await checkActivity({ operationRunning: () => currentOperation() !== null, supervisor });
        if ("refusal" in gate)
          return { ok: false, reason: "busy", busyReason: busyReasonOf(gate.refusal, busyReason()) };
        // A pending automatic retry must not start the old database while the user's choice runs.
        backend.recovery.cancel();
        const opensAtStart = success.opens();
        const outcome = await backend.start("change-db", {
          databasePath: check.entry.path,
          expectedIdentity: check.identity,
          allowSchemaMigration: allowMigrationFor(check.preview.needsMigration, check.entry.storageRisk),
        });
        if (!outcome.ok) {
          if (outcome.busy) return { ok: false, reason: "busy", busyReason: busyReason() };
          success.finish(outcome, opensAtStart);
          backend.presenter().present(outcome.code);
          return { ok: false, reason: "failed", errorCode: outcome.code };
        }
        state.candidates.remove(candidateId);
        await state.updateSettings(paths.settingsFile, (current) => current);
        success.finish(outcome, opensAtStart);
        return { ok: true, state: await info.snapshot() };
      }),
  );

  handle(REPAIR_CHANNELS.copyToLocal, parser(repairInputSchemas.copyToLocal), ({ candidateId }) =>
    withBusy("copy-to-local", async () => {
      // The App's own database is copied with its backend stopped: not while the Dashboard imports or backs up (M-01).
      if (candidateId === undefined) {
        const gate = await checkActivity({ operationRunning: () => currentOperation() !== null, supervisor });
        if ("refusal" in gate) {
          return { ok: false, reason: "busy", busyReason: busyReasonOf(gate.refusal, busyReason()) };
        }
      }
      return options.copyToLocal(candidateId);
    }),
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
    withBusy("takeover", async () => {
      const database = state.databasePath();
      if (!database || !state.retryIds.consume(operationId)) return { ok: false, reason: "invalid" };
      // The user said "仍要啟動": this database may start beside the old service until the App quits.
      legacy.allow(database);
      const opensAtStart = success.opens();
      const outcome = await backend.recovery.retryNow(operationId);
      success.finish(outcome, opensAtStart);
      if (outcome.ok) return { ok: true, state: await info.snapshot() };
      if (outcome.busy) return { ok: false, reason: "busy", busyReason: busyReason() };
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

  // The page sends an enum; main opens one fixed place of the OS for it (never a path or a URL from the page).
  handle(REPAIR_CHANNELS.openSystemSettings, parser(repairInputSchemas.openSystemSettings), ({ target }) =>
    openSystemSettings(target, { platform: process.platform, env: process.env, homeDirectory: homedir(), shell }),
  );

  // "Check again": the user turned the old service off by hand, so detect it afresh; the page then reads the state.
  handle(REPAIR_CHANNELS.legacyRecheck, parser(repairInputSchemas.legacyRecheck), async () => {
    await legacy.refresh();
    return { ok: true };
  });

  // Dismissing a recovery notice is written to the journal, so the banner does not come back after a restart.
  handle(REPAIR_CHANNELS.recoveryAcknowledge, parser(repairInputSchemas.recoveryAcknowledge), async ({ id }) => ({
    ok: await journal.acknowledgeNotice(id).catch(() => false),
  }));

  ipcMain.handle(REPAIR_CHANNELS.setupGetState, async (event, raw: unknown) => {
    if (!isTrusted(event) || !repairInputSchemas.setupGetState.safeParse(raw).success) {
      throw new Error("untrusted sender");
    }
    // The first look of the page starts the detection; the page polls while it runs.
    void firstRun.begin();
    return firstRun.snapshot();
  });

  // Like every action that starts or moves the service, behind the one page-action lock (L-07).
  handle(REPAIR_CHANNELS.setupUseDefaults, parser(repairInputSchemas.setupUseDefaults), (input) =>
    exclusive(
      "takeover",
      () => ({ ok: false, reason: "busy" }) as const,
      () => firstRun.useDefaults(input.launchAtLogin, input.startAnyway === true),
    ),
  );

  handle(REPAIR_CHANNELS.setupUseSource, parser(repairInputSchemas.setupUseSource), (input) =>
    exclusive(
      "takeover",
      () => ({ ok: false, reason: "busy" }) as const,
      () => firstRun.useSource(input),
    ),
  );

  handle(REPAIR_CHANNELS.setupChooseFile, parser(repairInputSchemas.setupChooseFile), () => firstRun.chooseFile());

  // The same single lock as every other page action: a copy never overlaps a retry, a port change or another start.
  handle(REPAIR_CHANNELS.setupCopyToLocal, parser(repairInputSchemas.setupCopyToLocal), (input) =>
    exclusive(
      "copy-to-local",
      () => ({ ok: false, reason: "busy" }) as const,
      () => firstRun.copyToLocal(input.sourceId, input.launchAtLogin === true),
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

  handle(REPAIR_CHANNELS.agentsPreview, parser(repairInputSchemas.agentsPreview), ({ adopt, agents: selected }) =>
    agents.preview(adopt, selected),
  );
  handle(REPAIR_CHANNELS.agentsRemovePreview, parser(repairInputSchemas.agentsRemovePreview), () =>
    agents.previewRemove(),
  );
  handle(REPAIR_CHANNELS.agentsApply, parser(repairInputSchemas.agentsApply), ({ previewId, acknowledgeUndiffable }) =>
    exclusive(
      "apply-agent",
      () => ({ ok: false, reason: "busy", state: agents.snapshot() }) as const,
      async () => {
        // A file whose diff was not shown is applied only after the user said so; the page's disabled button is not the guard.
        const shown = agents.snapshot().preview;
        if (shown?.id === previewId && !canApplyPreview(shown, acknowledgeUndiffable === true)) {
          return { ok: false, reason: "invalid", state: agents.snapshot() } as const;
        }
        return agents.apply(previewId);
      },
    ),
  );
  handle(REPAIR_CHANNELS.agentsDiscard, parser(repairInputSchemas.agentsDiscard), async () => agents.discard());
  handle(REPAIR_CHANNELS.agentsUndo, parser(repairInputSchemas.agentsUndo), () =>
    exclusive(
      "apply-agent",
      () => ({ ok: false, reason: "busy", state: agents.snapshot() }) as const,
      () => agents.undo(),
    ),
  );
  handle(REPAIR_CHANNELS.agentsSelfTest, parser(repairInputSchemas.agentsSelfTest), () => agents.selfTest());
  handle(REPAIR_CHANNELS.agentsUseCheckoutDatabase, parser(repairInputSchemas.agentsUseCheckoutDatabase), ({ agent }) =>
    exclusive(
      "change-db",
      () => ({ ok: false, reason: "busy", state: agents.snapshot() }) as const,
      () => agents.useCheckoutDatabase(agent),
    ),
  );

  handle(REPAIR_CHANNELS.legacyDisablePreview, parser(repairInputSchemas.legacyDisablePreview), () =>
    legacyDisable.preview(),
  );
  handle(REPAIR_CHANNELS.legacyDisableConfirm, parser(repairInputSchemas.legacyDisableConfirm), (input) =>
    exclusive(
      "legacy-disable",
      () => ({ ok: false, reason: "busy", busyReason: busyReason() }) as const,
      async () => tagBusy(await legacyDisable.confirm(input.previewId, input.continueWhileBusy === true)),
    ),
  );
  // One page action at a time, so a port change never overlaps a retry or a database change.
  handle(REPAIR_CHANNELS.portChange, parser(repairInputSchemas.portChange), ({ port }) =>
    exclusive(
      "change-port",
      () => ({ ok: false, reason: "busy", busy: "operation" }) as const,
      () => changePort.change(port),
    ),
  );
  // Only a boolean comes in. It shares the page-action lock with every other change of the settings file.
  handle(REPAIR_CHANNELS.loginItemSet, parser(repairInputSchemas.loginItemSet), ({ enable }) =>
    exclusive(
      "login-item",
      () => ({ ok: false, reason: "busy" }) as const,
      () => loginItem.set(enable),
    ),
  );
  // The change restarts the service, so it shares the page-action lock with every other change of the settings.
  handle(REPAIR_CHANNELS.backupDirectoryChoose, parser(repairInputSchemas.backupDirectoryChoose), () =>
    exclusive(
      "backup-directory",
      () => ({ ok: false, reason: "busy" }) as const,
      () => backupDirectory.choose(),
    ),
  );
  // Not behind `exclusive`: the controller refuses while anything runs, asks first, then takes the lock itself.
  handle(REPAIR_CHANNELS.maintenanceRun, parser(repairInputSchemas.maintenanceRun), ({ mode }) =>
    maintenance.run(mode),
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
    exclusive(
      "takeover",
      () => ({ ok: false, reason: "busy", busyReason: busyReason() }) as const,
      async () => tagBusy(await legacyDisable.startNow()),
    ),
  );
}
