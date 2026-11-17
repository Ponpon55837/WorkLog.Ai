import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { setupMessages } from "@work-intelligence/desktop-core/shell/setup-i18n";
import {
  attachLog,
  closeQuietly,
  createSandbox,
  launchApp,
  portIsFree,
  readMainLog,
  readSnapshot,
  removeSandbox,
  waitForManagedSnapshot,
  waitForSnapshot,
  type Sandbox,
} from "./helpers.js";

/**
 * The first-run page (DT-01) and the old login service (`pnpm bootstrap`). Synthetic data only: every database is made
 * by the real store in the sandbox, and the old service is a synthetic detection result (the file detection itself is
 * unit-tested per platform in tests/desktop-core/legacy-service.test.ts).
 */

/** The agreed product budget for the first paint of the first-run page, with its defaults button. */
const FIRST_PAINT_BUDGET_MS = 1_000;

let sandbox: Sandbox | undefined;
let app: ElectronApplication | undefined;

test.afterEach(async ({ browserName: _browserName }, testInfo) => {
  if (sandbox) attachLog(testInfo, sandbox);
  await closeQuietly(app);
  app = undefined;
  if (sandbox) removeSandbox(sandbox);
  sandbox = undefined;
});

function settingsFile(box: Sandbox): string {
  return join(box.dataDirectory, "desktop-settings.json");
}

/** The page's own language decides which copy it shows; the test compares with the same catalogue. */
async function pageText(window: Page) {
  const lang = await window.evaluate(() => document.documentElement.lang);
  return setupMessages(lang === "zh-Hant" ? "zh-TW" : "en");
}

/** A synthetic detection of the old service on `databasePath`, in the shape main's test seam reads. */
function writeLegacyService(
  box: Sandbox,
  databasePath: string,
  state: { running: "running" | "stopped"; enabled?: "enabled" | "disabled" } = { running: "running" },
): string {
  const file = join(box.root, "legacy-service.json");
  const windows = process.platform === "win32";
  writeFileSync(
    file,
    JSON.stringify({
      kind: "found",
      platform: process.platform,
      definitionPath: join(box.home, "synthetic-service-definition"),
      definitionSource: "file",
      recognised: true,
      repositoryRoot: join(box.root, "checkout"),
      databasePath,
      port: 3210,
      running: state.running,
      ...(state.enabled === undefined ? {} : { enabled: state.enabled }),
      removeCommand: windows
        ? `cd /d "${join(box.root, "checkout")}" && pnpm service:uninstall`
        : `cd '${join(box.root, "checkout")}' && pnpm service:uninstall`,
      fallbackRemoveCommand: "synthetic-fallback-command",
    }),
  );
  return file;
}

test("an install with settings (an upgrade from 1.6.47/1.6.48) never shows the first-run page", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  const before = readFileSync(settingsFile(sandbox), "utf8");
  app = await launchApp(sandbox);

  const ready = await waitForManagedSnapshot(app);
  expect(ready.needsSetup).toBe(false);
  expect(ready.view).toBe("repair");
  expect(ready.repairWindowOpen).toBe(false);
  expect(ready.firstRunDetectionMs).toBeNull();
  expect(readMainLog(sandbox)).not.toMatch(/first-run/);
  // The settings the upgrade found stay the user's: same database, same port.
  const after = JSON.parse(readFileSync(settingsFile(sandbox), "utf8")) as { desired: unknown };
  expect(after.desired).toEqual((JSON.parse(before) as { desired: unknown }).desired);
});

test("a new install shows the first-run page with the defaults one click away and writes nothing before it", async ({
  browserName: _browserName,
}, testInfo) => {
  sandbox = await createSandbox({ withDatabase: false, withSettings: false });
  const launched = Date.now();
  app = await launchApp(sandbox, { WORK_INTELLIGENCE_DESKTOP_TEST_DEFAULT_PORT: String(sandbox.port) });

  const window = await app.firstWindow({ timeout: 45_000 });
  const defaults = window.locator('[data-id="use-defaults"]');
  await expect(defaults).toBeVisible({ timeout: 30_000 });
  const visibleAfterLaunchMs = Date.now() - launched;
  // From the page's own navigation start to the defaults button in the DOM: the paint never waits on the detection.
  const firstPaintMs = await window.evaluate(() => {
    const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return Math.round(performance.now() - (entry?.startTime ?? 0));
  });
  // The button is on the first screen from the first paint but is usable only once the detection has ended: a click
  // before that could create a new database next to one the user was never shown. Read the button first and the
  // detection second, so an enabled button proves the detection was already done.
  const enabledAtPaint = await defaults.isEnabled();
  const afterPaint = await readSnapshot(app);
  if (enabledAtPaint) expect(afterPaint.firstRunDetectionMs).not.toBeNull();

  const waiting = afterPaint;
  expect(waiting.needsSetup).toBe(true);
  expect(waiting.view).toBe("setup");
  expect(waiting.owner).toBe("UNCONFIGURED");
  expect(waiting.backend).toBeNull();
  // Nothing is written or created before the user chose.
  expect(existsSync(settingsFile(sandbox))).toBe(false);
  expect(existsSync(sandbox.databasePath)).toBe(false);
  expect(await portIsFree(sandbox.port)).toBe(true);

  const detected = await waitForSnapshot(app, (state) => state.firstRunDetectionMs !== null, 30_000);
  // Once the detection is done the button works, and on a new install it is the primary one.
  await expect(defaults).toBeEnabled();
  await expect(defaults).toHaveClass(/primary/);
  const numbers = {
    platform: process.platform,
    firstPaintMs,
    visibleAfterLaunchMs,
    detectionMs: detected.firstRunDetectionMs,
  };
  console.log(`[first-run timing] ${JSON.stringify(numbers)}`);
  testInfo.annotations.push({ type: "first-run-timing", description: JSON.stringify(numbers) });
  expect(firstPaintMs).toBeLessThan(FIRST_PAINT_BUDGET_MS);

  await defaults.click();
  const ready = await waitForManagedSnapshot(app, 60_000);
  expect(ready.backend?.port).toBe(sandbox.port);
  expect(ready.needsSetup).toBe(false);
  const written = JSON.parse(readFileSync(settingsFile(sandbox), "utf8")) as {
    desired: { databasePath: string; port: number; launchAtLogin: boolean };
  };
  expect(written.desired.databasePath).toBe(sandbox.databasePath);
  expect(written.desired.port).toBe(sandbox.port);
  expect(written.desired.launchAtLogin).toBe(false);
  expect(existsSync(sandbox.databasePath)).toBe(true);

  // Done: the next step is the Agent page, which opens in the same window and writes nothing by itself.
  const text = await pageText(window);
  await window.locator('[data-id="open-agents"]').click();
  await expect(window.getByRole("heading", { level: 1, name: text.agentsHeading })).toBeVisible();
  await expect(window.locator("[data-agent]")).toHaveCount(2);
  expect((await readSnapshot(app)).view).toBe("agents");
  expect(readMainLog(sandbox)).toMatch(/\[shell\] first-run detection /);
});

test("the old login service on the App's database holds the start back until the user says 仍要啟動", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  const legacyFile = writeLegacyService(sandbox, sandbox.databasePath);
  app = await launchApp(sandbox, { WORK_INTELLIGENCE_DESKTOP_TEST_LEGACY_SERVICE_FILE: legacyFile });

  const window = await app.firstWindow({ timeout: 45_000 });
  const held = await waitForSnapshot(
    app,
    (state) => state.owner === "NEEDS_REPAIR" && state.recentErrors.includes("LEGACY_SERVICE_ACTIVE"),
  );
  expect(held.backend).toBeNull();
  expect(await portIsFree(sandbox.port)).toBe(true);

  const text = await pageText(window);
  const card = window.locator("#legacy-service");
  await expect(card).toBeVisible();
  await expect(card).toContainText(text.legacyWarning);
  await expect(card.locator(".command-text").first()).toContainText("pnpm service:uninstall");
  // Held back on purpose: no automatic retry starts it behind the user's back.
  await new Promise((resolveWait) => setTimeout(resolveWait, 3_000));
  expect((await readSnapshot(app)).backend).toBeNull();

  window.once("dialog", (dialog) => void dialog.accept());
  await window.locator('[data-id="start-anyway"]').click();
  // Until the new start answers, the held-back error is still the latest one, so this waits for MANAGED itself rather
  // than failing fast on that earlier, expected NEEDS_REPAIR.
  const ready = await waitForSnapshot(app, (state) => state.owner === "MANAGED" && state.backend !== null);
  expect(ready.backend?.port).toBe(sandbox.port);
  const log = readMainLog(sandbox);
  expect(log).toMatch(/\[shell\] start held back/);
  expect(log).toMatch(/\[shell\] start anyway/);
});

test("the old login service on another database does not hold the App back", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  const legacyFile = writeLegacyService(sandbox, join(sandbox.root, "elsewhere", "work-intelligence.sqlite"));
  app = await launchApp(sandbox, { WORK_INTELLIGENCE_DESKTOP_TEST_LEGACY_SERVICE_FILE: legacyFile });

  const ready = await waitForManagedSnapshot(app);
  expect(ready.recentErrors).not.toContain("LEGACY_SERVICE_ACTIVE");
  expect(readMainLog(sandbox)).not.toMatch(/start held back/);
});

test("a failed default start takes back the database it created and writes no settings", async () => {
  sandbox = await createSandbox({ withDatabase: false, withSettings: false });
  // The test holds the default port, so the new App cannot listen on it and the start fails.
  const holder = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    holder.once("error", rejectListen);
    holder.listen(sandbox!.port, "127.0.0.1", () => resolveListen());
  });
  try {
    app = await launchApp(sandbox, { WORK_INTELLIGENCE_DESKTOP_TEST_DEFAULT_PORT: String(sandbox.port) });
    const window = await app.firstWindow({ timeout: 45_000 });
    const defaults = window.locator('[data-id="use-defaults"]');
    await waitForSnapshot(app, (state) => state.firstRunDetectionMs !== null, 30_000);
    await expect(defaults).toBeEnabled();
    await defaults.click();

    await expect(window.locator(".card.error")).toBeVisible({ timeout: 60_000 });
    expect(existsSync(sandbox.databasePath)).toBe(false);
    expect(existsSync(settingsFile(sandbox))).toBe(false);
    const state = await readSnapshot(app);
    expect(state.needsSetup).toBe(true);
    expect(state.owner).toBe("UNCONFIGURED");
    expect(readMainLog(sandbox)).toMatch(/first-run removed the database it created after a failed start/);
  } finally {
    await new Promise<void>((resolveClose) => holder.close(() => resolveClose()));
  }
});

test("a login start holds back when the old service is enabled on the App's database, though it is not running", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  const legacyFile = writeLegacyService(sandbox, sandbox.databasePath, { running: "stopped", enabled: "enabled" });
  app = await launchApp(sandbox, { WORK_INTELLIGENCE_DESKTOP_TEST_LEGACY_SERVICE_FILE: legacyFile }, ["--background"]);

  const held = await waitForSnapshot(
    app,
    (state) => state.owner === "NEEDS_REPAIR" && state.recentErrors.includes("LEGACY_SERVICE_ACTIVE"),
  );
  expect(held.backend).toBeNull();
  expect(await portIsFree(sandbox.port)).toBe(true);
  expect(readMainLog(sandbox)).toMatch(/start held back at login/);
});

test("an interactive start with the old service enabled but not running starts, with the warning", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  const legacyFile = writeLegacyService(sandbox, sandbox.databasePath, { running: "stopped", enabled: "enabled" });
  app = await launchApp(sandbox, { WORK_INTELLIGENCE_DESKTOP_TEST_LEGACY_SERVICE_FILE: legacyFile });

  const ready = await waitForManagedSnapshot(app);
  expect(ready.recentErrors).not.toContain("LEGACY_SERVICE_ACTIVE");
  expect(readMainLog(sandbox)).not.toMatch(/start held back/);
});

test("a login start with the old service not installed or disabled starts normally", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  const legacyFile = writeLegacyService(sandbox, sandbox.databasePath, { running: "stopped", enabled: "disabled" });
  app = await launchApp(sandbox, { WORK_INTELLIGENCE_DESKTOP_TEST_LEGACY_SERVICE_FILE: legacyFile }, ["--background"]);

  const ready = await waitForManagedSnapshot(app);
  expect(ready.recentErrors).not.toContain("LEGACY_SERVICE_ACTIVE");
});
