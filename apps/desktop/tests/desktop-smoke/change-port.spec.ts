import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { decodePortHandoffFragment } from "@work-intelligence/schema";
import { WorkIntelligenceStore } from "@work-intelligence/storage";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import { portMessages } from "@work-intelligence/desktop-core/shell/port-i18n";
import {
  attachLog,
  closeQuietly,
  createSandbox,
  freePort,
  healthProofIsValid,
  launchApp,
  portIsFree,
  readMainLog,
  removeSandbox,
  waitForManagedSnapshot,
  waitForSnapshot,
  type Sandbox,
} from "./helpers.js";

/**
 * Changing the backend port from the App (DT-14): the repair window's 「連接埠」 section. Both ports are ephemeral and
 * synthetic; the native confirmation is auto-answered by the test switch. The Web never changes the port.
 */

let sandbox: Sandbox | undefined;
let app: ElectronApplication | undefined;
let blocker: Server | undefined;

test.afterEach(async ({ browserName: _browserName }, testInfo) => {
  if (sandbox) attachLog(testInfo, sandbox);
  await closeQuietly(app);
  app = undefined;
  await new Promise<void>((done) => (blocker ? blocker.close(() => done()) : done()));
  blocker = undefined;
  if (sandbox) removeSandbox(sandbox);
  sandbox = undefined;
});

interface SettingsFile {
  desired: { port: number };
  active?: { port: number };
  lastKnownGood?: { port: number };
}

function readSettings(box: Sandbox): SettingsFile {
  return JSON.parse(readFileSync(join(box.dataDirectory, "desktop-settings.json"), "utf8")) as SettingsFile;
}

/** Runs what the tray's 「變更連接埠…」 item runs (`changePort.openSection()`) and returns the window with the section ready. */
async function openPortSection(running: ElectronApplication): Promise<Page> {
  await running.evaluate(() =>
    (
      globalThis as unknown as { __workIntelligenceDesktopTest: { openPortSettings(): void } }
    ).__workIntelligenceDesktopTest.openPortSettings(),
  );
  const window = await running.firstWindow({ timeout: 45_000 });
  await expect(window.locator("#port-section")).toBeVisible({ timeout: 30_000 });
  return window;
}

test("the repair page changes the port: the old one is released and the settings follow the new one", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  const oldPort = sandbox.port;
  const newPort = await freePort();
  app = await launchApp(sandbox, { WORK_INTELLIGENCE_DESKTOP_TEST_AUTOCONFIRM_PORT: "1" });
  const before = await waitForManagedSnapshot(app);
  expect(before.backend?.port).toBe(oldPort);
  const window = await openPortSection(app);

  await window.locator('[data-id="port-input"]').fill(String(newPort));
  await window.locator('[data-id="port-apply"]').click();

  // The Dashboard opens on the new port only after the settings commit; the startup URL already filled openedExternal.
  const after = await waitForSnapshot(
    app,
    (state) =>
      state.backend?.port === newPort &&
      state.openedExternal.some((url) => new URL(url).origin === `http://127.0.0.1:${newPort}`),
  );
  expect(after.owner).toBe("MANAGED");
  expect(await healthProofIsValid(newPort, after.backend?.runId ?? "")).toBe(true);
  expect(await portIsFree(oldPort)).toBe(true);
  const settings = readSettings(sandbox);
  expect(settings.desired.port).toBe(newPort);
  expect(settings.active?.port).toBe(newPort);
  expect(settings.lastKnownGood?.port).toBe(newPort);
  expect(after.openedExternal.at(-1)).toBe(`http://127.0.0.1:${newPort}/`);
  // The log never carries the address the Dashboard was opened with.
  expect(readMainLog(sandbox)).not.toContain(`127.0.0.1:${newPort}`);
});

/** The sentence for the sandbox's locale (the App follows the system language; the sandbox does not fix it). */
const discardedNote = new RegExp(
  ["zh-TW", "en"].map((locale) => portMessages(locale as "zh-TW" | "en").importPreviewDiscarded).join("|"),
);

/** Stages a synthetic export of the sandbox's own database the way the Dashboard does; returns the staging id. */
async function stageImportPreview(port: number): Promise<string> {
  const origin = `http://127.0.0.1:${port}`;
  const exported = await fetch(`${origin}/api/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ scope: "all" }),
  });
  expect(exported.status).toBe(200);
  const staged = await fetch(`${origin}/api/import/staged`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: await exported.text(),
  });
  expect(staged.status, await staged.clone().text()).toBe(201);
  return ((await staged.json()) as { stagingId: string }).stagingId;
}

function stagedDirectories(box: Sandbox): string[] {
  const root = join(dirname(box.databasePath), ".work-intelligence-transfer");
  return existsSync(root) ? readdirSync(root).filter((name) => name.startsWith("import-")) : [];
}

test("an idle import preview does not block the port change; the restart discards it and the page says so", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  // A synthetic project, so the export has something to stage.
  const projectRoot = join(sandbox.root, "synthetic-project");
  mkdirSync(projectRoot);
  const seed = new WorkIntelligenceStore(sandbox.databasePath);
  seed.addProject("Synthetic preview project", projectRoot);
  seed.close();
  const oldPort = sandbox.port;
  const newPort = await freePort();
  app = await launchApp(sandbox, { WORK_INTELLIGENCE_DESKTOP_TEST_AUTOCONFIRM_PORT: "1" });
  await waitForManagedSnapshot(app);
  await stageImportPreview(oldPort);
  expect(stagedDirectories(sandbox)).toHaveLength(1);
  const window = await openPortSection(app);

  await window.locator('[data-id="port-input"]').fill(String(newPort));
  await window.locator('[data-id="port-apply"]').click();

  const after = await waitForSnapshot(app, (state) => state.backend?.port === newPort);
  expect(after.owner).toBe("MANAGED");
  await expect(window.locator("#port-section .success-text")).toBeVisible({ timeout: 30_000 });
  await expect(window.locator("#port-section")).toContainText(discardedNote);
  expect(await portIsFree(oldPort)).toBe(true);
  expect(readSettings(sandbox).desired.port).toBe(newPort);
  expect(stagedDirectories(sandbox)).toEqual([]);
});

test("a change with no import preview does not mention one", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  const newPort = await freePort();
  app = await launchApp(sandbox, { WORK_INTELLIGENCE_DESKTOP_TEST_AUTOCONFIRM_PORT: "1" });
  await waitForManagedSnapshot(app);
  const window = await openPortSection(app);

  await window.locator('[data-id="port-input"]').fill(String(newPort));
  await window.locator('[data-id="port-apply"]').click();

  await waitForSnapshot(app, (state) => state.backend?.port === newPort);
  await expect(window.locator("#port-section .success-text")).toBeVisible({ timeout: 30_000 });
  await expect(window.locator("#port-section")).not.toContainText(discardedNote);
});

test("an occupied target is refused, nothing is stopped and the backend stays on its port", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  const oldPort = sandbox.port;
  blocker = createServer();
  const taken = await new Promise<number>((resolveListen, rejectListen) => {
    blocker?.once("error", rejectListen);
    blocker?.listen(0, "127.0.0.1", () => {
      const address = blocker?.address();
      if (address && typeof address === "object") resolveListen(address.port);
      else rejectListen(new Error("no address"));
    });
  });
  app = await launchApp(sandbox, { WORK_INTELLIGENCE_DESKTOP_TEST_AUTOCONFIRM_PORT: "1" });
  const before = await waitForManagedSnapshot(app);
  const window = await openPortSection(app);

  await window.locator('[data-id="port-input"]').fill(String(taken));
  await window.locator('[data-id="port-apply"]').click();
  await expect(window.locator("#port-section .warning-text")).toBeVisible({ timeout: 30_000 });

  const after = await waitForManagedSnapshot(app);
  expect(after.backend?.pid).toBe(before.backend?.pid);
  expect(after.backend?.port).toBe(oldPort);
  expect(await portIsFree(oldPort)).toBe(false);
  const settings = readSettings(sandbox);
  expect(settings.desired.port).toBe(oldPort);
  expect(settings.active?.port ?? oldPort).toBe(oldPort);
});

test("the Dashboard's request carries its whitelisted preferences and route to the new address, once", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  const oldPort = sandbox.port;
  const newPort = await freePort();
  app = await launchApp(sandbox, { WORK_INTELLIGENCE_DESKTOP_TEST_AUTOCONFIRM_PORT: "1" });
  await waitForManagedSnapshot(app);

  // What the Web status page sends: the page's own origin, preferences with keys that are not on the whitelist, a route.
  const origin = `http://127.0.0.1:${oldPort}`;
  const answer = await fetch(`${origin}/api/desktop/open-port-settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({
      preferences: { theme: "dark", locale: "en-US", sessionToken: "synthetic-secret", databasePath: "/synthetic/x" },
      route: "/reports",
    }),
  });
  expect(answer.status).toBe(202);

  // The App shows the port section by itself; nothing was changed by the request.
  await waitForSnapshot(app, (state) => state.repairWindowOpen, 30_000);
  const window = await app.firstWindow({ timeout: 45_000 });
  await expect(window.locator("#port-section")).toBeVisible({ timeout: 30_000 });
  await window.locator('[data-id="port-input"]').fill(String(newPort));
  await window.locator('[data-id="port-apply"]').click();

  // The App already opened the Dashboard on the old port at start; wait for the address it opens after the change.
  const after = await waitForSnapshot(
    app,
    (state) =>
      state.backend?.port === newPort &&
      state.openedExternal.some((url) => new URL(url).origin === `http://127.0.0.1:${newPort}`),
  );
  const opened = new URL(after.openedExternal.filter((url) => new URL(url).port === String(newPort)).at(-1) ?? "");
  expect(opened.origin).toBe(`http://127.0.0.1:${newPort}`);
  expect(opened.hash.startsWith("#wi-handoff=")).toBe(true);
  expect(decodePortHandoffFragment(opened.hash)).toEqual({
    preferences: { theme: "dark", locale: "en-US" },
    route: "/reports",
  });
  // Neither the fragment nor the preferences reach the log.
  const log = readMainLog(sandbox);
  expect(log).not.toContain("wi-handoff");
  expect(log).not.toContain("synthetic-secret");
});

test("the repair page scrolls to the port section for a request once, not on every later load", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  app = await launchApp(sandbox, { WORK_INTELLIGENCE_DESKTOP_TEST_AUTOCONFIRM_PORT: "1" });
  await waitForManagedSnapshot(app);
  const window = await openPortSection(app);
  await expect(window.locator("#port-section")).toBeVisible();
  const asked = async () =>
    window.evaluate(() =>
      (
        window as unknown as { workIntelligenceRepair: { getState(): Promise<{ port: { focus: boolean } | null }> } }
      ).workIntelligenceRepair.getState(),
    );
  // The first state after the request carried the focus flag to the page (the page already consumed it above); a later
  // state, as a reloaded page would read it, does not.
  expect((await asked()).port?.focus).toBe(false);
  await window.reload();
  await expect(window.locator("#port-section")).toBeVisible({ timeout: 30_000 });
  expect((await asked()).port?.focus).toBe(false);
});
