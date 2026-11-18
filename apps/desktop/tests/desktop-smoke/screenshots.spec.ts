import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppTab } from "@work-intelligence/desktop-core";
import {
  attachLog,
  closeQuietly,
  createSandbox,
  expectTabShown,
  launchApp,
  openTab,
  openWindow,
  removeSandbox,
  waitForManagedSnapshot,
  waitForSnapshot,
  type Sandbox,
} from "./helpers.js";

/**
 * Screenshots of the real tabbed window, taken in real Electron for review (CI uploads them as an artifact; nothing is
 * compared against a baseline, so a changed look never fails a run). One file per state, tab, language and colour scheme:
 *
 *   apps/desktop/screenshots/<platform>/<state>-<tab>-<locale>-<scheme>.png
 *
 * Every saved path is printed. The page is captured at a device scale factor of 2 where Chromium accepts the override.
 * Synthetic data only. The whole spec is built to take well under 90 s: four launches and about two dozen captures.
 */

const here = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolve(here, "..", "..", "screenshots", process.platform);

type Scheme = "light" | "dark";
const SCHEMES: readonly Scheme[] = ["light", "dark"];
type Locale = "en" | "zh-TW";

let sandbox: Sandbox | undefined;
let app: ElectronApplication | undefined;

test.afterEach(async ({ browserName: _browserName }, testInfo) => {
  if (sandbox) attachLog(testInfo, sandbox);
  await closeQuietly(app);
  app = undefined;
  if (sandbox) removeSandbox(sandbox);
  sandbox = undefined;
});

/** Asks Chromium for a device scale factor of 2 at the window's own size; false when it refuses (the shot is then 1x). */
async function scaleUp(window: Page): Promise<boolean> {
  try {
    const session = await window.context().newCDPSession(window);
    const size = await window.evaluate(() => ({ width: globalThis.innerWidth, height: globalThis.innerHeight }));
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: size.width,
      height: size.height,
      deviceScaleFactor: 2,
      mobile: false,
    });
    return true;
  } catch {
    return false;
  }
}

/** The language the page actually shows (it follows the OS), in the file name's spelling. */
async function pageLocale(window: Page): Promise<Locale> {
  return (await window.evaluate(() => document.documentElement.lang)) === "zh-Hant" ? "zh-TW" : "en";
}

async function shoot(window: Page, state: string, tab: string, scheme: Scheme): Promise<void> {
  await window.emulateMedia({ colorScheme: scheme });
  await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme)).toBe(scheme);
  // Fonts and two frames, so the capture is of a settled page.
  await window.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
  });
  const file = join(OUTPUT, `${state}-${tab}-${await pageLocale(window)}-${scheme}.png`);
  mkdirSync(OUTPUT, { recursive: true });
  await window.screenshot({ path: file, animations: "disabled", caret: "hide" });
  process.stdout.write(`[screenshot] ${file}\n`);
}

async function allSchemes(window: Page, state: string, tab: string): Promise<void> {
  for (const scheme of SCHEMES) await shoot(window, state, tab, scheme);
}

async function launchReady(locale: Locale): Promise<Page> {
  sandbox = await createSandbox({ withDatabase: true });
  const extra: Record<string, string> =
    locale === "zh-TW" ? { LANGUAGE: "zh_TW", LC_ALL: "zh_TW.UTF-8", LANG: "zh_TW.UTF-8" } : {};
  app = await launchApp(sandbox, extra, locale === "zh-TW" ? ["--lang=zh-TW"] : []);
  await waitForManagedSnapshot(app);
  await openWindow(app, "status");
  const window = await app.firstWindow({ timeout: 45_000 });
  await expectTabShown(window, "status");
  await scaleUp(window);
  return window;
}

test("screenshots: every tab of a running App in light and dark, and the diagnostics preview", async () => {
  test.setTimeout(120_000);
  const window = await launchReady("en");
  for (const tab of ["status", "agent", "settings", "data", "diagnostics"] as const satisfies readonly AppTab[]) {
    await openTab(window, tab);
    await expect(window.locator(`#panel-${tab}`)).not.toBeEmpty();
    if (tab === "agent") await window.locator("[data-agent]").first().waitFor({ state: "attached", timeout: 20_000 });
    await allSchemes(window, "ready", tab);
  }

  // The diagnostics preview dialog (a modal over the Diagnostics tab).
  await openTab(window, "diagnostics");
  await window.locator('[data-id="export-diagnostics"]').click();
  const dialog = window.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog.locator("textarea")).not.toHaveValue("");
  await allSchemes(window, "ready", "diagnostics-preview");
  await window.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("screenshots: Traditional Chinese for Status and Settings", async () => {
  test.setTimeout(90_000);
  const window = await launchReady("zh-TW");
  // The language follows the OS; the files are named after what the page really showed.
  for (const tab of ["status", "settings"] as const) {
    await openTab(window, tab);
    await expect(window.locator(`#panel-${tab}`)).not.toBeEmpty();
    await allSchemes(window, "ready", tab);
  }
});

test("screenshots: the blocking state of a missing database (Status and Data)", async () => {
  test.setTimeout(90_000);
  sandbox = await createSandbox({ withDatabase: false });
  app = await launchApp(sandbox);
  const window = await app.firstWindow({ timeout: 45_000 });
  await waitForSnapshot(app, (state) => state.owner === "NEEDS_REPAIR" && state.repairWindowOpen);
  await expectTabShown(window, "status");
  await expect(window.getByText("DB_MISSING")).toBeVisible();
  await scaleUp(window);
  await allSchemes(window, "needs-repair", "status");
  await openTab(window, "data");
  await expect(window.locator("#panel-data")).not.toBeEmpty();
  await allSchemes(window, "needs-repair", "data");
});

test("screenshots: the first-run Setup tab of a new install", async () => {
  test.setTimeout(90_000);
  sandbox = await createSandbox({ withDatabase: false, withSettings: false });
  app = await launchApp(sandbox, { WORK_INTELLIGENCE_DESKTOP_TEST_DEFAULT_PORT: String(sandbox.port) });
  const window = await app.firstWindow({ timeout: 45_000 });
  await waitForSnapshot(app, (state) => state.firstRunDetectionMs !== null, 30_000);
  await expectTabShown(window, "setup");
  await expect(window.locator('[data-id="use-defaults"]')).toBeEnabled({ timeout: 30_000 });
  await scaleUp(window);
  await allSchemes(window, "needs-setup", "setup");
});
