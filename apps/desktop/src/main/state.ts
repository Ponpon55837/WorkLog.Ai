import { randomUUID } from "node:crypto";
import {
  CandidateRegistry,
  RecentErrors,
  RetryIdIssuer,
  shellMessages,
  type BackendRunState,
  type DesktopSettingsV1,
  type LaunchMode,
  type RepairRecovered,
  type ShellLocale,
  type ShellMessages,
  type ServiceOwnerState,
  type AppView,
} from "@work-intelligence/desktop-core";

const MAX_CANDIDATES = 5;

/**
 * What the shell knows right now. One object, owned by the main process; the other modules read and change it through
 * these members, and anything that shows it (the tray) subscribes to `onChange`.
 */
export class ShellState {
  owner: ServiceOwnerState = "UNCONFIGURED";
  backend: BackendRunState = "stopped";
  settings: DesktopSettingsV1 | null = null;
  launchMode: LaunchMode = "interactive";
  locale: ShellLocale = "en";
  /** No settings file yet: the first-run page has not finished. The tray offers "完成首次設定…". */
  needsSetup = false;
  /** What the App window shows; main decides, the page asks (`app:get-view`). */
  view: AppView = "repair";
  /** A repair action is running: the page's other actions wait. */
  busy = false;
  /** The success card the repair page shows for a moment after a user-started repair worked. */
  recovered: RepairRecovered | null = null;
  readonly retryIds = new RetryIdIssuer(() => randomUUID());
  readonly candidates = new CandidateRegistry(() => randomUUID(), MAX_CANDIDATES);
  readonly recentErrors = new RecentErrors();
  private readonly listeners = new Set<() => void>();

  messages(): ShellMessages {
    return shellMessages(this.locale);
  }

  databasePath(): string | null {
    return this.settings?.desired.databasePath ?? null;
  }

  backupDirectory(): string | null {
    return this.settings?.desired.backupDirectory ?? null;
  }

  /** Moves the owner; a button the page holds belongs to the state it was shown in, so a new owner voids its id. */
  setOwner(next: ServiceOwnerState): void {
    if (next !== this.owner) this.retryIds.rotate();
    this.owner = next;
    this.touch();
  }

  /** Something the tray shows changed. */
  touch(): void {
    for (const listener of [...this.listeners]) listener();
  }

  onChange(listener: () => void): void {
    this.listeners.add(listener);
  }
}
