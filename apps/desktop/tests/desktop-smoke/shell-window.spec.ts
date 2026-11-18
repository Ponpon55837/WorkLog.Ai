import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { APP_TABS, type AppTab, windowBoundsFor } from "@work-intelligence/desktop-core";
import {
  attachLog,
  closeAppWindow,
  closeQuietly,
  createSandbox,
  expectTabShown,
  launchApp,
  markPage,
  openTab,
  openWindow,
  pageMarker,
  readSnapshot,
  removeSandbox,
  runToExit,
  selectedTab,
  shellText,
  tabButton,
  tabIds,
  trayClick,
  trayMenu,
  waitForManagedSnapshot,
  waitForSnapshot,
  windowCount,
  type Sandbox,
} from "./helpers.js";

/**
 * The one tabbed App window, checked through roles, aria attributes and `data-*` ids (never styling classes): one
 * window that is reused (never reloaded) by every tray item and route, the tab strip's semantics and keyboard, the tab
 * a request selects, the menu, the DevTools switch, the window's size, state across tab switches, the theme and the
 * IPC allowlist. Synthetic data only; the update check talks to a local stand-in server.
 */

const ORIGIN_VARIABLE = "WORK_INTELLIGENCE_DESKTOP_TEST_UPDATE_API_ORIGIN";
const FIRST_RUN_PORT_VARIABLE = "WORK_INTELLIGENCE_DESKTOP_TEST_DEFAULT_PORT";
const READY_TABS: readonly AppTab[] = APP_TABS.filter((tab) => tab !== "setup");

let sandbox: Sandbox | undefined;
let app: ElectronApplication | undefined;
let server: Server | undefined;
let updateRequests = 0;

test.afterEach(async ({ browserName: _browserName }, testInfo) => {
  if (sandbox) attachLog(testInfo, sandbox);
  await closeQuietly(app);
  app = undefined;
  server?.closeAllConnections();
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = undefined;
  if (sandbox) removeSandbox(sandbox);
  sandbox = undefined;
});

/** A stand-in for the GitHub release list that answers with no release at all (up to date), counting the requests. */
async function startUpdateServer(): Promise<string> {
  updateRequests = 0;
  server = createServer((_request, response) => {
    updateRequests += 1;
    response.writeHead(200, { "Content-Type": "application/json" }).end("[]");
  });
  await new Promise<void>((done) => server?.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** An App that is set up and running; no window is open yet. */
async function startManaged(extra: Record<string, string> = {}): Promise<ElectronApplication> {
  sandbox = await createSandbox({ withDatabase: true });
  app = await launchApp(sandbox, extra);
  await waitForManagedSnapshot(app);
  return app;
}

/** Opens the App window the way the tray's "Open Work Intelligence…" does and waits for its page. */
async function showWindow(running: ElectronApplication, tab?: AppTab): Promise<Page> {
  await openWindow(running, tab);
  const window = await running.firstWindow({ timeout: 45_000 });
  await expect(window.locator('[role="tablist"] [role="tab"]').first()).toBeVisible({ timeout: 30_000 });
  return window;
}

async function expectOneWindow(running: ElectronApplication): Promise<void> {
  expect(await windowCount(running)).toBe(1);
  expect(running.windows()).toHaveLength(1);
}

test("every tray item and route reuses the one window: one BrowserWindow and the page is never reloaded", async () => {
  const running = await startManaged({ [ORIGIN_VARIABLE]: await startUpdateServer() });

  // The tray menu while the App is set up: the status line is not here, setup is done.
  const items = await trayMenu(running);
  expect(items.map((item) => item.id)).toEqual(["open-dashboard", "open-app", "check-updates", "separator", "quit"]);
  expect(items.filter((item) => item.id !== "separator").every((item) => item.enabled)).toBe(true);

  const window = await showWindow(running);
  await expectTabShown(window, "status");
  const marker = await markPage(window);
  await expectOneWindow(running);

  const steps: { name: string; run: () => Promise<void>; tab: AppTab }[] = [
    { name: "tray: Open Work Intelligence", run: () => trayClick(running, "open-app"), tab: "status" },
    { name: "tray: Open Dashboard", run: () => trayClick(running, "open-dashboard"), tab: "status" },
    // Check for updates selects the Settings tab where the check runs.
    { name: "tray: Check for updates", run: () => trayClick(running, "check-updates"), tab: "settings" },
    // With no explicit request the window shows the tab the user was on.
    { name: "tray: Open Work Intelligence (remembered)", run: () => trayClick(running, "open-app"), tab: "settings" },
    { name: "route: Agent tab", run: () => openWindow(running, "agent"), tab: "agent" },
    {
      name: "second launch with --open-agent-setup",
      run: async () => {
        await openWindow(running, "data");
        await expectTabShown(window, "data");
        const second = await runToExit(sandbox as Sandbox, {}, 20_000, ["--open-agent-setup"]);
        expect(second.code).toBe(0);
      },
      tab: "agent",
    },
    { name: "route: Data tab", run: () => openWindow(running, "data"), tab: "data" },
  ];
  for (const step of steps) {
    await step.run();
    await expectTabShown(window, step.tab);
    await expectOneWindow(running);
    expect(await pageMarker(window), `${step.name}: the page was reloaded`).toBe(marker);
  }
  // Only the one update request the tray item made.
  expect(updateRequests).toBe(1);
});

test("the tab strip is a real tablist: roles, aria links, roving tabindex, keyboard, focus ring and clicks", async () => {
  const running = await startManaged();
  const window = await showWindow(running);
  const text = await shellText(window);

  await expect(window.getByRole("tablist")).toHaveCount(1);
  await expect(window.getByRole("tablist")).toHaveAttribute("aria-label", text.tabListLabel);
  // Setup is not here: this App is set up.
  expect(await tabIds(window)).toEqual([...READY_TABS]);
  await expect(window.getByRole("tab")).toHaveCount(READY_TABS.length);
  await expect(window.locator('[role="tabpanel"]')).toHaveCount(APP_TABS.length);

  for (const tab of READY_TABS) {
    const button = tabButton(window, tab);
    await expect(button).toHaveAttribute("id", `tab-${tab}`);
    await expect(button).toHaveAttribute("aria-controls", `panel-${tab}`);
    await expect(button).toContainText(text.tabLabels[tab]);
    const panel = window.locator(`#panel-${tab}`);
    await expect(panel).toHaveAttribute("role", "tabpanel");
    await expect(panel).toHaveAttribute("aria-labelledby", `tab-${tab}`);
  }

  // Exactly one tab is selected, it is the one tab stop, and only its panel is shown.
  const state = async (): Promise<{ selected: string[]; stops: string[]; shown: string[] }> =>
    window.evaluate(() => {
      const tabs = [...document.querySelectorAll<HTMLElement>('[role="tab"]')];
      return {
        selected: tabs
          .filter((node) => node.getAttribute("aria-selected") === "true")
          .map((node) => node.dataset.tab ?? ""),
        stops: tabs.filter((node) => node.tabIndex === 0).map((node) => node.dataset.tab ?? ""),
        shown: [...document.querySelectorAll<HTMLElement>('[role="tabpanel"]')]
          .filter((node) => !node.hidden)
          .map((node) => node.id),
      };
    });
  const initial = await state();
  expect(initial.selected).toEqual(["status"]);
  expect(initial.stops).toEqual(["status"]);
  expect(initial.shown).toEqual(["panel-status"]);

  // Keyboard: Left and Right wrap, Home and End jump, each selects at once and keeps the focus on the new tab.
  await tabButton(window, "status").focus();
  const press = async (key: string, expected: AppTab): Promise<void> => {
    await window.keyboard.press(key);
    await expectTabShown(window, expected);
    await expect(tabButton(window, expected)).toBeFocused();
    const now = await state();
    expect(now.stops).toEqual([expected]);
    expect(now.selected).toEqual([expected]);
  };
  await press("ArrowRight", "agent");
  await press("ArrowRight", "settings");
  await press("ArrowLeft", "agent");
  await press("ArrowLeft", "status");
  await press("ArrowLeft", "diagnostics"); // wraps from the first to the last
  await press("ArrowRight", "status"); // wraps from the last to the first
  await press("End", "diagnostics");
  await press("Home", "status");

  // The focus ring is visible for a keyboard user: the tab the arrow keys focused has an outline or a shadow.
  await press("ArrowRight", "agent");
  const ring = await tabButton(window, "agent").evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      outline: style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0,
      shadow: style.boxShadow !== "none",
      focusVisible: node.matches(":focus-visible"),
    };
  });
  expect(ring.focusVisible).toBe(true);
  expect(ring.outline || ring.shadow).toBe(true);

  // Every tab is reachable with a click.
  for (const tab of READY_TABS) {
    await tabButton(window, tab).click();
    await expectTabShown(window, tab);
    expect((await state()).stops).toEqual([tab]);
  }
  expect(await selectedTab(window)).toBe("diagnostics");
  await expectOneWindow(running);
});

test("Setup is a tab only while the App needs it, and a first launch starts on it; Complete setup selects it without a reload", async () => {
  sandbox = await createSandbox({ withDatabase: false, withSettings: false });
  app = await launchApp(sandbox, { [FIRST_RUN_PORT_VARIABLE]: String(sandbox.port) });
  const window = await app.firstWindow({ timeout: 45_000 });
  await expect(window.locator('[data-id="use-defaults"]')).toBeVisible({ timeout: 30_000 });

  expect(await tabIds(window)).toEqual([...APP_TABS]);
  await expectTabShown(window, "setup");
  expect((await readSnapshot(app)).tab).toBe("setup");
  // The tray offers Complete setup first while setup is open, and the first-run page has not created anything.
  const items = await trayMenu(app);
  expect(items.map((item) => item.id)).toEqual([
    "complete-setup",
    "open-dashboard",
    "open-app",
    "check-updates",
    "separator",
    "quit",
  ]);

  // The other tabs still render before setup; the user may look around and come back.
  const marker = await markPage(window);
  await openTab(window, "status");
  await expect(window.locator("#panel-status")).not.toBeEmpty();
  await trayClick(app, "complete-setup");
  await expectTabShown(window, "setup");
  await expectOneWindow(app);
  expect(await pageMarker(window)).toBe(marker);
  await expect(window.locator('[data-id="use-defaults"]')).toBeVisible();

  // Setup ends: the tab goes away, and so does the tray's Complete setup item.
  await window.locator('[data-id="use-defaults"]').click();
  await waitForSnapshot(app, (state) => state.owner === "MANAGED" && !state.needsSetup, 90_000);
  await expect(tabButton(window, "setup")).toHaveCount(0, { timeout: 15_000 });
  expect(await tabIds(window)).toEqual([...READY_TABS]);
  expect((await trayMenu(app)).some((item) => item.id === "complete-setup")).toBe(false);
  expect(await selectedTab(window)).not.toBe("setup");
  expect(await pageMarker(window)).toBe(marker);
});

test("a tray request selects its tab without a reload, and the last tab the user chose comes back after close and reopen", async () => {
  const running = await startManaged({ [ORIGIN_VARIABLE]: await startUpdateServer() });
  const window = await showWindow(running);
  const marker = await markPage(window);

  // Check for updates: Settings, with the check started.
  await trayClick(running, "check-updates");
  await expectTabShown(window, "settings");
  await expect.poll(() => updateRequests, { timeout: 15_000 }).toBe(1);
  expect(await pageMarker(window)).toBe(marker);

  // A tab the user picks by hand is the one the window comes back to.
  await openTab(window, "data");
  await closeAppWindow(running);
  await trayClick(running, "open-app");
  const reopened = await running.firstWindow({ timeout: 45_000 });
  await expectTabShown(reopened, "data");
  expect((await readSnapshot(running)).tab).toBe("data");
  await expectOneWindow(running);
});

test("a missing database opens on Status with the blocking card; the other tabs still render; a request still wins; the next open goes back to Status", async () => {
  sandbox = await createSandbox({ withDatabase: false });
  app = await launchApp(sandbox);
  const window = await app.firstWindow({ timeout: 45_000 });
  const snapshot = await waitForSnapshot(app, (state) => state.owner === "NEEDS_REPAIR" && state.repairWindowOpen);
  expect(snapshot.recentErrors).toContain("DB_MISSING");
  const text = await shellText(window);

  await expectTabShown(window, "status");
  await expect(window.getByText("DB_MISSING")).toBeVisible();
  // The blocking state is marked on the Status tab by its accessible name, not by its look.
  await expect(tabButton(window, "status")).toHaveAccessibleName(new RegExp(text.tabAttentionLabel));
  await expect(tabButton(window, "settings")).not.toHaveAccessibleName(new RegExp(text.tabAttentionLabel));

  // Every other tab still draws something.
  for (const tab of READY_TABS) {
    await openTab(window, tab);
    await expect(window.locator(`#panel-${tab}`)).not.toBeEmpty();
    await expect(window.locator(`#panel-${tab}`)).toBeVisible();
  }
  // An explicit request wins over the blocking state ...
  await openWindow(app, "settings");
  await expectTabShown(window, "settings");
  await closeAppWindow(app);
  // ... and the next plain open shows the blocking state again, not the tab the user was last on.
  await trayClick(app, "open-app");
  const again = await app.firstWindow({ timeout: 45_000 });
  await expectTabShown(again, "status");
  await expectOneWindow(app);
  expect(existsSync(sandbox.databasePath)).toBe(false);
});

test("the application menu: none on Windows and Linux (Alt reveals nothing); App, Edit and Window on macOS", async () => {
  const running = await startManaged();
  const window = await showWindow(running);
  const menu = await running.evaluate(({ Menu, BrowserWindow }) => {
    const application = Menu.getApplicationMenu();
    const collect = (items: Electron.MenuItem[]): { label: string; role: string }[] =>
      items.flatMap((item) => [
        { label: item.label, role: String(item.role ?? "") },
        ...(item.submenu ? collect(item.submenu.items) : []),
      ]);
    const win = BrowserWindow.getAllWindows()[0];
    return {
      present: application !== null,
      top: application ? application.items.map((item) => item.label) : [],
      all: application ? collect(application.items) : [],
      autoHide: win ? win.autoHideMenuBar : null,
    };
  });
  if (process.platform === "darwin") {
    expect(menu.present).toBe(true);
    expect(menu.top).toHaveLength(3);
    const roles = menu.all.map((entry) => entry.role.toLowerCase());
    for (const needed of ["undo", "redo", "cut", "copy", "paste", "selectall", "minimize"]) {
      expect(roles).toContain(needed);
    }
    // No View menu and nothing that reloads the page or opens developer tools.
    for (const forbidden of ["viewmenu", "reload", "forcereload", "toggledevtools", "windowmenu"]) {
      expect(roles).not.toContain(forbidden);
    }
    expect(menu.all.map((entry) => entry.label.toLowerCase())).not.toContain("view");
    return;
  }
  expect(menu.present).toBe(false);
  expect(menu.autoHide).toBe(true);
  // Alt on the page does not bring a menu bar up.
  await window.locator("body").click({ position: { x: 5, y: 5 } });
  await window.keyboard.press("Alt");
  const visible = await running.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMenuBarVisible());
  expect(visible).toBe(false);
});

test("macOS: Cmd+A, C, X, V and Z work in a real text input", async () => {
  test.skip(
    process.platform !== "darwin",
    "the Cmd shortcuts come from the macOS Edit menu; no other platform has one",
  );
  const running = await startManaged();
  const window = await showWindow(running, "settings");
  const input = window.locator('[data-id="port-input"]');
  await expect(input).toBeVisible({ timeout: 30_000 });
  await input.click();
  await input.press("Meta+A");
  await input.pressSequentially("4321");
  await expect(input).toHaveValue("4321");
  await input.press("Meta+A");
  await input.press("Meta+C");
  expect(await running.evaluate(({ clipboard }) => clipboard.readText())).toBe("4321");
  await input.press("Meta+X");
  await expect(input).toHaveValue("");
  await input.press("Meta+V");
  await expect(input).toHaveValue("4321");
  await input.press("Meta+Z");
  await expect(input).not.toHaveValue("4321");
});

test("with DevTools switched off for the window (as a packaged App has them), openDevTools opens nothing", async () => {
  const running = await startManaged({ WORK_INTELLIGENCE_DESKTOP_TEST_DEVTOOLS_OFF: "1" });
  await showWindow(running);
  const result = await running.evaluate(async ({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0]?.webContents;
    if (!contents) return null;
    try {
      contents.openDevTools({ mode: "detach" });
    } catch {
      // A refusal is the expected answer.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    return { opened: contents.isDevToolsOpened() };
  });
  expect(result).toEqual({ opened: false });
});

test("the window opens at the default size, never below the minimum, scrolls no tab sideways at the minimum and comes back where it was left", async () => {
  const running = await startManaged();
  const window = await showWindow(running);
  const geometry = () =>
    running.evaluate(({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return null;
      const area = screen.getDisplayMatching(win.getBounds()).workArea;
      return { bounds: win.getBounds(), minimum: win.getMinimumSize(), area };
    });
  const first = await geometry();
  if (!first) throw new Error("no window");
  const expected = windowBoundsFor(first.area);
  // The window manager may add a pixel or two of frame; the size is otherwise the one `windowBoundsFor` decides.
  expect(Math.abs(first.bounds.width - expected.width)).toBeLessThanOrEqual(2);
  expect(Math.abs(first.bounds.height - expected.height)).toBeLessThanOrEqual(2);
  expect(first.minimum).toEqual([expected.minWidth, expected.minHeight]);

  // At the minimum size no tab needs a sideways scroll.
  await running.evaluate(
    ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height),
    { width: expected.minWidth, height: expected.minHeight },
  );
  await expect
    .poll(() => window.evaluate(() => globalThis.innerWidth), { timeout: 10_000 })
    .toBeLessThanOrEqual(expected.minWidth);
  for (const tab of READY_TABS) {
    await openTab(window, tab);
    const overflow = await window.evaluate((id) => {
      const root = document.documentElement;
      const frame = document.getElementById("app");
      const strip = document.querySelector<HTMLElement>('[role="tablist"]');
      const panel = document.getElementById(`panel-${id}`);
      return {
        page: root.scrollWidth - root.clientWidth,
        frame: frame ? frame.scrollWidth - frame.clientWidth : 0,
        strip: strip ? strip.scrollWidth - strip.clientWidth : 0,
        panel: panel ? panel.scrollWidth - panel.clientWidth : 0,
      };
    }, tab);
    expect(overflow, `tab ${tab}`).toEqual({ page: 0, frame: 0, strip: 0, panel: 0 });
  }

  // The size and place the user left it at come back after close and reopen (memory only).
  const left = { x: 40, y: 30, width: 800, height: 600 };
  await running.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0]?.setBounds(bounds), left);
  await closeAppWindow(running);
  await openWindow(running);
  await running.firstWindow({ timeout: 45_000 });
  await expect.poll(async () => (await geometry())?.bounds.width ?? 0, { timeout: 10_000 }).toBeGreaterThan(0);
  const back = await geometry();
  if (!back) throw new Error("no window");
  expect(Math.abs(back.bounds.width - left.width)).toBeLessThanOrEqual(2);
  expect(Math.abs(back.bounds.height - left.height)).toBeLessThanOrEqual(2);
  // The position is checked loosely: a window manager may nudge it.
  expect(Math.abs(back.bounds.x - left.x)).toBeLessThanOrEqual(16);
  expect(Math.abs(back.bounds.y - left.y)).toBeLessThanOrEqual(48);
});

test("an open diagnostics preview survives a tray tab request and a tab change; it is the same text and the same dialog", async () => {
  const running = await startManaged();
  const window = await showWindow(running, "diagnostics");
  await expectTabShown(window, "diagnostics");
  const trigger = window.locator('[data-id="export-diagnostics"]');
  const dialog = window.getByRole("dialog");
  const box = dialog.locator("textarea");
  await trigger.click();
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(box).not.toHaveValue("");
  const previewed = await box.inputValue();
  const marker = await markPage(window);

  // A route and a tray item select other tabs behind the open dialog: it stays, with the same text.
  await openWindow(running, "settings");
  await expectTabShown(window, "settings");
  await expect(dialog).toBeVisible();
  expect(await box.inputValue()).toBe(previewed);
  await trayClick(running, "open-app");
  await expectTabShown(window, "settings");
  await expect(dialog).toBeVisible();
  expect(await box.inputValue()).toBe(previewed);
  expect(await pageMarker(window)).toBe(marker);
  await expectOneWindow(running);

  // The dialog is modal, so the page behind it is not reachable by hand until it closes; then a manual switch works and
  // nothing reopens it.
  await window.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await openTab(window, "diagnostics");
  await openTab(window, "status");
  await expect(dialog).toBeHidden();
  expect(await pageMarker(window)).toBe(marker);
});

test("the theme follows the system setting: data-theme and a background token flip with the colour scheme", async () => {
  const running = await startManaged();
  const window = await showWindow(running);
  const read = () =>
    window.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      token: getComputedStyle(document.documentElement).getPropertyValue("--bg-canvas").trim(),
      background: getComputedStyle(document.body).backgroundColor,
    }));
  await window.emulateMedia({ colorScheme: "light" });
  await expect.poll(async () => (await read()).theme).toBe("light");
  const light = await read();
  await window.emulateMedia({ colorScheme: "dark" });
  await expect.poll(async () => (await read()).theme).toBe("dark");
  const dark = await read();
  expect(light.token).not.toBe("");
  expect(dark.token).not.toBe("");
  expect(dark.token).not.toBe(light.token);
  expect(dark.background).not.toBe(light.background);
  await window.emulateMedia({ colorScheme: "light" });
  await expect.poll(async () => (await read()).background).toBe(light.background);
});

test("the page's bridge refuses what main did not offer: an unknown tab id, and a tab the App does not have", async () => {
  const running = await startManaged();
  const window = await showWindow(running, "agent");
  await expectTabShown(window, "agent");
  const answers = await window.evaluate(async () => {
    const bridge = (
      globalThis as unknown as { workIntelligenceRepair: { rememberTab(tab: string): Promise<{ ok: boolean }> } }
    ).workIntelligenceRepair;
    const ask = async (tab: string): Promise<{ threw: boolean; ok: boolean | null }> => {
      try {
        const answer = await bridge.rememberTab(tab);
        return { threw: false, ok: answer.ok };
      } catch {
        return { threw: true, ok: null };
      }
    };
    return {
      unknown: await ask("not-a-tab"),
      polluted: await ask("__proto__"),
      // Valid id, but Setup does not exist once the App is set up.
      setup: await ask("setup"),
      known: await ask("data"),
    };
  });
  for (const refused of [answers.unknown, answers.polluted, answers.setup]) {
    expect(refused.threw || refused.ok === false).toBe(true);
  }
  expect(answers.known).toEqual({ threw: false, ok: true });
  // The refused ids changed nothing: main remembers the last valid one.
  expect((await readSnapshot(running)).tab).toBe("data");
  await closeAppWindow(running);
  await trayClick(running, "open-app");
  const reopened = await running.firstWindow({ timeout: 45_000 });
  await expectTabShown(reopened, "data");
});
