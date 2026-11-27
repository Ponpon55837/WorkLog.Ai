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

export class ShellState {
  owner: ServiceOwnerState = "UNCONFIGURED";
  backend: BackendRunState = "stopped";
  settings: DesktopSettingsV1 | null = null;
  launchMode: LaunchMode = "interactive";
  locale: ShellLocale = "en";
  languagePreference: ShellLanguagePreference = "system";
  needsSetup = false;
  tab: AppTab = "status";
  readonly tabMemory = new TabMemory();
  busy = false;
  busyAction: RepairBusyWhat | null = null;
  recovered: RepairRecovered | null = null;
  startupFallback: StartupFallbackNote | null = null;
  readonly retryIds = new RetryIdIssuer(() => randomUUID());
  readonly candidates = new CandidateRegistry(() => randomUUID(), MAX_CANDIDATES);
  readonly recentErrors = new RecentErrors();
  private readonly listeners = new Set<() => void>();
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

  /** Writers run one at a time, each starting from the settings the previous one left, so overlapping writers never overwrite each other's field. The file is written first; memory changes only when the write worked. */
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

  setOwner(next: ServiceOwnerState): void {
    if (next !== this.owner) this.retryIds.rotate();
    this.owner = next;
    this.touch();
  }

  touch(): void {
    for (const listener of [...this.listeners]) listener();
  }

  onChange(listener: () => void): void {
    this.listeners.add(listener);
  }
}
