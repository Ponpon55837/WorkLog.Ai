import type { DatabaseIdentityRecord, NewOperationInput, ProbeReport } from "../../packages/desktop-core/src/index.js";

export const LINEAGE = "a".repeat(64);

export const DB_A: DatabaseIdentityRecord = {
  realPath: "/synthetic/a/work.db",
  fileId: { device: "10", inode: "100" },
  lineageId: LINEAGE,
};

export const DB_B: DatabaseIdentityRecord = {
  realPath: "/synthetic/b/work.db",
  fileId: { device: "10", inode: "200" },
  lineageId: "b".repeat(64),
};

/** Deterministic clock advancing one second per call. */
export function makeClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
}

export function newInput(overrides: Partial<NewOperationInput> = {}): NewOperationInput {
  return {
    operationId: "op-1",
    kind: "takeover",
    previousOwner: "EXTERNAL",
    selectedDb: DB_A,
    oldServiceDefinition: { label: "synthetic.service" },
    oldEnabledState: true,
    oldRunningState: true,
    schemaVersionAtStart: 5,
    ...overrides,
  };
}

export function probe(overrides: Partial<ProbeReport> = {}): () => ProbeReport {
  const report: ProbeReport = {
    oldServiceRegistered: true,
    oldServiceEnabled: true,
    oldServiceRunning: false,
    desktopChild: { running: false, identityVerified: false },
    dbSchemaVersion: 5,
    dbIdentity: DB_A,
    migrationEvidence: false,
    settingsPort: null,
    settingsState: "no-active",
    ...overrides,
  };
  return () => report;
}
