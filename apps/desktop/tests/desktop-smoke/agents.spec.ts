import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { setupMessages } from "@work-intelligence/desktop-core/shell/setup-i18n";
import {
  attachLog,
  closeQuietly,
  createSandbox,
  launchApp,
  readMainLog,
  readSnapshot,
  removeSandbox,
  runToExit,
  waitForManagedSnapshot,
  waitForSnapshot,
  type Sandbox,
} from "./helpers.js";

/**
 * The Agent page ("設定 Agent…"): nothing is written by looking or previewing, "套用變更" writes exactly the previewed
 * plan into the Agents' files under the (sandbox) home, the self-test talks MCP through the fixed launcher, and "復原上次
 * 變更" puts every file back. Synthetic data only: the home is the sandbox's, empty before the test.
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

/** Every file under `directory` with a hash of its bytes, so a test sees any write, create or delete. */
function tree(directory: string, skip: (path: string) => boolean): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const key = relative(directory, path);
      if (skip(key)) continue;
      if (statSync(path).isDirectory()) walk(path);
      else files[key] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(directory);
  return files;
}

interface PageAgentsState {
  launcherReady: boolean;
  selfTest: { outcome: string };
  undoAvailable: boolean;
  preview: { files: unknown[]; conflicts: unknown[] } | null;
}

function agentsState(window: Page): Promise<PageAgentsState> {
  return window.evaluate(() =>
    (
      globalThis as unknown as { workIntelligenceRepair: { agentsGetState(): Promise<unknown> } }
    ).workIntelligenceRepair.agentsGetState(),
  ) as Promise<PageAgentsState>;
}

async function pageText(window: Page) {
  const lang = await window.evaluate(() => document.documentElement.lang);
  return setupMessages(lang === "zh-Hant" ? "zh-TW" : "en");
}

test("the Agent page previews, applies exactly the preview, passes the self-test and undoes it all", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  // The App's own data (database, backups) is not an Agent file; the home is otherwise empty.
  const skip = (path: string) => path.startsWith(".work-intelligence");
  const home = sandbox.home;
  app = await launchApp(sandbox, {}, ["--open-agent-setup"]);
  await waitForManagedSnapshot(app);

  const window = await app.firstWindow({ timeout: 45_000 });
  const text = await pageText(window);
  await expect(window.getByRole("heading", { level: 1, name: text.agentsHeading })).toBeVisible();
  await expect(window.locator("[data-agent]")).toHaveCount(2);
  expect((await readSnapshot(app)).view).toBe("agents");
  expect((await agentsState(window)).launcherReady).toBe(true);
  const before = tree(home, skip);

  await window.locator('[data-id="preview"]').click();
  await expect(window.locator("#agents-preview")).toBeVisible();
  const previewed = await agentsState(window);
  expect(previewed.preview?.conflicts).toEqual([]);
  expect(previewed.preview?.files.length).toBeGreaterThan(0);
  // Previewing writes nothing.
  expect(tree(home, skip)).toEqual(before);
  // The diff shows `~`, never the real home.
  expect(await window.locator("#agents-preview").innerText()).not.toContain(home);

  await window.locator('[data-id="apply"]').click();
  await expect.poll(async () => (await agentsState(window)).undoAvailable, { timeout: 15_000 }).toBe(true);
  const applied = tree(home, skip);
  expect(applied).not.toEqual(before);
  expect(Object.keys(applied).some((path) => path.endsWith("SKILL.md"))).toBe(true);

  await window.locator('[data-id="self-test"]').click();
  await expect.poll(async () => (await agentsState(window)).selfTest.outcome, { timeout: 30_000 }).toBe("ok");

  await window.locator('[data-id="undo"]').click();
  await expect.poll(() => tree(home, skip), { timeout: 15_000 }).toEqual(before);
  expect(readMainLog(sandbox)).toMatch(/\[shell\] agent setup /);
});

test("a second launch with --open-agent-setup shows the Agent page in the running App", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  app = await launchApp(sandbox, {}, ["--background"]);
  await waitForManagedSnapshot(app);
  expect((await readSnapshot(app)).repairWindowOpen).toBe(false);

  const second = await runToExit(sandbox, {}, 20_000, ["--open-agent-setup"]);
  expect(second.code).toBe(0);
  const shown = await waitForSnapshot(app, (state) => state.repairWindowOpen && state.view === "agents");
  expect(shown.backend).not.toBeNull();
});
