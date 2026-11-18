import { expect, test, type ElectronApplication } from "@playwright/test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { LATEST_SCHEMA_VERSION } from "@work-intelligence/storage";
import {
  attachLog,
  closeQuietly,
  createSandbox,
  launchApp,
  expectTabShown,
  makeSchemaOlder,
  openTab,
  openWindow,
  shellText,
  tabButton,
  windowCount,
  processIsAlive,
  readSnapshot,
  removeSandbox,
  waitForManagedSnapshot,
  waitForSnapshot,
  type Sandbox,
} from "./helpers.js";

/**
 * R06 with a real backend child: the user agrees to a schema update on the first-run page, the child is held before it
 * opens the database (a test-build seam: WORK_INTELLIGENCE_DESKTOP_TEST_HOLD_MIGRATION_FILE, passed to the child only by
 * an unpackaged test build), and the test kills it. The App must end in NEEDS_REPAIR with `migrationStarted` journaled and
 * must never hand the database to an outside service (EXTERNAL); a retry then updates the database exactly once.
 * Synthetic data only.
 */

interface JournalRecord {
  kind: string;
  phase: string;
  status: string;
  migrationStarted: boolean;
  recoveryPolicy: string;
}

let sandbox: Sandbox | undefined;
let app: ElectronApplication | undefined;

test.afterEach(async ({ browserName: _browserName }, testInfo) => {
  if (sandbox) attachLog(testInfo, sandbox);
  await closeQuietly(app);
  app = undefined;
  if (sandbox) removeSandbox(sandbox);
  sandbox = undefined;
});

function journalRecords(box: Sandbox): JournalRecord[] {
  const file = join(box.dataDirectory, "operations-journal.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { records: JournalRecord[] }).records : [];
}

function schemaVersion(databasePath: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return (database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number })
      .version;
  } finally {
    database.close();
  }
}

/** The pre-migration backups in the backup folder the sandbox's settings name. */
function migrationBackups(box: Sandbox): string[] {
  const directory = join(box.home, ".work-intelligence", "backups");
  return existsSync(directory) ? readdirSync(directory).filter((name) => name.includes("pre-migration-")) : [];
}

test("a backend killed while it is held at the start of an approved update ends in NEEDS_REPAIR, never EXTERNAL; repairing updates once", async () => {
  // Its own waits add up to about 285 s in the worst case (45 + 30 + 60 + 60 + 30 + 90 plus the snapshot waits).
  test.setTimeout(300_000);
  // An existing install (settings) whose database is one release behind: the start is refused until the user agrees.
  const box = await createSandbox({ withDatabase: true });
  sandbox = box;
  makeSchemaOlder(box.databasePath);
  const olderVersion = LATEST_SCHEMA_VERSION - 1;
  expect(schemaVersion(box.databasePath)).toBe(olderVersion);
  const release = join(box.root, "release-migration");
  app = await launchApp(box, { WORK_INTELLIGENCE_DESKTOP_TEST_HOLD_MIGRATION_FILE: release });
  // Every owner state the App shows from here on, so "never EXTERNAL" covers the moments between the test's own reads.
  const owners = new Set<string>();
  let watching = true;
  const watcher = (async () => {
    while (watching) {
      try {
        owners.add((await readSnapshot(app as ElectronApplication)).owner);
      } catch {
        // The App is closing.
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  })();

  try {
    const window = await app.firstWindow({ timeout: 45_000 });
    const refused = await waitForSnapshot(app, (state) => state.owner === "NEEDS_REPAIR" && state.repairWindowOpen);
    expect(refused.recentErrors).toContain("SCHEMA_MIGRATION_BLOCKED");
    expect(refused.backend).toBeNull();
    // The native file dialog cannot be driven: main's dialog answers with the database under repair.
    await app.evaluate(({ dialog }, picked) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [picked],
      })) as typeof dialog.showOpenDialog;
    }, box.databasePath);
    // The refusal opened Status; choosing a database is the Data tab's.
    await openTab(window, "data");
    await window.locator('[data-id="choose-database"]').click();
    // Pressing the candidate's button is the user's consent to the update.
    const confirm = window.locator('[data-id^="candidate:"]');
    await expect(confirm).toHaveCount(1, { timeout: 30_000 });
    await confirm.click();

    // The child is held before it opens the database; the operation is journaled with migrationStarted already.
    await expect.poll(() => existsSync(`${release}.held`), { timeout: 60_000 }).toBe(true);
    const childPid = Number(readFileSync(`${release}.held`, "utf8"));
    expect(childPid).toBeGreaterThan(0);
    expect(processIsAlive(childPid)).toBe(true);
    const during = journalRecords(box).filter((record) => record.migrationStarted);
    expect(during).toHaveLength(1);
    expect(during[0]).toMatchObject({ status: "in-progress", recoveryPolicy: "repair-only" });
    expect(schemaVersion(box.databasePath)).toBe(olderVersion);

    // The operation in flight is marked on the tab it belongs to (Data), by the tab's accessible name, and nowhere else.
    const text = await shellText(window);
    await expect(tabButton(window, "data")).toHaveAccessibleName(new RegExp(text.tabBusyLabel));
    await expect(tabButton(window, "settings")).not.toHaveAccessibleName(new RegExp(text.tabBusyLabel));
    // A tray or route request for another tab and a manual switch back do not start the operation a second time.
    await openWindow(app, "settings");
    await expectTabShown(window, "settings");
    await openTab(window, "data");
    expect(await windowCount(app)).toBe(1);
    await expect(tabButton(window, "data")).toHaveAccessibleName(new RegExp(text.tabBusyLabel));
    expect(journalRecords(box).filter((record) => record.migrationStarted)).toHaveLength(1);

    process.kill(childPid, "SIGKILL");

    await expect
      .poll(() => journalRecords(box).find((record) => record.migrationStarted)?.status, { timeout: 60_000 })
      .toBe("failed");
    const repair = await waitForSnapshot(app, (state) => state.owner === "NEEDS_REPAIR" && state.backend === null);
    expect(repair.owner).toBe("NEEDS_REPAIR");
    expect(processIsAlive(childPid)).toBe(false);
    expect(journalRecords(box).find((record) => record.migrationStarted)).toMatchObject({
      phase: "NEEDS_REPAIR",
      recoveryPolicy: "repair-only",
    });
    // The child died before the store was opened: the database is as it was and no backup was made yet.
    expect(schemaVersion(box.databasePath)).toBe(olderVersion);
    expect(migrationBackups(box)).toEqual([]);

    // Repair again with the hold released: the update runs exactly once.
    writeFileSync(release, "");
    await expect(confirm).toBeEnabled({ timeout: 30_000 });
    await confirm.click();
    const ready = await waitForManagedSnapshot(app, 90_000);
    expect(ready.owner).toBe("MANAGED");
    expect(schemaVersion(box.databasePath)).toBe(LATEST_SCHEMA_VERSION);
    expect(migrationBackups(box)).toHaveLength(1);
    const started = journalRecords(box).filter((record) => record.migrationStarted);
    expect(started.map((record) => record.status)).toEqual(["failed", "completed"]);
  } finally {
    watching = false;
    await watcher;
  }
  expect(owners.has("NEEDS_REPAIR")).toBe(true);
  expect(owners.has("EXTERNAL")).toBe(false);
  expect(journalRecords(box).some((record) => record.phase === "EXTERNAL")).toBe(false);
});
