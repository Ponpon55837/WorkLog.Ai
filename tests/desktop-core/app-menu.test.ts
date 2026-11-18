import { describe, expect, it } from "vitest";
import {
  WINDOW_DEFAULT_SIZE,
  WINDOW_MIN_SIZE,
  buildAppMenuTemplate,
  buildTrayMenu,
  setupMessages,
  shellMessages,
  updateMessages,
  windowBoundsFor,
  type AppMenuItem,
} from "../../packages/desktop-core/src/index.js";

const en = shellMessages("en");
const zh = shellMessages("zh-TW");

function labelsOf(template: readonly AppMenuItem[] | null): string[] {
  return (template ?? []).map((item) => item.label ?? "");
}

function flatten(items: readonly AppMenuItem[]): AppMenuItem[] {
  return items.flatMap((item) => [item, ...flatten(item.submenu ?? [])]);
}

describe("the application menu", () => {
  it.each(["win32", "linux", "freebsd"] as const)("is none on %s, so Alt reveals nothing", (platform) => {
    expect(buildAppMenuTemplate(platform, en)).toBeNull();
  });

  it("is App, Edit and Window on macOS, with no View menu", () => {
    const template = buildAppMenuTemplate("darwin", en);
    expect(labelsOf(template)).toEqual(["Work Intelligence", "Edit", "Window"]);
    const everything = flatten(template ?? []);
    expect(everything.some((item) => item.role === "viewMenu" || item.label === "View")).toBe(false);
    for (const forbidden of ["reload", "forceReload", "toggleDevTools", "zoomIn", "zoomOut", "togglefullscreen"]) {
      expect(everything.some((item) => item.role === forbidden)).toBe(false);
    }
  });

  it("has the standard App items and the standard Edit items", () => {
    const [app, edit] = buildAppMenuTemplate("darwin", en) ?? [];
    expect((app?.submenu ?? []).map((item) => item.role).filter(Boolean)).toEqual([
      "about",
      "hide",
      "hideOthers",
      "unhide",
      "quit",
    ]);
    expect((app?.submenu ?? [])[0]?.label).toBe("About Work Intelligence");
    expect((edit?.submenu ?? []).map((item) => item.role).filter(Boolean)).toEqual([
      "undo",
      "redo",
      "cut",
      "copy",
      "paste",
      "selectAll",
    ]);
  });

  it("makes Cmd+W close the window, never quit the App", () => {
    const window = (buildAppMenuTemplate("darwin", en) ?? [])[2];
    const close = (window?.submenu ?? []).find((item) => item.accelerator === "CmdOrCtrl+W");
    expect(close).toMatchObject({ action: "close-window", label: "Close Window" });
    expect(close?.role).toBeUndefined();
    const quitters = flatten(buildAppMenuTemplate("darwin", en) ?? []).filter((item) => item.role === "quit");
    expect(quitters.every((item) => item.accelerator === undefined)).toBe(true);
    expect((window?.submenu ?? []).some((item) => item.role === "minimize")).toBe(true);
  });

  it("speaks Traditional Chinese for the labels the App translates itself", () => {
    const template = buildAppMenuTemplate("darwin", zh);
    expect(labelsOf(template)).toEqual(["Work Intelligence", "編輯", "視窗"]);
    expect((template?.[0]?.submenu ?? [])[0]?.label).toBe("關於 Work Intelligence");
    expect((template?.[2]?.submenu ?? [])[1]?.label).toBe("關閉視窗");
  });
});

describe("the shortened tray menu", () => {
  const base = { messages: en, owner: "MANAGED" as const, backendRunning: true };
  const update = updateMessages("en");

  it("is Dashboard, the window, updates, separator, Quit for a set-up App", () => {
    const items = buildTrayMenu({ ...base, setup: { messages: setupMessages("en"), needsSetup: false }, update });
    expect(items.map((item) => item.id)).toEqual(["open-dashboard", "open-app", "check-updates", "separator", "quit"]);
  });

  it("names the window after the App in both languages", () => {
    expect(buildTrayMenu(base).find((item) => item.id === "open-app")?.label).toBe("Open Work Intelligence…");
    expect(buildTrayMenu({ ...base, messages: zh }).find((item) => item.id === "open-app")?.label).toBe(
      "開啟 Work Intelligence…",
    );
  });

  it("adds Complete setup only while the App needs it, and the legacy line only while held", () => {
    const items = buildTrayMenu({
      ...base,
      setup: { messages: setupMessages("en"), needsSetup: true },
      update,
      legacyHeld: setupMessages("en"),
    });
    expect(items.map((item) => item.id)).toEqual([
      "legacy-status",
      "complete-setup",
      "open-dashboard",
      "open-app",
      "check-updates",
      "separator",
      "quit",
    ]);
    expect(items[0]?.enabled).toBe(false);
  });

  it("no longer carries the removed items", () => {
    const ids: string[] = buildTrayMenu({
      ...base,
      setup: { messages: setupMessages("en"), needsSetup: false },
      update,
      legacyHeld: setupMessages("en"),
    }).map((item) => item.id);
    for (const gone of ["repair", "change-port", "agent-setup", "legacy-remove-help", "legacy-start-anyway"]) {
      expect(ids).not.toContain(gone);
    }
  });
});

describe("windowBoundsFor", () => {
  const screen1080 = { x: 0, y: 0, width: 1920, height: 1040 };

  it("uses the default size, centred by the OS, when nothing was remembered", () => {
    expect(windowBoundsFor(screen1080)).toEqual({
      ...WINDOW_DEFAULT_SIZE,
      minWidth: WINDOW_MIN_SIZE.width,
      minHeight: WINDOW_MIN_SIZE.height,
    });
  });

  it("clamps to a small work area (1366x768 at 150% scaling is about 910x512 DIP)", () => {
    const bounds = windowBoundsFor({ x: 0, y: 0, width: 910, height: 512 });
    expect(bounds.width).toBe(910);
    expect(bounds.height).toBe(512);
    expect(bounds.minHeight).toBe(512);
    expect(bounds.minWidth).toBe(WINDOW_MIN_SIZE.width);
  });

  it("restores the remembered size and position", () => {
    const bounds = windowBoundsFor(screen1080, { x: 100, y: 80, width: 1000, height: 800 });
    expect(bounds).toMatchObject({ x: 100, y: 80, width: 1000, height: 800 });
  });

  it("never reopens off screen or below the minimum", () => {
    const bounds = windowBoundsFor(screen1080, { x: 5000, y: -400, width: 100, height: 100 });
    expect(bounds.width).toBe(WINDOW_MIN_SIZE.width);
    expect(bounds.height).toBe(WINDOW_MIN_SIZE.height);
    expect(bounds.x).toBe(1920 - WINDOW_MIN_SIZE.width);
    expect(bounds.y).toBe(0);
  });
});
