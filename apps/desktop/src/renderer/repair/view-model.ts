import type { AppTab, RepairRecoveryNotice, RepairState } from "@work-intelligence/desktop-core";
import { formatMessage, type ShellMessages } from "@work-intelligence/desktop-core/shell/i18n";

export interface RecoveryBannerText {
  readonly message: string;
  readonly nextStep: string;
  readonly tab: AppTab;
  readonly openTabLabel: string;
}

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

export function isBlockingDatabase(state: Pick<RepairState, "owner" | "database" | "candidates">): boolean {
  if (state.owner !== "NEEDS_REPAIR") return false;
  return state.database.status !== "ok" || state.candidates.length > 0 || state.database.storageRisk !== undefined;
}

export function migrationOffer(state: Pick<RepairState, "database" | "actions">): "approve" | "copy" | null {
  if (state.database.status !== "needs-migration") return null;
  if (state.actions.some((action) => action.id === "approve-migration")) return "approve";
  return state.database.storageRisk?.canCopyToLocal ? "copy" : null;
}

export function retryIsPrimary(state: Pick<RepairState, "database">): boolean {
  return state.database.status !== "needs-migration";
}

// The retry id is fresh in every snapshot and read when a button is pressed, so it is left out.
export function panelInputs(tab: AppTab, state: RepairState): unknown {
  if (tab === "settings")
    return {
      locale: state.locale,
      port: state.port,
      update: state.update,
      loginItem: state.loginItem,
      language: state.language,
      backupDirectory: state.backupDirectory,
    };
  const {
    retryOperationId: _retry,
    port: _port,
    update: _update,
    loginItem: _loginItem,
    language: _language,
    backupDirectory: _backupDirectory,
    shell: _shell,
    ...rest
  } = state;
  return rest;
}
