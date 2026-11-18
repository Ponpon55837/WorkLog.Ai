import { dirname } from "node:path";
import {
  runStartupRecovery,
  settleOrphanCopy,
  type BackendSupervisor,
  type DatabaseIdentityRecord,
  type LegacyServiceDetection,
  type OperationJournal,
  type OperationRecord,
  type ProbeReport,
  type StartupRecoveryResult,
} from "@work-intelligence/desktop-core";
import type { Logger } from "./log.js";
import { defaultSettings } from "./settings.js";
import type { ShellState } from "./state.js";

export interface StartupRecoveryOptions {
  readonly journal: OperationJournal;
  readonly state: ShellState;
  readonly supervisor: Pick<BackendSupervisor, "running" | "preview">;
  /** Detects the old login service again (read-only). */
  readonly detectLegacy: () => Promise<LegacyServiceDetection>;
  /** Makes the runtime ready for the read-only database check; only called when a record needs that check. */
  readonly prepareRuntime: () => Promise<unknown>;
  readonly platform: NodeJS.Platform;
  readonly log: Logger;
}

/** Whether the record's decision depends on which database the settings name (so the database is read). */
function needsDatabase(record: OperationRecord): boolean {
  return (
    record.kind === "change-db" ||
    record.kind === "legacy-disable" ||
    record.selectedDb !== null ||
    record.schemaVersionAtStart !== null
  );
}

/**
 * Closes the operations a crash left in progress (H-01). It runs once at start, after the settings are read and before
 * the first-run page or any backend start. Every fact comes from the real state: the OS (old service detection), this
 * App's own child, the settings file, and a read-only look at the database the settings name. With an empty journal it
 * costs the one journal read; nothing here runs until a record is in progress.
 */
export function recoverAtStartup(options: StartupRecoveryOptions): Promise<StartupRecoveryResult> {
  const { journal, state, supervisor, platform, log } = options;
  const copyDirectory = dirname(defaultSettings().desired.databasePath);
  // One detection per run, however many records there are.
  let detection: Promise<LegacyServiceDetection> | undefined;

  async function probe(record: OperationRecord): Promise<ProbeReport> {
    detection ??= options.detectLegacy();
    const legacy = await detection;
    const settings = state.settings;
    let dbIdentity: DatabaseIdentityRecord | null = null;
    let dbSchemaVersion: number | null = null;
    if (settings !== null && needsDatabase(record)) {
      await options.prepareRuntime();
      // The read-only child opens the file without writing; `quickCheck` only for the old service's disable, which may
      // have ended a writer in the middle of a transaction.
      const preview = await supervisor.preview(
        settings.desired.databasePath,
        record.kind === "legacy-disable" ? { quickCheck: true } : {},
      );
      if (preview.outcome === "failed") throw new Error(`the database check could not run (${preview.code})`);
      if (preview.preflight.status === "ok") {
        dbIdentity = preview.preflight.identity ?? null;
        dbSchemaVersion = preview.preflight.schemaVersion ?? null;
      }
    }
    return {
      oldServiceRegistered: legacy.kind === "found",
      oldServiceEnabled: legacy.kind === "found" && legacy.enabled === "enabled",
      oldServiceRunning: legacy.kind === "found" && legacy.running === "running",
      desktopChild: { running: supervisor.running !== undefined, identityVerified: false },
      dbSchemaVersion,
      dbIdentity,
      migrationEvidence: false,
      settingsPort: settings?.desired.port ?? null,
      settingsState: settings === null ? "absent" : settings.active ? "active" : "no-active",
    };
  }

  return runStartupRecovery({
    journal,
    probe,
    settleCopy: (copyPath) =>
      settleOrphanCopy({
        copyPath,
        copyDirectory,
        settingsDatabasePaths: [
          state.settings?.desired.databasePath,
          state.settings?.active?.databaseIdentity.realPath,
        ],
        platform,
      }),
    log,
  });
}
