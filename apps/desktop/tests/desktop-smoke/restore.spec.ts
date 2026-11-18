import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { WorkIntelligenceStore } from "@work-intelligence/storage";
import { restoreMessages, pickFailureText } from "@work-intelligence/desktop-core/shell/restore-i18n";
import {
  attachLog,
  closeQuietly,
  createSandbox,
  expectTabShown,
  launchApp,
  openWindow,
  readMainLog,
  removeSandbox,
  waitForManagedSnapshot,
  waitForSnapshot,
  type Sandbox,
} from "./helpers.js";

/**
 * 「從備份還原」 (H-02): the Data tab lists the backups of the database in use, chooses a file through a native dialog and
 * restores one. The native chooser and confirmation are answered by test switches (a pointer file names the chosen file; the
 * confirmation is auto-accepted). Every database here is synthetic.
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

/** The backup folder the App's settings name (the sandbox settings put it under the home), which is where it lists from. */
function backupsDirectory(box: Sandbox): string {
  return join(box.home, ".work-intelligence", "backups");
}

function projectNames(databasePath: string): string[] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return (database.prepare("SELECT name FROM projects ORDER BY name").all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
  } finally {
    database.close();
  }
}

/** A database with one project ("Kept") and a real backup of it, then one more project ("Added later") only in the database. */
function seedWithBackup(box: Sandbox, options: { keepDatabase: boolean }): void {
  const store = new WorkIntelligenceStore(box.databasePath, { backup: { directory: backupsDirectory(box) } });
  store.addProject("Kept", join(box.root, "kept"));
  const created = store.createBackup();
  expect(created).toHaveProperty("created");
  store.addProject("Added later", join(box.root, "added-later"));
  store.close();
  if (!options.keepDatabase) {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${box.databasePath}${suffix}`, { force: true });
  }
}

/**
 * The runtime root is shared by the whole smoke run, and an earlier spec's Agent self-test leaves a fresh lease there (it
 * counts as a live Agent for a few minutes by design, and a restore then refuses with "close your Agents"). Each restore spec
 * starts from a root with no Agent lease, as a user with no Agent running has.
 */
function launchWithoutAgentLeases(box: Sandbox, env: Record<string, string>): ReturnType<typeof launchApp> {
  rmSync(join(box.runtimeRoot, "leases"), { recursive: true, force: true });
  return launchApp(box, env);
}

function pointerTo(box: Sandbox, file: string): string {
  const pointer = join(box.root, "chosen-file.txt");
  writeFileSync(pointer, file);
  return pointer;
}

function alternatives(texts: readonly string[]): RegExp {
  return new RegExp(texts.map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"));
}

async function openDataTab(running: ElectronApplication): Promise<Page> {
  await openWindow(running, "data");
  const window = await running.firstWindow({ timeout: 45_000 });
  await expectTabShown(window, "data");
  await expect(window.locator("#restore-section")).toBeVisible({ timeout: 30_000 });
  return window;
}

test("restores a listed backup: confirmed, replaced, the service is back, and the earlier data is kept as a safety backup", async () => {
  sandbox = await createSandbox({ withDatabase: false });
  seedWithBackup(sandbox, { keepDatabase: true });
  const filesBefore = readdirSync(backupsDirectory(sandbox)).length;
  app = await launchWithoutAgentLeases(sandbox, { WORK_INTELLIGENCE_DESKTOP_TEST_AUTOCONFIRM_RESTORE: "1" });
  await waitForManagedSnapshot(app);
  const window = await openDataTab(app);

  await expect(window.locator('[data-id="restore-item-0"]')).toBeVisible({ timeout: 30_000 });
  await window.locator('[data-id="restore-item-0-run"]').click();

  await expect(window.locator('[data-id="restore-answer"]')).toBeVisible({ timeout: 60_000 });
  await waitForManagedSnapshot(app);
  expect(projectNames(sandbox.databasePath)).toEqual(["Kept"]);
  // The automatic safety backup of what was replaced exists next to the others.
  expect(readdirSync(backupsDirectory(sandbox)).length).toBeGreaterThan(filesBefore);
  expect(readMainLog(sandbox)).toContain("database restored from a backup");
});

test("refuses a chosen file that is not a Work Intelligence database, before any confirmation", async () => {
  sandbox = await createSandbox({ withDatabase: false });
  seedWithBackup(sandbox, { keepDatabase: true });
  const corrupt = join(sandbox.root, "not-a-database.sqlite");
  writeFileSync(corrupt, "synthetic bytes that are not a database ".repeat(50));
  app = await launchWithoutAgentLeases(sandbox, {
    WORK_INTELLIGENCE_DESKTOP_TEST_AUTOCONFIRM_RESTORE: "1",
    WORK_INTELLIGENCE_DESKTOP_TEST_RESTORE_CHOOSE_FILE: pointerTo(sandbox, corrupt),
  });
  await waitForManagedSnapshot(app);
  const window = await openDataTab(app);

  await window.locator('[data-id="restore-choose"]').click();
  const answer = window.locator('[data-id="restore-answer"]');
  await expect(answer).toBeVisible({ timeout: 30_000 });
  const expected = alternatives(
    (["zh-TW", "en"] as const).map((locale) =>
      pickFailureText(restoreMessages(locale), { ok: false, reason: "not-database" }),
    ),
  );
  await expect(answer).toHaveText(expected);
  await expect(window.locator('[data-id="restore-picked"]')).toHaveCount(0);
  expect(projectNames(sandbox.databasePath)).toEqual(["Added later", "Kept"]);
  expect(readMainLog(sandbox)).not.toContain("database restored from a backup");
});

test("refuses a backup made by a newer version of the App", async () => {
  sandbox = await createSandbox({ withDatabase: false });
  seedWithBackup(sandbox, { keepDatabase: true });
  const newer = join(sandbox.root, "from-the-future.sqlite");
  const source = new WorkIntelligenceStore(join(sandbox.root, "future-source.sqlite"));
  source.addProject("Future", join(sandbox.root, "future"));
  source.exportTo(newer);
  source.close();
  const database = new DatabaseSync(newer);
  database.exec("INSERT INTO schema_migrations (version, name, applied_at) VALUES (9999, 'future', '2030-01-01')");
  database.close();
  app = await launchWithoutAgentLeases(sandbox, {
    WORK_INTELLIGENCE_DESKTOP_TEST_AUTOCONFIRM_RESTORE: "1",
    WORK_INTELLIGENCE_DESKTOP_TEST_RESTORE_CHOOSE_FILE: pointerTo(sandbox, newer),
  });
  await waitForManagedSnapshot(app);
  const window = await openDataTab(app);

  await window.locator('[data-id="restore-choose"]').click();
  const answer = window.locator('[data-id="restore-answer"]');
  await expect(answer).toBeVisible({ timeout: 30_000 });
  const expected = alternatives(
    (["zh-TW", "en"] as const).map((locale) =>
      pickFailureText(restoreMessages(locale), { ok: false, reason: "newer-schema", schemaVersion: 9999 }),
    ),
  );
  await expect(answer).toHaveText(expected);
  expect(projectNames(sandbox.databasePath)).toEqual(["Added later", "Kept"]);
});

test("is reachable while the database is missing: restores a backup and the service starts", async () => {
  sandbox = await createSandbox({ withDatabase: false });
  seedWithBackup(sandbox, { keepDatabase: false });
  expect(existsSync(sandbox.databasePath)).toBe(false);
  app = await launchWithoutAgentLeases(sandbox, { WORK_INTELLIGENCE_DESKTOP_TEST_AUTOCONFIRM_RESTORE: "1" });
  const window = await app.firstWindow({ timeout: 45_000 });
  const snapshot = await waitForSnapshot(app, (state) => state.owner === "NEEDS_REPAIR" && state.repairWindowOpen);
  expect(snapshot.recentErrors).toContain("DB_MISSING");

  await expect(window.locator("#restore-section")).toBeVisible({ timeout: 30_000 });
  await expect(window.locator('[data-id="restore-item-0"]')).toBeVisible({ timeout: 30_000 });
  await window.locator('[data-id="restore-item-0-run"]').click();

  // The earlier DB_MISSING stays the latest error until the restored database starts, so wait for MANAGED itself rather
  // than failing fast on that expected, already-settled NEEDS_REPAIR.
  await waitForSnapshot(app, (state) => state.owner === "MANAGED" && state.backend !== null, 60_000);
  expect(existsSync(sandbox.databasePath)).toBe(true);
  expect(projectNames(sandbox.databasePath)).toEqual(["Kept"]);
});
