import type { AppTab, RepairActionId, RepairApi, RepairState } from "@work-intelligence/desktop-core";
import type { ShellMessages } from "@work-intelligence/desktop-core/shell/i18n";

/** What a tab's view may ask the page to do; the page owns the state and the one in-flight operation. */
export interface ViewActions {
  readonly api: RepairApi;
  /** Runs one of the buttons main listed (retry, choose a database, open a folder, export diagnostics, ...). */
  perform(id: RepairActionId): void;
  confirm(candidateId: string, allowMigration: boolean, riskConsent: boolean): void;
  /** 「複製到本機磁碟並改用」 for a candidate, or (no id) for the App's own database. */
  copyToLocal(candidateId?: string): void;
  openTab(tab: AppTab): void;
  /** Draws the open panel again from the last state (a view's own state changed). */
  rerender(): void;
  /** Reads the state from main again, then draws it. */
  refresh(): void;
}

/** Everything a panel is drawn from. */
export interface ViewContext {
  readonly state: RepairState;
  readonly messages: ShellMessages;
  /** An operation of this page is running: its buttons wait. */
  readonly busy: boolean;
  /** Candidates whose storage-risk checkbox is ticked: the panel is redrawn on changes and must keep the tick. */
  readonly riskTicked: Set<string>;
  readonly act: ViewActions;
}
