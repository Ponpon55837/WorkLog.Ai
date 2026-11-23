import { randomUUID } from "node:crypto";
import {
  CandidateRegistry,
  RecentErrors,
  RetryIdIssuer,
  shellMessages,
  type BackendRunState,
  type DesktopSettingsV1,
  type LaunchMode,
  type RepairBusyWhat,
  type RepairRecovered,
  type ShellLocale,
  type ShellMessages,
  type ServiceOwnerState,
  type AppTab,
  TabMemory,
  writeDesktopSettingsAtomic,
  type StartupFallbackNote,
} from "@work-intelligence/desktop-core";
import type { ShellLanguagePreference } from "@work-intelligence/schema";

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
  /** The language every surface uses; only main/language.ts sets it (the setting, else the system language). */
  locale: ShellLocale = "en";
  /** The language setting: the settings file's, or (before the first-run page committed one) the page's choice. */
  languagePreference: ShellLanguagePreference = "system";
  /** No settings file yet: the first-run page has not finished. The tray offers "完成首次設定…". */
  needsSetup = false;
  /** The tab the App window shows; main decides, the page asks (`app:get-tab`) and follows `app:select-tab`. */
  tab: AppTab = "status";
  /** The tab the user last selected this session (memory only; the page reports it through `app:remember-tab`). */
  readonly tabMemory = new TabMemory();
  /** A repair action is running: the page's other actions wait. */
  busy = false;
  /** What the running page action is, so a refused request can say it; null while none runs. */
  busyAction: RepairBusyWhat | null = null;
  /** The success card the repair page shows for a moment after a user-started repair worked. */
  recovered: RepairRecovered | null = null;
  /** What a fallback to the last working port did in this App run (memory only), for the Status tab; null: none. */
  startupFallback: StartupFallbackNote | null = null;
  readonly retryIds = new RetryIdIssuer(() => randomUUID());
  readonly candidates = new CandidateRegistry(() => randomUUID(), MAX_CANDIDATES);
  readonly recentErrors = new RecentErrors();
  private readonly listeners = new Set<() => void>();
  /** Tail of the settings writes: every write waits for the one before it. */
  private settingsWrites: Promise<unknown> = Promise.resolve();

  messages(): ShellMessages {
    return shellMessages(this.locale);
  }

  databasePath(): string | null {
    return this.settings?.desired.databasePath ?? null;
  }

  backupDirectory(): string | null {
    return this.settings?.desired.backupDirectory ?? null;
  }

  /**
   * The only way to change and save the settings after start. Writers run one at a time and each one starts from the
   * settings as the writer before it left them, so two overlapping writers (the login switch and a crash-restart that
   * records the active service) never overwrite each other's field. `mutate` returns the new settings, or null to leave
   * them alone. The file is written first; the in-memory settings change only when the write worked (a failed write throws
   * and the settings stay as they were).
   */
  updateSettings(
    file: string,
    mutate: (current: DesktopSettingsV1) => DesktopSettingsV1 | null,
  ): Promise<DesktopSettingsV1 | null> {
    const run = async (): Promise<DesktopSettingsV1 | null> => {
      if (!this.settings) return null;
      const next = mutate(this.settings);
      if (next === null) return null;
      await writeDesktopSettingsAtomic(file, next);
      this.settings = next;
      return next;
    };
    const result = this.settingsWrites.then(run, run);
    this.settingsWrites = result.catch(() => undefined);
    return result;
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
