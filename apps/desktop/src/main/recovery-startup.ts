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
import { defaultSettings, type SettingsLoad } from "./settings.js";
import type { ShellState } from "./state.js";

export interface StartupRecoveryOptions {
  readonly journal: OperationJournal;
  readonly state: ShellState;
  readonly supervisor: Pick<BackendSupervisor, "running" | "preview">;
  readonly detectLegacy: () => Promise<LegacyServiceDetection>;
  readonly prepareRuntime: () => Promise<unknown>;
  readonly platform: NodeJS.Platform;
  readonly settingsLoad: SettingsLoad;
  readonly log: Logger;
}

function needsDatabase(record: OperationRecord): boolean {
  return (
    record.kind === "change-db" ||
    record.kind === "legacy-disable" ||
    record.selectedDb !== null ||
    record.schemaVersionAtStart !== null
  );
}

export function recoverAtStartup(options: StartupRecoveryOptions): Promise<StartupRecoveryResult> {
  const { journal, state, supervisor, platform, log } = options;
  const copyDirectory = dirname(defaultSettings().desired.databasePath);
  let detection: Promise<LegacyServiceDetection> | undefined;

  async function probe(record: OperationRecord): Promise<ProbeReport> {
    detection ??= options.detectLegacy();
    const legacy = await detection;
    const settings = state.settings;
    let dbIdentity: DatabaseIdentityRecord | null = null;
    let dbSchemaVersion: number | null = null;
    if (settings !== null && needsDatabase(record)) {
      await options.prepareRuntime();
      // The read-only child opens the file without writing; `quickCheck` only for the old service's disable, which may have ended a writer mid-transaction.
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
    settingsUnreadable: options.settingsLoad === "repair",
    probe,
    settleCopy: (copyPath, record) =>
      settleOrphanCopy({
        copyPath,
        copyDirectory,
        // Every database this App knows it uses: the settings' two paths and the one the state serves right now.
        settingsDatabasePaths: [
          state.settings?.desired.databasePath,
          state.settings?.active?.databaseIdentity.realPath,
          state.databasePath(),
        ],
        recordUpdatedAt: record.updatedAt,
        platform,
      }),
    log,
  });
}
