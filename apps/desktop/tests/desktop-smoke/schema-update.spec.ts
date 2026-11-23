import { expect, test, type ElectronApplication } from "@playwright/test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { basename, join } from "node:path";
import { LATEST_SCHEMA_VERSION } from "@work-intelligence/storage";
import {
  attachLog,
  closeQuietly,
  createSandbox,
  expectTabShown,
  launchApp,
  makeSchemaOlder,
  openTab,
  removeSandbox,
  shellText,
  waitForSnapshot,
  type Sandbox,
} from "./helpers.js";

/**
 * After an upgrade the App's own database is one schema behind (the 1.6.63 → 1.6.64 report): the start is refused with
 * SCHEMA_MIGRATION_BLOCKED, Status says 「需要更新資料庫」 and one press of 「先備份再更新資料庫」 backs it up, updates it
 * and starts, with no file to pick. On a sync folder the update is not offered in place; 「複製到本機資料夾後更新」 copies
 * it to the App's data folder and updates the copy, leaving the original as it was. Synthetic data only.
 */

let sandbox: Sandbox | undefined;
let app: ElectronApplication | undefined;

test.afterEach(async ({ browserName: _browserName }, testInfo) => {
  if (sandbox) attachLog(testInfo, sandbox);
  await closeQuietly(app);
  app = undefined;
  if (sandbox) removeSandbox(sandbox);
  sandbox = undefined;
});

function schemaVersion(databasePath: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return (database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number })
      .version;
  } finally {
    database.close();
  }
}

function migrationBackups(box: Sandbox): string[] {
  const directory = join(box.home, ".work-intelligence", "backups");
  return existsSync(directory) ? readdirSync(directory).filter((name) => name.includes("pre-migration-")) : [];
}

function digestOf(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

test("a database one schema behind is updated by one press of 先備份再更新資料庫, after a backup", async () => {
  test.setTimeout(180_000);
  const box = await createSandbox({ withDatabase: true });
  sandbox = box;
  makeSchemaOlder(box.databasePath);
  expect(schemaVersion(box.databasePath)).toBe(LATEST_SCHEMA_VERSION - 1);
  app = await launchApp(box);

  const window = await app.firstWindow({ timeout: 45_000 });
  const refused = await waitForSnapshot(app, (state) => state.owner === "NEEDS_REPAIR" && state.repairWindowOpen);
  expect(refused.recentErrors).toContain("SCHEMA_MIGRATION_BLOCKED");
  await expectTabShown(window, "status");
  const text = await shellText(window);
  await expect(window.locator("#panel-status")).toContainText(text.databaseStatuses["needs-migration"] as string);
  await expect(window.locator("#panel-status")).toContainText(text.repairOwnMigrationNote);
  await expect(window.locator("#panel-status")).not.toContainText(
    text.databaseStatuses["unsupported-schema"] as string,
  );

  const approve = window.locator('#panel-status [data-id="approve-migration"]');
  await expect(approve).toHaveText(text.actionApproveMigration);
  await expect(approve).toHaveClass(/primary/);
  // Retrying alone cannot update the database: it steps back while the update waits.
  await expect(window.locator('#panel-status [data-id="retry-start"]')).not.toHaveClass(/primary/);
  // The Data tab offers the same button.
  await openTab(window, "data");
  await expect(window.locator('#panel-data [data-id="approve-migration"]')).toBeVisible();
  await openTab(window, "status");

  await approve.click();
  // The refusal stays the latest error until the start lands, so no fail-fast here.
  const ready = await waitForSnapshot(app, (state) => state.owner === "MANAGED" && state.backend !== null, 90_000);
  expect(ready.owner).toBe("MANAGED");
  expect(schemaVersion(box.databasePath)).toBe(LATEST_SCHEMA_VERSION);
  expect(migrationBackups(box)).toHaveLength(1);
  // The settings still name the same file: nothing was picked or moved.
  const settings = JSON.parse(readFileSync(join(box.dataDirectory, "desktop-settings.json"), "utf8")) as {
    desired: { databasePath: string };
  };
  expect(settings.desired.databasePath).toBe(box.databasePath);
});

test("on a sync folder the update is not offered in place: 複製到本機資料夾後更新 updates a local copy and keeps the original", async () => {
  test.setTimeout(180_000);
  const box = await createSandbox({ withDatabase: true });
  sandbox = box;
  makeSchemaOlder(box.databasePath);
  const risks = join(box.root, "storage-risk.json");
  writeFileSync(risks, JSON.stringify({ [box.databasePath]: "cloud-sync" }));
  const before = digestOf(box.databasePath);
  app = await launchApp(box, {
    WORK_INTELLIGENCE_DESKTOP_TEST_STORAGE_RISK_FILE: risks,
    WORK_INTELLIGENCE_DESKTOP_TEST_AUTOCONFIRM_COPY: "1",
  });

  const window = await app.firstWindow({ timeout: 45_000 });
  await waitForSnapshot(
    app,
    (state) => state.owner === "NEEDS_REPAIR" && state.recentErrors.includes("SCHEMA_MIGRATION_BLOCKED"),
    60_000,
  );
  const text = await shellText(window);
  const copy = window.locator('#panel-status [data-id="copy-to-local"]');
  await expect(copy).toHaveText(text.actionCopyAndMigrate, { timeout: 30_000 });
  await expect(copy).toHaveClass(/primary/);
  await expect(window.locator("#panel-status")).toContainText(text.repairOwnMigrationCopyNote);
  await expect(window.locator('[data-id="approve-migration"]')).toHaveCount(0);

  await copy.click();
  const switched = await waitForSnapshot(app, (state) => state.owner === "MANAGED" && state.backend !== null, 90_000);
  expect(switched.owner).toBe("MANAGED");
  const settings = JSON.parse(readFileSync(join(box.dataDirectory, "desktop-settings.json"), "utf8")) as {
    desired: { databasePath: string };
  };
  expect(basename(settings.desired.databasePath)).toBe("work-intelligence-local.sqlite");
  expect(schemaVersion(settings.desired.databasePath)).toBe(LATEST_SCHEMA_VERSION);
  // The original on the sync folder is neither updated nor changed.
  expect(digestOf(box.databasePath)).toBe(before);
});
