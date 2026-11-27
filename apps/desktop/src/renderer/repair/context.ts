import type { AppTab, RepairActionId, RepairApi, RepairState } from "@work-intelligence/desktop-core";
import type { ShellMessages } from "@work-intelligence/desktop-core/shell/i18n";

export interface ViewActions {
  readonly api: RepairApi;
  perform(id: RepairActionId): void;
  confirm(candidateId: string, allowMigration: boolean, riskConsent: boolean): void;
  copyToLocal(candidateId?: string): void;
  openTab(tab: AppTab): void;
  openAgents(): void;
  dismissFinished(): void;
  acknowledgeRecovery(id: string): void;
  rerender(): void;
  refresh(): void;
}

export interface ViewContext {
  readonly state: RepairState;
  readonly messages: ShellMessages;
  readonly busy: boolean;
  readonly riskTicked: Set<string>;
  readonly setupFinished: boolean;
  readonly focusPort: boolean;
  readonly act: ViewActions;
}
