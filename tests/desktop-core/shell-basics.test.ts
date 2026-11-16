import { describe, expect, it } from "vitest";
import {
  BACKGROUND_FLAG,
  buildQuitNotice,
  buildTrayMenu,
  changeLoginItem,
  decideSecondInstance,
  detectLaunchMode,
  ErrorPresenter,
  errorMessageFor,
  formatMessage,
  loginItemSettingsFor,
  resolveShellLocale,
  shellMessages,
  trayBackgroundHint,
  trayLocationName,
  trayTooltip,
  BACKEND_ERROR_CODES,
  RUNTIME_ERROR_CODES,
  type DesktopSettingsV1,
  type ErrorSurface,
} from "../../packages/desktop-core/src/index.js";

// Fictional values only.
const zh = shellMessages("zh-TW");
const en = shellMessages("en");

function settings(launchAtLogin = false): DesktopSettingsV1 {
  return {
    configVersion: 1,
    installId: "synthetic-install",
    desired: {
      databasePath: "/synthetic/work.sqlite",
      port: 41_000,
      launchAtLogin,
      backupDirectory: "/synthetic/backups",
    },
  };
}

describe("detectLaunchMode", () => {
  it("is background for the explicit flag on every platform", () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      expect(detectLaunchMode({ platform, argv: ["app", BACKGROUND_FLAG] })).toBe("background");
    }
  });

  it("is background on macOS only when opened at login", () => {
    expect(detectLaunchMode({ platform: "darwin", argv: [], wasOpenedAtLogin: true })).toBe("background");
    expect(detectLaunchMode({ platform: "darwin", argv: [], wasOpenedAtLogin: false })).toBe("interactive");
    expect(detectLaunchMode({ platform: "win32", argv: [], wasOpenedAtLogin: true })).toBe("interactive");
  });

  it("is interactive otherwise", () => {
    expect(detectLaunchMode({ platform: "win32", argv: ["app"] })).toBe("interactive");
  });
});

describe("ErrorPresenter", () => {
  function surface(): ErrorSurface & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      openRepairWindow: () => calls.push("window"),
      setTrayAttention: (code) => calls.push(`tray:${code}`),
      notify: (code) => calls.push(`notify:${code}`),
    };
  }

  it("opens the repair window in interactive mode and never notifies", () => {
    const ui = surface();
    new ErrorPresenter("interactive", ui).present("DB_MISSING");
    expect(ui.calls).toEqual(["tray:DB_MISSING", "window"]);
  });

  it("only updates the tray and notifies once per code in background mode", () => {
    const ui = surface();
    const presenter = new ErrorPresenter("background", ui);
    presenter.present("DB_MISSING");
    presenter.present("DB_MISSING");
    presenter.present("CHILD_EXITED");
    expect(ui.calls).toEqual([
      "tray:DB_MISSING",
      "notify:DB_MISSING",
      "tray:DB_MISSING",
      "tray:CHILD_EXITED",
      "notify:CHILD_EXITED",
    ]);
    expect(ui.calls).not.toContain("window");
  });

  it("notifies again for the same code after the error cleared", () => {
    const ui = surface();
    const presenter = new ErrorPresenter("background", ui);
    presenter.present("DB_MISSING");
    presenter.clear();
    presenter.present("DB_MISSING");
    expect(ui.calls.filter((call) => call === "notify:DB_MISSING")).toHaveLength(2);
    expect(ui.calls).toContain("tray:null");
  });
});

describe("buildTrayMenu", () => {
  it("puts the Dashboard first and enabled only for a running managed service", () => {
    const menu = buildTrayMenu({ messages: zh, owner: "MANAGED", backendRunning: true });
    expect(menu.map((item) => item.id)).toEqual(["open-dashboard", "repair", "separator", "quit"]);
    expect(menu[0]).toEqual({ id: "open-dashboard", label: "開啟 Dashboard", enabled: true });
    expect(menu[3]?.label).toBe("退出（退出後不會每日備份）");
  });

  it.each([
    ["NEEDS_REPAIR", false, "服務需要修復"],
    ["STARTING", false, "服務啟動中"],
    ["PREPARING", false, "服務啟動中"],
    ["EXTERNAL", false, "服務未執行"],
    ["MANAGED", false, "服務未執行"],
  ] as const)("disables the Dashboard and names the reason for %s / running %s", (owner, backendRunning, reason) => {
    const [dashboard] = buildTrayMenu({ messages: zh, owner, backendRunning });
    expect(dashboard).toMatchObject({ enabled: false, label: `開啟 Dashboard（${reason}）` });
  });

  it("uses the platform's own name for the tray area", () => {
    expect(trayLocationName("darwin", zh)).toBe("選單列");
    expect(trayLocationName("win32", zh)).toBe("通知區");
    expect(trayLocationName("linux", en)).toBe("system tray");
    expect(trayBackgroundHint("darwin", en)).toContain("menu bar");
    expect(trayBackgroundHint("win32", en)).toContain("notification area");
  });

  it("tells the tooltip apart", () => {
    expect(trayTooltip("MANAGED", true, en)).toBe(en.trayTooltipManaged);
    expect(trayTooltip("NEEDS_REPAIR", false, en)).toBe(en.trayTooltipNeedsRepair);
  });
});

describe("i18n", () => {
  it("has the same keys, error codes and nested tables in both languages", () => {
    const shape = (value: unknown): unknown =>
      typeof value === "object" && value !== null
        ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, shape(child)]))
        : typeof value;
    expect(shape(en)).toEqual(shape(zh));
    for (const code of BACKEND_ERROR_CODES) {
      expect(zh.errors[code].title.length).toBeGreaterThan(0);
      expect(en.errors[code].hint.length).toBeGreaterThan(0);
    }
  });

  it("gives every runtime refusal a title and an actionable hint in both languages", () => {
    for (const code of RUNTIME_ERROR_CODES) {
      for (const messages of [zh, en]) {
        expect(messages.errors[code].title.trim().length).toBeGreaterThan(0);
        expect(messages.errors[code].hint.trim().length).toBeGreaterThan(0);
      }
    }
    expect(en.errors.RUNTIME_UNSAFE_PERMISSIONS.hint).toMatch(/reinstall|administrator/i);
    expect(en.errors.RUNTIME_ACL_UNREADABLE.hint).toMatch(/administrator/i);
    expect(zh.errors.RUNTIME_UNSAFE_PERMISSIONS.hint).toContain("系統管理員");
    expect(zh.errors.RUNTIME_ACL_UNREADABLE.hint).toContain("系統管理員");
  });

  it("reads zh-* as Traditional Chinese and everything else as English", () => {
    expect(resolveShellLocale("zh-TW")).toBe("zh-TW");
    expect(resolveShellLocale("zh-CN")).toBe("zh-TW");
    expect(resolveShellLocale("zh")).toBe("zh-TW");
    expect(resolveShellLocale("en-US")).toBe("en");
    expect(resolveShellLocale("ja")).toBe("en");
    expect(resolveShellLocale("zhx")).toBe("en");
    expect(resolveShellLocale(undefined)).toBe("en");
  });

  it("formats placeholders and keeps an unknown one visible; falls back for an unknown code", () => {
    expect(formatMessage("a {x} b {y}", { x: "1" })).toBe("a 1 b {y}");
    expect(errorMessageFor(en, "SOMETHING_NEW")).toEqual(en.errors.REPAIR_REQUIRED);
    expect(errorMessageFor(zh, "DB_MISSING").title).toBe("找不到資料庫檔案");
  });
});

describe("buildQuitNotice", () => {
  it("says there is no daily backup after quitting and when the last backup was, in local time", () => {
    const notice = buildQuitNotice({
      locale: "en",
      lastBackup: { status: "known", at: "2026-03-01T23:30:00.000Z" },
      timeZone: "Asia/Taipei",
    });
    expect(notice.message).toBe("No daily backup will run after you quit.");
    expect(notice.detail).toContain("Mar 2, 2026");
    expect(notice.detail).toContain("7:30");
  });

  it("is Traditional Chinese for zh and uses that zone's date", () => {
    const notice = buildQuitNotice({
      locale: "zh-TW",
      lastBackup: { status: "known", at: "2026-03-01T23:30:00.000Z" },
      timeZone: "UTC",
    });
    expect(notice.message).toBe("退出後不會每日備份。");
    expect(notice.detail).toMatch(/^最後成功備份：.*2026/);
  });

  it("says plainly when there is no backup, when the time cannot be read, and for a malformed time", () => {
    expect(buildQuitNotice({ locale: "zh-TW", lastBackup: { status: "none" } }).detail).toBe("尚無成功備份");
    expect(buildQuitNotice({ locale: "zh-TW", lastBackup: { status: "unknown" } }).detail).toContain("無法確認");
    expect(buildQuitNotice({ locale: "en", lastBackup: { status: "known", at: "not a date" } }).detail).toBe(
      en.quitUnknownBackup,
    );
  });
});

describe("login item", () => {
  it("passes the background flag on Windows and registers the main app on macOS, without openAsHidden", () => {
    expect(loginItemSettingsFor("win32", true)).toEqual({ openAtLogin: true, args: ["--background"] });
    expect(loginItemSettingsFor("darwin", true)).toEqual({ openAtLogin: true, type: "mainAppService" });
    expect(loginItemSettingsFor("win32", false)).toEqual({ openAtLogin: false });
    expect(loginItemSettingsFor("linux", true)).toBeUndefined();
    expect(JSON.stringify(loginItemSettingsFor("darwin", true))).not.toContain("openAsHidden");
  });

  it("turns on only with explicit consent", () => {
    const base = settings(false);
    const on = changeLoginItem(base, { enable: true, consent: true }, "win32");
    expect(on).toMatchObject({ ok: true, settings: { desired: { launchAtLogin: true } } });
    const forged = changeLoginItem(base, { enable: true } as never, "win32");
    expect(forged).toEqual({ ok: false, reason: "consent-required" });
    const falsy = changeLoginItem(base, { enable: true, consent: false } as never, "win32");
    expect(falsy).toEqual({ ok: false, reason: "consent-required" });
  });

  it("turns off without consent and does not mutate the input", () => {
    const base = settings(true);
    const off = changeLoginItem(base, { enable: false }, "darwin");
    expect(off).toMatchObject({
      ok: true,
      settings: { desired: { launchAtLogin: false } },
      loginItem: { openAtLogin: false },
    });
    expect(base.desired.launchAtLogin).toBe(true);
  });
});

describe("decideSecondInstance", () => {
  it.each([
    [{ repairWindowOpen: true, owner: "MANAGED", backendRunning: true }, "focus-repair"],
    [{ repairWindowOpen: false, owner: "MANAGED", backendRunning: true }, "open-dashboard"],
    [{ repairWindowOpen: false, owner: "MANAGED", backendRunning: false }, "open-repair"],
    [{ repairWindowOpen: false, owner: "NEEDS_REPAIR", backendRunning: false }, "open-repair"],
  ] as const)("%j -> %s", (inputs, expected) => {
    expect(decideSecondInstance(inputs)).toBe(expected);
  });
});
