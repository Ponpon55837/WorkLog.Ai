import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { basename, join } from "node:path";
import { setupMessages } from "@work-intelligence/desktop-core/shell/setup-i18n";
import {
  attachLog,
  closeQuietly,
  createSandbox,
  freePort,
  launchApp,
  makeSchemaOlder,
  portIsFree,
  readMainLog,
  removeSandbox,
  waitForManagedSnapshot,
  waitForSnapshot,
  type Sandbox,
} from "./helpers.js";

/**
 * File-system risk policy for the database (DT-08). A smoke test cannot mount a share or plug in a drive, so the test
 * build reads a synthetic `path prefix -> verdict` file (the real classifier is unit-tested per platform in
 * tests/desktop-core/storage-risk.test.ts). Synthetic data only; the native confirmation is auto-answered.
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

function verdictFile(box: Sandbox, verdicts: Record<string, string>): string {
  const file = join(box.root, "storage-risk.json");
  writeFileSync(file, JSON.stringify(verdicts));
  return file;
}

function digestOf(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function pageText(window: Page) {
  const lang = await window.evaluate(() => document.documentElement.lang);
  return setupMessages(lang === "zh-Hant" ? "zh-TW" : "en");
}

test("a committed database on a network drive stops the backend; 複製到本機磁碟並改用 switches to a local copy and leaves the original", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  // Only the original file is "network": the copy sits beside it under another name.
  const risks = verdictFile(sandbox, { [sandbox.databasePath]: "network" });
  const before = digestOf(sandbox.databasePath);
  app = await launchApp(sandbox, {
    WORK_INTELLIGENCE_DESKTOP_TEST_STORAGE_RISK_FILE: risks,
    WORK_INTELLIGENCE_DESKTOP_TEST_AUTOCONFIRM_COPY: "1",
  });

  const refused = await waitForSnapshot(
    app,
    (state) => state.owner === "NEEDS_REPAIR" && state.recentErrors.includes("DB_STORAGE_NETWORK"),
    60_000,
  );
  expect(refused.backend).toBeNull();

  await app.evaluate(() =>
    (
      globalThis as unknown as { __workIntelligenceDesktopTest: { openRepair(): void } }
    ).__workIntelligenceDesktopTest.openRepair(),
  );
  const window = await app.firstWindow({ timeout: 45_000 });
  const copy = window.locator('[data-id="copy-to-local"]');
  await expect(copy).toBeVisible({ timeout: 30_000 });
  await expect(copy).toHaveText((await pageText(window)).storageCopyToLocal);

  await copy.click();
  // The refusal is still the latest error until the switch lands, so no fail-fast here.
  const switched = await waitForSnapshot(app, (state) => state.owner === "MANAGED" && state.backend !== null, 90_000);
  expect(switched.owner).toBe("MANAGED");

  const settings = JSON.parse(readFileSync(join(sandbox.dataDirectory, "desktop-settings.json"), "utf8")) as {
    desired: { databasePath: string };
  };
  expect(basename(settings.desired.databasePath)).toBe("work-intelligence-local.sqlite");
  expect(settings.desired.databasePath).not.toBe(sandbox.databasePath);
  expect(existsSync(settings.desired.databasePath)).toBe(true);
  // The original is neither changed nor removed.
  expect(digestOf(sandbox.databasePath)).toBe(before);
  expect(readMainLog(sandbox)).not.toContain(sandbox.databasePath);
});

test("a risky source on the first-run page is never one click: its consent must be ticked first", async () => {
  sandbox = await createSandbox({ withDatabase: true, withSettings: false });
  const risks = verdictFile(sandbox, { [sandbox.databasePath]: "removable" });
  app = await launchApp(sandbox, {
    WORK_INTELLIGENCE_DESKTOP_TEST_STORAGE_RISK_FILE: risks,
    WORK_INTELLIGENCE_DESKTOP_TEST_DEFAULT_PORT: String(sandbox.port),
  });

  const window = await app.firstWindow({ timeout: 45_000 });
  await waitForSnapshot(app, (state) => state.firstRunDetectionMs !== null, 30_000);
  const card = window.locator("[data-source]").first();
  const note = card.locator('.storage-risk[data-risk="removable"]');
  await expect(note).toBeVisible({ timeout: 30_000 });
  const text = await pageText(window);
  await expect(note).toContainText(text.storageRisk.removable.label);

  const use = card.locator('[data-id^="use:"]');
  await expect(use).toBeDisabled();
  await card.locator('input[data-id^="risk:"]').check();
  await expect(use).toBeEnabled();
  await use.click();

  const ready = await waitForManagedSnapshot(app, 60_000);
  expect(ready.owner).toBe("MANAGED");
});

test("a database on unclassifiable storage is a soft note on the page and never blocks the start", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  const risks = verdictFile(sandbox, { [sandbox.databasePath]: "unknown" });
  app = await launchApp(sandbox, { WORK_INTELLIGENCE_DESKTOP_TEST_STORAGE_RISK_FILE: risks });
  const running = await waitForManagedSnapshot(app, 60_000);
  expect(running.owner).toBe("MANAGED");
  expect(running.recentErrors).toEqual([]);
  const status = await fetch(`http://127.0.0.1:${running.backend?.port}/api/system/status`);
  const body = (await status.json()) as { desktop?: { storageRisk?: { risk: string; migrationBlocked: boolean } } };
  expect(body.desktop?.storageRisk).toEqual({ risk: "unknown", migrationBlocked: false });
});

/** How many starts the controller refused for a database on a network share (one log line each). */
function refusedStarts(box: Sandbox): number {
  return readMainLog(box).split("start refused: the database is on a network share").length - 1;
}

test("retry after DB_STORAGE_NETWORK stays refused, and so does a port change: nothing is started on the share", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  const risks = verdictFile(sandbox, { [sandbox.databasePath]: "network" });
  app = await launchApp(sandbox, {
    WORK_INTELLIGENCE_DESKTOP_TEST_STORAGE_RISK_FILE: risks,
    WORK_INTELLIGENCE_DESKTOP_TEST_AUTOCONFIRM_PORT: "1",
  });
  await waitForSnapshot(
    app,
    (state) => state.owner === "NEEDS_REPAIR" && state.recentErrors.includes("DB_STORAGE_NETWORK"),
    60_000,
  );

  await app.evaluate(() =>
    (
      globalThis as unknown as { __workIntelligenceDesktopTest: { openPortSettings(): void } }
    ).__workIntelligenceDesktopTest.openPortSettings(),
  );
  const window = await app.firstWindow({ timeout: 45_000 });
  await expect(window.locator("#port-section")).toBeVisible({ timeout: 30_000 });

  // The repair page's retry: refused again, before anything is started.
  const afterFirst = refusedStarts(sandbox);
  await window.locator('[data-id="retry-start"]').click();
  await expect.poll(() => refusedStarts(sandbox as Sandbox), { timeout: 30_000 }).toBeGreaterThan(afterFirst);
  const retried = await waitForSnapshot(app, (state) => state.owner === "NEEDS_REPAIR", 30_000);
  expect(retried.backend).toBeNull();
  expect(retried.recentErrors).toContain("DB_STORAGE_NETWORK");
  expect(await portIsFree(sandbox.port)).toBe(true);

  // 「變更連接埠」 while stopped: also refused, and the new port is never bound.
  const newPort = await freePort();
  const afterRetry = refusedStarts(sandbox);
  await window.locator('[data-id="port-input"]').fill(String(newPort));
  await window.locator('[data-id="port-apply"]').click();
  await expect.poll(() => refusedStarts(sandbox as Sandbox), { timeout: 30_000 }).toBeGreaterThan(afterRetry);
  const changed = await waitForSnapshot(app, (state) => state.owner === "NEEDS_REPAIR", 30_000);
  expect(changed.backend).toBeNull();
  expect(await portIsFree(newPort)).toBe(true);
  expect(await portIsFree(sandbox.port)).toBe(true);
  const settings = JSON.parse(readFileSync(join(sandbox.dataDirectory, "desktop-settings.json"), "utf8")) as {
    desired: { port: number };
  };
  expect(settings.desired.port).toBe(sandbox.port);
});

test("the first-run page offers 複製到本機磁碟並改用 for a cloud-sync database that needs an update; the App ends on the copy and the original is untouched", async () => {
  sandbox = await createSandbox({ withDatabase: true, withSettings: false });
  // The previous release's schema, in a folder a sync client owns: the update is refused in place.
  makeSchemaOlder(sandbox.databasePath);
  const before = digestOf(sandbox.databasePath);
  const risks = verdictFile(sandbox, { [sandbox.databasePath]: "cloud-sync" });
  app = await launchApp(sandbox, {
    WORK_INTELLIGENCE_DESKTOP_TEST_STORAGE_RISK_FILE: risks,
    WORK_INTELLIGENCE_DESKTOP_TEST_AUTOCONFIRM_COPY: "1",
    WORK_INTELLIGENCE_DESKTOP_TEST_DEFAULT_PORT: String(sandbox.port),
  });

  const window = await app.firstWindow({ timeout: 45_000 });
  await waitForSnapshot(app, (state) => state.firstRunDetectionMs !== null, 30_000);
  const text = await pageText(window);
  const card = window.locator("[data-source]").first();
  await expect(card.locator('.storage-risk[data-risk="cloud-sync"]')).toBeVisible({ timeout: 30_000 });
  // The note points at the button, and the button is there; "use" is not.
  await expect(card.locator('[data-id^="use:"]')).toHaveCount(0);
  const copy = card.locator('[data-id^="copy-to-local:"]');
  await expect(copy).toHaveText(text.storageCopyToLocal);
  await copy.click();

  const ready = await waitForManagedSnapshot(app, 90_000);
  expect(ready.owner).toBe("MANAGED");
  const settings = JSON.parse(readFileSync(join(sandbox.dataDirectory, "desktop-settings.json"), "utf8")) as {
    desired: { databasePath: string; port: number };
  };
  expect(basename(settings.desired.databasePath)).toBe("work-intelligence-local.sqlite");
  expect(settings.desired.databasePath).not.toBe(sandbox.databasePath);
  // The copy was updated; the original is byte for byte what it was.
  const copied = new DatabaseSync(settings.desired.databasePath, { readOnly: true });
  const versions = copied.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number };
  copied.close();
  const original = new DatabaseSync(sandbox.databasePath, { readOnly: true });
  const olderVersions = original.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as {
    version: number;
  };
  original.close();
  expect(versions.version).toBeGreaterThan(olderVersions.version);
  expect(digestOf(sandbox.databasePath)).toBe(before);
  expect(readMainLog(sandbox)).not.toContain(sandbox.databasePath);
});
