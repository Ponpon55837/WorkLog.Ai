import { describe, expect, it } from "vitest";
import {
  OperationJournal,
  InMemoryOperationJournalStore,
  recover,
  type NewOperationInput,
  type OperationRecord,
  type ServiceOwnerState,
} from "../../packages/desktop-core/src/index.js";
import { DB_A, DB_B, makeClock, newInput, probe } from "./operations-helpers.js";

const PATH: Record<string, ServiceOwnerState[]> = {
  EXTERNAL: [],
  PREPARING: ["PREPARING"],
  QUIESCING: ["PREPARING", "QUIESCING"],
  STARTING: ["PREPARING", "QUIESCING", "STARTING"],
  MANAGED: ["PREPARING", "QUIESCING", "STARTING", "MANAGED"],
};

async function recordAt(
  phase: keyof typeof PATH,
  overrides: Partial<NewOperationInput> = {},
  migration = false,
): Promise<OperationRecord> {
  const journal = new OperationJournal(new InMemoryOperationJournalStore(), makeClock());
  await journal.begin(newInput(overrides));
  for (const state of PATH[phase] ?? []) await journal.enterPhase("op-1", state);
  if (migration) await journal.markMigrationStarted("op-1");
  return (await journal.get("op-1")) as OperationRecord;
}

const VERIFIED = { running: true, identityVerified: true };

describe("recover", () => {
  it("QUIESCING + schema already advanced => NEEDS_REPAIR repair-only, never restore", async () => {
    const decision = await recover(await recordAt("QUIESCING"), probe({ dbSchemaVersion: 6 }));
    expect(decision).toMatchObject({
      nextState: "NEEDS_REPAIR",
      action: "repair",
      recoveryPolicy: "repair-only",
      migrationStarted: true,
      restore: null,
    });
  });

  it("migration evidence from the probe overrides journal migrationStarted=false", async () => {
    const record = await recordAt("STARTING");
    expect(record.migrationStarted).toBe(false);
    const decision = await recover(record, probe({ migrationEvidence: true }));
    expect(decision).toMatchObject({
      nextState: "NEEDS_REPAIR",
      migrationStarted: true,
      recoveryPolicy: "repair-only",
    });
  });

  it("STARTING, child not running, no migration => restore previous (EXTERNAL) with a restore plan", async () => {
    const decision = await recover(
      await recordAt("STARTING"),
      probe({ oldServiceRunning: false, oldServiceEnabled: false, oldServiceRegistered: false }),
    );
    expect(decision).toMatchObject({ nextState: "EXTERNAL", action: "restore-previous", migrationStarted: false });
    expect(decision.restore).toEqual({ register: true, enable: true, start: true });
  });

  it("restore plan is empty when the old service is already as recorded", async () => {
    const decision = await recover(await recordAt("QUIESCING"), probe({ oldServiceRunning: true }));
    expect(decision.restore).toEqual({ register: false, enable: false, start: false });
  });

  it("does not restore when the journal policy is repair-only", async () => {
    const journal = new OperationJournal(new InMemoryOperationJournalStore(), makeClock());
    await journal.begin(newInput());
    await journal.enterPhase("op-1", "PREPARING");
    await journal.applyRecovery("op-1", {
      nextState: "PREPARING",
      action: "none",
      recoveryPolicy: "repair-only",
      migrationStarted: false,
      restore: null,
      reason: "t",
    });
    const decision = await recover((await journal.get("op-1")) as OperationRecord, probe());
    expect(decision.nextState).toBe("NEEDS_REPAIR");
  });

  it("MANAGED with a different DB identity => NEEDS_REPAIR", async () => {
    const decision = await recover(await recordAt("MANAGED"), probe({ dbIdentity: DB_B, desktopChild: VERIFIED }));
    expect(decision).toMatchObject({ nextState: "NEEDS_REPAIR", recoveryPolicy: "repair-only" });
  });

  it("unknown DB identity => NEEDS_REPAIR", async () => {
    expect((await recover(await recordAt("PREPARING"), probe({ dbIdentity: null }))).nextState).toBe("NEEDS_REPAIR");
  });

  it("a throwing or rejecting probe fails closed", async () => {
    const sync = await recover(await recordAt("STARTING"), () => {
      throw new Error("sc.exe denied");
    });
    expect(sync).toMatchObject({ nextState: "NEEDS_REPAIR", recoveryPolicy: "repair-only", migrationStarted: false });
    expect(sync.reason).toContain("sc.exe denied");
    const async = await recover(await recordAt("MANAGED", {}, true), () => Promise.reject("weird"));
    expect(async).toMatchObject({ nextState: "NEEDS_REPAIR", migrationStarted: true });
    expect(async.reason).toContain("weird");
  });

  it("PREPARING rolls back to EXTERNAL, or to MANAGED for a re-operation with a verified child", async () => {
    expect((await recover(await recordAt("PREPARING"), probe({ oldServiceRunning: true }))).nextState).toBe("EXTERNAL");
    const managedPrev = await recordAt("PREPARING", { previousOwner: "MANAGED" });
    expect(await recover(managedPrev, probe({ desktopChild: VERIFIED }))).toMatchObject({
      nextState: "MANAGED",
      action: "restore-previous",
    });
    expect((await recover(managedPrev, probe())).nextState).toBe("NEEDS_REPAIR");
  });

  it("rollback from UNCONFIGURED-origin operations needs repair", async () => {
    const record = await recordAt("PREPARING", { previousOwner: "UNCONFIGURED" });
    expect((await recover(record, probe())).nextState).toBe("NEEDS_REPAIR");
  });

  it("QUIESCING with a running desktop child is inconsistent", async () => {
    expect((await recover(await recordAt("QUIESCING"), probe({ desktopChild: VERIFIED }))).nextState).toBe(
      "NEEDS_REPAIR",
    );
  });

  it("STARTING resumes with a verified child, repairs with an unverified one", async () => {
    expect(await recover(await recordAt("STARTING"), probe({ desktopChild: VERIFIED }))).toMatchObject({
      nextState: "STARTING",
      action: "resume",
    });
    expect(
      (await recover(await recordAt("STARTING"), probe({ desktopChild: { running: true, identityVerified: false } })))
        .nextState,
    ).toBe("NEEDS_REPAIR");
  });

  it("MANAGED stays managed unless both old service and child run", async () => {
    expect(await recover(await recordAt("MANAGED"), probe({ desktopChild: VERIFIED }))).toMatchObject({
      nextState: "MANAGED",
      action: "none",
    });
    expect((await recover(await recordAt("MANAGED"), probe())).nextState).toBe("MANAGED");
    expect(
      (await recover(await recordAt("MANAGED"), probe({ desktopChild: VERIFIED, oldServiceRunning: true }))).nextState,
    ).toBe("NEEDS_REPAIR");
  });

  it("migrated MANAGED stays managed (repair-only), migrated STARTING resumes with a verified child", async () => {
    expect(await recover(await recordAt("MANAGED", {}, true), probe({ dbSchemaVersion: 6 }))).toMatchObject({
      nextState: "MANAGED",
      recoveryPolicy: "repair-only",
      migrationStarted: true,
    });
    expect(
      await recover(await recordAt("STARTING", {}, true), probe({ dbSchemaVersion: 6, desktopChild: VERIFIED })),
    ).toMatchObject({ nextState: "STARTING", action: "resume" });
    expect((await recover(await recordAt("STARTING", {}, true), probe({ dbSchemaVersion: 6 }))).nextState).toBe(
      "NEEDS_REPAIR",
    );
    expect((await recover(await recordAt("MANAGED", {}, true), probe({ oldServiceRunning: true }))).nextState).toBe(
      "NEEDS_REPAIR",
    );
  });

  it("EXTERNAL and NEEDS_REPAIR records", async () => {
    expect(await recover(await recordAt("EXTERNAL"), probe())).toMatchObject({ nextState: "EXTERNAL", action: "none" });
    expect(await recover(await recordAt("EXTERNAL"), probe({ migrationEvidence: true }))).toMatchObject({
      nextState: "EXTERNAL",
      migrationStarted: true,
      recoveryPolicy: "repair-only",
    });
    const journal = new OperationJournal(new InMemoryOperationJournalStore(), makeClock());
    await journal.begin(newInput());
    await journal.enterPhase("op-1", "NEEDS_REPAIR");
    const repairing = (await journal.get("op-1")) as OperationRecord;
    expect(await recover(repairing, probe())).toMatchObject({ nextState: "NEEDS_REPAIR", action: "repair" });
    expect(await recover(repairing, probe({ migrationEvidence: true }))).toMatchObject({
      nextState: "NEEDS_REPAIR",
      action: "repair",
      migrationStarted: true,
    });
  });

  it("schema version unknown on either side is not migration evidence", async () => {
    const record = await recordAt("QUIESCING", { schemaVersionAtStart: null });
    expect((await recover(record, probe({ dbSchemaVersion: 9 }))).action).toBe("restore-previous");
    expect((await recover(await recordAt("QUIESCING"), probe({ dbSchemaVersion: null }))).action).toBe(
      "restore-previous",
    );
  });
});

describe("applyRecovery", () => {
  it("persists migration flag before moving, so restore is impossible afterwards", async () => {
    const journal = new OperationJournal(new InMemoryOperationJournalStore(), makeClock());
    await journal.begin(newInput());
    for (const state of PATH.QUIESCING ?? []) await journal.enterPhase("op-1", state);
    const decision = await recover((await journal.get("op-1")) as OperationRecord, probe({ dbSchemaVersion: 6 }));
    const applied = await journal.applyRecovery("op-1", decision);
    expect(applied).toMatchObject({
      phase: "NEEDS_REPAIR",
      migrationStarted: true,
      recoveryPolicy: "repair-only",
      status: "failed",
    });
  });

  it("closes restored operations as cancelled and keeps resumes in progress", async () => {
    const journal = new OperationJournal(new InMemoryOperationJournalStore(), makeClock());
    await journal.begin(newInput());
    for (const state of PATH.STARTING ?? []) await journal.enterPhase("op-1", state);
    const resumed = await journal.applyRecovery(
      "op-1",
      await recover((await journal.get("op-1")) as OperationRecord, probe({ desktopChild: VERIFIED })),
    );
    expect(resumed.status).toBe("in-progress");
    const restored = await journal.applyRecovery("op-1", await recover(resumed, probe()));
    expect(restored).toMatchObject({ phase: "EXTERNAL", status: "cancelled" });
  });
});

describe("recover identity check", () => {
  it("treats a lineage appearing on the same file as unchanged but a replaced file as a mismatch", async () => {
    const record = async (selectedDb: typeof DB_A) => {
      const journal = new OperationJournal(new InMemoryOperationJournalStore(), makeClock());
      await journal.begin(newInput({ selectedDb }));
      await journal.enterPhase("op-1", "PREPARING");
      return (await journal.get("op-1")) as OperationRecord;
    };
    const firstMigration = await recover(await record({ ...DB_A, lineageId: null }), probe());
    expect(firstMigration.action).not.toBe("repair");
    const swapped = await recover(
      await record({ ...DB_A, lineageId: null }),
      probe({ dbIdentity: { ...DB_B, lineageId: DB_A.lineageId } }),
    );
    expect(swapped.action).toBe("repair");
    const vanished = await recover(await record(DB_A), probe({ dbIdentity: { ...DB_A, lineageId: null } }));
    expect(vanished.action).toBe("repair");
  });
});

describe("recover a port change", () => {
  const change = {
    kind: "change-port" as const,
    previousOwner: "MANAGED" as const,
    details: { from: 3210, to: 43_210 },
  };

  it("keeps the managed owner when the child ended with the App and the settings still name the old port", async () => {
    for (const phase of ["PREPARING", "STARTING"] as const) {
      const record = await recordAt(phase, change);
      expect(record.details).toEqual({ from: 3210, to: 43_210 });
      const decision = await recover(record, probe({ oldServiceRunning: false, settingsPort: 3210 }));
      expect(decision).toMatchObject({ nextState: "MANAGED", action: "none", restore: null, migrationStarted: false });
    }
  });

  it("closes without undoing anything when the settings already name the new port (the commit landed)", async () => {
    const decision = await recover(await recordAt("STARTING", change), probe({ settingsPort: 43_210 }));
    expect(decision).toMatchObject({ nextState: "MANAGED", action: "none", restore: null });
  });

  it("needs repair when the settings name neither port or no port at all", async () => {
    for (const settingsPort of [null, 9999]) {
      const decision = await recover(await recordAt("STARTING", change), probe({ settingsPort }));
      expect(decision).toMatchObject({ nextState: "NEEDS_REPAIR", action: "repair", restore: null });
    }
  });

  it("does not decide by the settings while a child still runs (its port cannot be told from the journal)", async () => {
    const decision = await recover(
      await recordAt("STARTING", change),
      probe({ desktopChild: VERIFIED, oldServiceRunning: false, settingsPort: 3210 }),
    );
    // the generic rule only resumes verification; start-up recovery turns a resume into repair-only (see startup-recovery)
    expect(decision.action).toBe("resume");
  });

  it("does not bypass the database identity check or a migration", async () => {
    const other = await recover(await recordAt("STARTING", change), probe({ dbIdentity: DB_B }));
    expect(other).toMatchObject({ nextState: "NEEDS_REPAIR", action: "repair" });
    const migrated = await recover(await recordAt("STARTING", change), probe({ migrationEvidence: true }));
    expect(migrated).toMatchObject({ nextState: "NEEDS_REPAIR", migrationStarted: true });
  });

  it("leaves an operation that was already NEEDS_REPAIR to the generic rule", async () => {
    const record = { ...(await recordAt("STARTING", change)), phase: "NEEDS_REPAIR" as const };
    expect(await recover(record, probe())).toMatchObject({ nextState: "NEEDS_REPAIR", action: "repair" });
  });

  it("needs repair when the change recorded no ports, whatever the owner before was", async () => {
    const decision = await recover(await recordAt("STARTING", { kind: "change-port" }), probe({ settingsPort: 3210 }));
    // previousOwner EXTERNAL and no recorded ports: the settings cannot say which port won, so nothing is assumed
    expect(decision.action).toBe("repair");
  });
});
