import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shellMessages, type ShellLocale } from "@work-intelligence/desktop-core";
import {
  attachLog,
  closeQuietly,
  createSandbox,
  expectTabShown,
  launchApp,
  openWindow,
  removeSandbox,
  trayMenu,
  waitForManagedSnapshot,
  type Sandbox,
} from "./helpers.js";

/**
 * The 「語言」 card on the Settings tab: a choice redraws the window and the tray at once, is saved, and the Dashboard the
 * App manages is told the same language; a language picked in the Dashboard becomes the App's. Synthetic data only.
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

function savedLanguage(box: Sandbox): string | undefined {
  const settings = JSON.parse(readFileSync(join(box.dataDirectory, "desktop-settings.json"), "utf8")) as {
    desired: { language?: string };
  };
  return settings.desired.language;
}

async function expectShellLanguage(app: ElectronApplication, window: Page, locale: ShellLocale): Promise<void> {
  const text = shellMessages(locale);
  await expect(window.locator("html")).toHaveAttribute("lang", locale === "zh-TW" ? "zh-Hant" : "en", {
    timeout: 15_000,
  });
  await expect(window.locator('[role="tab"][data-tab="settings"]')).toContainText(text.tabLabels.settings);
  await expect
    .poll(async () => (await trayMenu(app)).map((item) => item.label), { timeout: 15_000 })
    .toContain(text.trayQuit);
}

async function dashboardLanguage(port: number): Promise<unknown> {
  const answer = await fetch(`http://127.0.0.1:${port}/api/system/status`);
  return ((await answer.json()) as { desktop?: { language?: unknown } }).desktop?.language;
}

test("a language chosen on the Settings tab redraws the App at once and reaches the Dashboard; the Dashboard's choice comes back", async () => {
  test.setTimeout(150_000);
  const box = await createSandbox({ withDatabase: true });
  sandbox = box;
  // The system language this test runs under is English: 跟隨系統 reads as English.
  app = await launchApp(box, { LANG: "en_US.UTF-8", LANGUAGE: "en_US" });
  await waitForManagedSnapshot(app);
  await openWindow(app, "settings");
  const window = await app.firstWindow({ timeout: 45_000 });
  await expectTabShown(window, "settings");
  await expectShellLanguage(app, window, "en");
  await expect(window.locator('[data-id="language-system"]')).toBeChecked();
  expect(savedLanguage(box)).toBeUndefined();
  await expect.poll(() => dashboardLanguage(box.port)).toEqual({ preference: "system", locale: "en" });

  await window.locator('[data-id="language-zh-TW"]').check();
  await expectShellLanguage(app, window, "zh-TW");
  await expect(window.locator("#language-section")).toContainText("語言");
  expect(savedLanguage(box)).toBe("zh-TW");
  await expect.poll(() => dashboardLanguage(box.port)).toEqual({ preference: "zh-TW", locale: "zh-TW" });

  // What the Dashboard sends when the user picks English there.
  const origin = `http://127.0.0.1:${box.port}`;
  const answer = await fetch(`${origin}/api/desktop/language`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ locale: "en" }),
  });
  expect(answer.status).toBe(202);
  await expectShellLanguage(app, window, "en");
  await expect(window.locator('[data-id="language-en"]')).toBeChecked();
  expect(savedLanguage(box)).toBe("en");

  // Back to 跟隨系統: the file loses the field again.
  await window.locator('[data-id="language-system"]').check();
  await expect.poll(() => savedLanguage(box)).toBeUndefined();
  await expect.poll(() => dashboardLanguage(box.port)).toEqual({ preference: "system", locale: "en" });
});
