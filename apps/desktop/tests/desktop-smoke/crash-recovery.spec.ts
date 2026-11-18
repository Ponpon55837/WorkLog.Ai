import { expect, test, type ElectronApplication } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { formatMessage } from "@work-intelligence/desktop-core/shell/i18n";
import { WorkIntelligenceStore } from "@work-intelligence/storage";
import {
  attachLog,
  closeQuietly,
  createSandbox,
  expectTabShown,
  freePort,
  launchApp,
  openWindow,
  portIsFree,
  processIsAlive,
  readSnapshot,
  removeSandbox,
  shellText,
  waitForManagedSnapshot,
  type Sandbox,
} from "./helpers.js";

/**
 * Crash recovery (H-01): the App's main process is killed in the middle of a port change and of a database switch, at the
 * commit step (the new backend verified, the settings not written yet; a test-build seam, see test-pause.ts). The next
 * start must close the interrupted operation from the REAL state (the settings file), leave the old port and database in
 * place, start the service normally and say on the Status tab what happened and what the user can do. Synthetic data only.
 */

interface JournalRecord {
  operationId: string;
  kind: string;
  phase: string;
  status: string;
  recoveryNotice: { kind: string; port: number | null; attemptedPort: number | null; acknowledged: boolean } | null;
}

interface SettingsFile {
  desired: { port: number; databasePath: string };
  active?: { port: number; databasePath?: string };
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

function readSettings(box: Sandbox): SettingsFile {
  return JSON.parse(readFileSync(join(box.dataDirectory, "desktop-settings.json"), "utf8")) as SettingsFile;
}

/** Ends the App's main process the way a crash or power loss does (no quit handlers run), then waits for its backend. */
async function crash(running: ElectronApplication, box: Sandbox, pauseFile: string, kind: string): Promise<void> {
  await expect.poll(() => existsSync(`${pauseFile}.reached`), { timeout: 90_000 }).toBe(true);
  expect(JSON.parse(readFileSync(`${pauseFile}.reached`, "utf8"))).toEqual({ kind });
  // The operation is in progress in the journal at this very moment.
  const open = journalRecords(box).filter((record) => record.kind === kind && record.status === "in-progress");
  expect(open).toHaveLength(1);
  const pid = running.process().pid;
  expect(pid).toBeGreaterThan(0);
  // What runs at this moment: the backend that is up while the commit step is held (it may serve another port).
  const backend = (await readSnapshot(running)).backend;
  process.kill(pid as number, "SIGKILL");
  // A power loss ends every process of the App. A forced end of the main process on Windows does not reach its child (no
  // process tree), so the backend is ended too; the point here is what the next start recovers from, not the orphan.
  if (process.platform === "win32" && backend && processIsAlive(backend.pid)) process.kill(backend.pid, "SIGKILL");
  // Nothing of the App holds a port any more, so the next start can use them.
  for (const port of new Set([box.port, backend?.port ?? box.port])) {
    await expect.poll(() => portIsFree(port), { timeout: 60_000 }).toBe(true);
  }
}

/** After the restart: every operation is closed, and the Status tab shows the one notice for the interrupted kind. */
async function expectClosedWithNotice(
  running: ElectronApplication,
  box: Sandbox,
  kind: string,
  noticeKind: string,
): Promise<{ record: JournalRecord; message: string; nextStep: string }> {
  const window = await running.firstWindow({ timeout: 60_000 });
  await expectTabShown(window, "status");
  const interrupted = journalRecords(box).filter((record) => record.kind === kind);
  expect(interrupted).toHaveLength(1);
  const record = interrupted[0] as JournalRecord;
  expect(journalRecords(box).filter((entry) => entry.status === "in-progress")).toEqual([]);
  expect(record).toMatchObject({ status: "interrupted", recoveryNotice: { kind: noticeKind, acknowledged: false } });
  const card = window.locator(`[data-id="recovery-notice:${record.operationId}"]`);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toHaveAttribute("data-kind", noticeKind);
  const text = await shellText(window);
  const values = {
    port: String(record.recoveryNotice?.port ?? ""),
    attempted: String(record.recoveryNotice?.attemptedPort ?? ""),
    operation: text.recoveryOperationNames[kind as keyof typeof text.recoveryOperationNames],
  };
  const message = formatMessage(text.recoveryNotices[noticeKind as keyof typeof text.recoveryNotices], values);
  const nextStep = text.recoveryNextSteps[noticeKind as keyof typeof text.recoveryNextSteps];
  await expect(card.locator(".intro")).toHaveText(message);
  await expect(card).toContainText(nextStep);
  // Never a bare "an error occurred", and never a command or terminal for the user to type.
  const shown = (await card.innerText()).toLowerCase();
  expect(shown).not.toMatch(/pnpm|npm|terminal|command|終端|指令/);
  expect(shown.length).toBeGreaterThan(message.length);

  // Dismissing it is remembered: the journal says so, and a later page load does not show it again.
  await card.locator(`[data-id="recovery-dismiss:${record.operationId}"]`).click();
  await expect(card).toHaveCount(0, { timeout: 30_000 });
  await expect
    .poll(() => journalRecords(box).find((entry) => entry.operationId === record.operationId)?.recoveryNotice, {
      timeout: 30_000,
    })
    .toMatchObject({ acknowledged: true });
  await window.reload();
  await expectTabShown(window, "status");
  await expect(window.locator('[data-id^="recovery-notice:"]')).toHaveCount(0);
  return { record, message, nextStep };
}

test("a crash in the middle of a port change keeps the old port, closes the journal and says so on Status", async () => {
  test.setTimeout(300_000);
  const box = await createSandbox({ withDatabase: true });
  sandbox = box;
  const oldPort = box.port;
  const newPort = await freePort();
  const pauseFile = join(box.root, "pause-port");
  app = await launchApp(box, {
    WORK_INTELLIGENCE_DESKTOP_TEST_AUTOCONFIRM_PORT: "1",
    WORK_INTELLIGENCE_DESKTOP_TEST_PAUSE_OPERATION_FILE: pauseFile,
  });
  await waitForManagedSnapshot(app);
  await app.evaluate(() =>
    (
      globalThis as unknown as { __workIntelligenceDesktopTest: { openPortSettings(): void } }
    ).__workIntelligenceDesktopTest.openPortSettings(),
  );
  const window = await app.firstWindow({ timeout: 45_000 });
  await expectTabShown(window, "settings");
  await window.locator('[data-id="port-input"]').fill(String(newPort));
  await window.locator('[data-id="port-apply"]').click();

  await crash(app, box, pauseFile, "change-port");
  app = undefined;
  // Nothing was committed: the settings still name the old port.
  expect(readSettings(box).desired.port).toBe(oldPort);

  // The next start (no pause) recovers, starts the service on the old port and tells the user.
  app = await launchApp(box);
  const after = await waitForManagedSnapshot(app, 90_000);
  expect(after.backend?.port).toBe(oldPort);
  expect(readSettings(box).desired.port).toBe(oldPort);
  const { record } = await expectClosedWithNotice(app, box, "change-port", "port-kept");
  expect(record.recoveryNotice).toMatchObject({ port: oldPort, attemptedPort: newPort });
  expect(readSettings(box).desired.port).toBe(oldPort);
});

test("a crash in the middle of a database switch keeps the previous database, closes the journal and says so on Status", async () => {
  test.setTimeout(300_000);
  const box = await createSandbox({ withDatabase: true });
  sandbox = box;
  // A second synthetic database with the current schema, in a folder of its own.
  const otherDirectory = join(box.root, "other-data");
  mkdirSync(otherDirectory, { recursive: true });
  const otherDatabase = join(otherDirectory, "other.sqlite");
  new WorkIntelligenceStore(otherDatabase).close();
  const pauseFile = join(box.root, "pause-db");
  app = await launchApp(box, { WORK_INTELLIGENCE_DESKTOP_TEST_PAUSE_OPERATION_FILE: pauseFile });
  await waitForManagedSnapshot(app);
  await openWindow(app, "data");
  const window = await app.firstWindow({ timeout: 45_000 });
  await expectTabShown(window, "data");
  // The native file dialog cannot be driven: main's dialog answers with the other database.
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [picked],
    })) as typeof dialog.showOpenDialog;
  }, otherDatabase);
  await window.locator('[data-id="choose-database"]').click();
  const confirm = window.locator('[data-id^="candidate:"]');
  await expect(confirm).toHaveCount(1, { timeout: 30_000 });
  await confirm.click();

  await crash(app, box, pauseFile, "change-db");
  app = undefined;
  // Nothing was committed: the settings still name the first database.
  expect(readSettings(box).desired.databasePath).toBe(box.databasePath);

  app = await launchApp(box);
  const after = await waitForManagedSnapshot(app, 90_000);
  expect(after.backend?.port).toBe(box.port);
  expect(readSettings(box).desired.databasePath).toBe(box.databasePath);
  await expectClosedWithNotice(app, box, "change-db", "db-kept");
  expect(readSettings(box).desired.databasePath).toBe(box.databasePath);
});
