import { describe, expect, it } from "vitest";
import { databaseTone } from "../../apps/desktop/src/renderer/repair/badge.js";
import { migrationOffer, retryIsPrimary } from "../../apps/desktop/src/renderer/repair/view-model.js";
import {
  allowMigrationFor,
  buildRepairState,
  buildStorageRiskView,
  databaseStatusFor,
  shellMessages,
  type RepairStateInputs,
  type StorageRisk,
} from "../../packages/desktop-core/src/index.js";

const base: RepairStateInputs = {
  platform: "linux",
  homeDirectory: "/synthetic/home",
  locale: "en",
  owner: "NEEDS_REPAIR",
  backend: "stopped",
  databasePath: "/synthetic/home/.work-intelligence/data/work-intelligence.sqlite",
  databaseStatus: "needs-migration",
  candidates: [],
  recentErrors: [],
  lastBackup: { status: "none" },
  retryOperationId: "00000000-0000-4000-8000-000000000000",
  busy: false,
};

function action(inputs: RepairStateInputs, id: string) {
  return buildRepairState(inputs).actions.find((entry) => entry.id === id);
}

function ownRisk(risk: StorageRisk) {
  return buildStorageRiskView({ risk, locale: "en", chosenByUser: true, needsMigration: true });
}

describe("the database status after an upgrade", () => {
  it.each([
    ["SCHEMA_MIGRATION_BLOCKED", "needs-migration"],
    ["SCHEMA_TOO_NEW", "unsupported-schema"],
    ["SCHEMA_SOMETHING_ELSE", "unsupported-schema"],
  ])("maps %s to %s", (code, expected) => {
    expect(databaseStatusFor(false, code)).toBe(expected);
  });

  it("is ok once the backend runs, whatever the last error was", () => {
    expect(databaseStatusFor(true, "SCHEMA_MIGRATION_BLOCKED")).toBe("ok");
  });

  it("is labelled 需要更新資料庫 / Needs update, while a newer schema stays 版本不支援 / Unsupported version", () => {
    expect(shellMessages("zh-TW").databaseStatuses["needs-migration"]).toBe("需要更新資料庫");
    expect(shellMessages("en").databaseStatuses["needs-migration"]).toBe("Needs update");
    expect(shellMessages("zh-TW").databaseStatuses["unsupported-schema"]).toBe("版本不支援");
    expect(shellMessages("en").databaseStatuses["unsupported-schema"]).toBe("Unsupported version");
    expect(databaseTone("needs-migration")).toBe("attention");
  });

  it("names the button and says the backup comes first, in both languages", () => {
    expect(shellMessages("zh-TW").actionApproveMigration).toBe("先備份再更新資料庫");
    expect(shellMessages("zh-TW").repairOwnMigrationNote).toBe("資料庫需要更新才能在這個版本使用，更新前會自動備份。");
    expect(shellMessages("zh-TW").actionCopyAndMigrate).toBe("複製到本機資料夾後更新");
    expect(shellMessages("en").actionApproveMigration).toBe("Back up and update database");
  });
});

describe("the approve-migration action", () => {
  it("is offered and enabled for the App's own database that needs an update", () => {
    expect(action(base, "approve-migration")).toEqual({ id: "approve-migration", enabled: true });
  });

  it("is disabled while another action runs", () => {
    expect(action({ ...base, busy: true }, "approve-migration")).toEqual({ id: "approve-migration", enabled: false });
  });

  it.each(["ok", "unsupported-schema", "missing", "unknown"] as const)("is not offered for status %s", (status) => {
    expect(action({ ...base, databaseStatus: status }, "approve-migration")).toBeUndefined();
  });

  it("is not offered without a database in the settings", () => {
    expect(action({ ...base, databasePath: null }, "approve-migration")).toBeUndefined();
  });

  it("keeps 重試啟動 in the list, but the page makes it secondary while the update waits", () => {
    const state = buildRepairState(base);
    expect(state.actions.map((entry) => entry.id)).toContain("retry-start");
    expect(retryIsPrimary(state)).toBe(false);
    expect(retryIsPrimary(buildRepairState({ ...base, databaseStatus: "missing" }))).toBe(true);
    expect(migrationOffer(state)).toBe("approve");
  });
});

describe("storage that refuses an update (DT-08)", () => {
  it.each(["cloud-sync", "removable", "hard-link"] as const)(
    "%s: no in-place update; the copy to a local folder is the offer",
    (risk) => {
      const inputs = { ...base, databaseStorageRisk: ownRisk(risk), databaseMigrationBlocked: true };
      const state = buildRepairState(inputs);
      expect(action(inputs, "approve-migration")).toBeUndefined();
      expect(state.database.storageRisk).toMatchObject({ risk, canCopyToLocal: true });
      expect(state.database.storageRisk?.migrationNote).toBeDefined();
      expect(migrationOffer(state)).toBe("copy");
      expect(allowMigrationFor(true, risk)).toBe(false);
    },
  );

  it("unknown storage never blocks the update: the button stays, with the soft note", () => {
    const inputs = { ...base, databaseStorageRisk: ownRisk("unknown"), databaseMigrationBlocked: false };
    const state = buildRepairState(inputs);
    expect(action(inputs, "approve-migration")?.enabled).toBe(true);
    expect(state.database.storageRisk?.canCopyToLocal).toBe(false);
    expect(migrationOffer(state)).toBe("approve");
    expect(allowMigrationFor(true, "unknown")).toBe(true);
  });

  it("offers nothing when the database does not need an update", () => {
    const state = buildRepairState({ ...base, databaseStatus: "ok", owner: "MANAGED", backend: "running" });
    expect(migrationOffer(state)).toBeNull();
  });
});
