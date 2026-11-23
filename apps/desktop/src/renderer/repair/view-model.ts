import type { AppTab, RepairRecoveryNotice, RepairState } from "@work-intelligence/desktop-core";
import { formatMessage, type ShellMessages } from "@work-intelligence/desktop-core/shell/i18n";

/** What the Status tab's banner says about one interrupted operation: what happened, what can be done and where. */
export interface RecoveryBannerText {
  readonly message: string;
  readonly nextStep: string;
  /** The tab where the user can act, and its label for the button that goes there. */
  readonly tab: AppTab;
  readonly openTabLabel: string;
}

/**
 * The words of a recovery notice. A notice that needs repair keeps the Status tab (its retry is there); every other one
 * points at the tab of the operation it belongs to. The text states the verified fact (the port still in use, the
 * database kept) and never a bare "an error occurred".
 */
export function recoveryBannerText(notice: RepairRecoveryNotice, messages: ShellMessages): RecoveryBannerText {
  const values = {
    port: String(notice.port ?? ""),
    attempted: String(notice.attemptedPort ?? ""),
    operation: messages.recoveryOperationNames[notice.operation],
  };
  const tab: AppTab = notice.kind === "needs-repair" || notice.kind === "journal-unreadable" ? "status" : notice.tab;
  return {
    message: formatMessage(messages.recoveryNotices[notice.kind], values),
    nextStep: messages.recoveryNextSteps[notice.kind],
    tab,
    openTabLabel: formatMessage(messages.recoveryOpenTab, { tab: messages.tabLabels[tab] }),
  };
}

/**
 * The service needs repair because of its database: the file cannot be used, other databases were found to choose from,
 * or its storage is risky. Then Status shows the whole database card (and the candidates) so nobody has to look for it.
 */
export function isBlockingDatabase(state: Pick<RepairState, "owner" | "database" | "candidates">): boolean {
  if (state.owner !== "NEEDS_REPAIR") return false;
  return state.database.status !== "ok" || state.candidates.length > 0 || state.database.storageRisk !== undefined;
}

/**
 * How the page offers the schema update the App's own database waits for: `approve` is 「先備份再更新資料庫」 (main
 * listed the action), `copy` is 「複製到本機資料夾後更新」 (its storage refuses an in-place update, DT-08), null when the
 * database does not need one.
 */
export function migrationOffer(state: Pick<RepairState, "database" | "actions">): "approve" | "copy" | null {
  if (state.database.status !== "needs-migration") return null;
  if (state.actions.some((action) => action.id === "approve-migration")) return "approve";
  return state.database.storageRisk?.canCopyToLocal ? "copy" : null;
}

/** 「重試啟動」 is the main button unless the database waits for an update: retrying cannot do it, so it steps back. */
export function retryIsPrimary(state: Pick<RepairState, "database">): boolean {
  return state.database.status !== "needs-migration";
}

/**
 * What a tab's panel is drawn from, and nothing else: the page redraws the panel only when this changes. The retry id
 * is a fresh value in every snapshot and is read when a button is pressed, so it is left out; the sections with their
 * own tab (port, update, shell) are left out of the tabs that do not show them.
 */
export function panelInputs(tab: AppTab, state: RepairState): unknown {
  if (tab === "settings")
    return {
      locale: state.locale,
      port: state.port,
      update: state.update,
      loginItem: state.loginItem,
      backupDirectory: state.backupDirectory,
    };
  const {
    retryOperationId: _retry,
    port: _port,
    update: _update,
    loginItem: _loginItem,
    backupDirectory: _backupDirectory,
    shell: _shell,
    ...rest
  } = state;
  return rest;
}
