// The main-process modules this test loads use the desktop build flags; declare them as the desktop build does.
/// <reference path="../../apps/desktop/src/main/build-flags.d.ts" />
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LANGUAGE_CHOICES,
  languageChoiceLabel,
  languageMessages,
  languagePreferenceOf,
  parseDesktopSettings,
  readDesktopSettings,
  resolveShellLanguage,
  shellMessages,
  withLanguagePreference,
  type DesktopSettingsV1,
} from "../../packages/desktop-core/src/index.js";
import { SHELL_LANGUAGE_PREFERENCES, desktopFactsSchema } from "../../packages/schema/src/index.js";

// The tray and the menu are drawn through Electron; these stand-ins keep what they were given.
const electron = vi.hoisted(() => ({
  menus: [] as Array<Array<{ label?: string; type?: string }>>,
  applicationMenu: [] as unknown[],
}));
vi.mock("electron", () => ({
  app: {},
  BrowserWindow: { getFocusedWindow: () => null },
  Menu: {
    buildFromTemplate: (template: unknown) => template,
    setApplicationMenu: (menu: unknown) => electron.applicationMenu.push(menu),
  },
  nativeImage: { createFromPath: () => ({ setTemplateImage: () => undefined }) },
  Notification: class {},
  Tray: class {
    setToolTip(): void {}
    setContextMenu(menu: Array<{ label?: string; type?: string }>): void {
      electron.menus.push(menu);
    }
    on(): void {}
  },
}));

const { ShellState } = await import("../../apps/desktop/src/main/state.js");
const { createShellLanguage } = await import("../../apps/desktop/src/main/language.js");
const { createShellTray } = await import("../../apps/desktop/src/main/tray.js");
const { applyAppMenu } = await import("../../apps/desktop/src/main/app-menu.js");
const { commitSettings } = await import("../../apps/desktop/src/main/settings.js");

/**
 * The App's language setting (跟隨系統 / 繁體中文 / English): the one resolver, the settings field and how a file
 * without it reads, and the shell redrawing in the new language at once, with the Dashboard told the same language.
 * Synthetic paths only.
 */

const temporary: string[] = [];

/** A version-1 file as every App before this setting wrote it (no `language`). */
function olderSettings(): DesktopSettingsV1 {
  return {
    configVersion: 1,
    installId: "install-1",
    desired: {
      databasePath: "/synthetic/data/work.sqlite",
      port: 3210,
      launchAtLogin: false,
      backupDirectory: "/synthetic/data/backups",
    },
  };
}

function settingsFile(content?: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "wi-shell-language-"));
  temporary.push(directory);
  const file = join(directory, "desktop-settings.json");
  if (content !== undefined) writeFileSync(file, JSON.stringify(content));
  return file;
}

function harness(options: { system?: string; settings?: DesktopSettingsV1 | null } = {}) {
  const file = settingsFile(options.settings ?? undefined);
  const state = new ShellState();
  state.settings = options.settings === undefined ? olderSettings() : options.settings;
  let system = options.system ?? "en-US";
  const changes: string[] = [];
  const language = createShellLanguage({
    state,
    paths: { settingsFile: file },
    systemLocale: () => system,
    onChange: () => {
      changes.push(state.locale);
      state.touch();
    },
    log: () => undefined,
  });
  return {
    file,
    state,
    language,
    changes,
    setSystem: (next: string) => {
      system = next;
    },
    saved: () => JSON.parse(readFileSync(file, "utf8")) as DesktopSettingsV1,
  };
}

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
  electron.menus.length = 0;
  electron.applicationMenu.length = 0;
});

describe("one resolver for the App's language", () => {
  it.each([
    ["system", "zh-TW", "zh-TW"],
    ["system", "zh-Hant-HK", "zh-TW"],
    ["system", "zh_CN", "zh-TW"],
    ["system", "en-GB", "en"],
    ["system", "ja-JP", "en"],
    ["system", undefined, "en"],
    ["zh-TW", "en-US", "zh-TW"],
    ["en", "zh-TW", "en"],
  ] as const)("%s on a %s system reads %s", (preference, system, expected) => {
    expect(resolveShellLanguage(preference, system)).toBe(expected);
  });

  it("offers the same three choices the settings file and the protocol accept", () => {
    expect([...LANGUAGE_CHOICES]).toEqual([...SHELL_LANGUAGE_PREFERENCES]);
  });

  it("names each language in itself and 跟隨系統 with the language it reads as", () => {
    const zh = languageMessages("zh-TW");
    const en = languageMessages("en");
    expect(languageChoiceLabel(zh, "system", "en")).toBe("跟隨系統（English）");
    expect(languageChoiceLabel(en, "system", "zh-TW")).toBe("Follow system (繁體中文)");
    expect(languageChoiceLabel(en, "zh-TW", "en")).toBe("繁體中文");
    expect(languageChoiceLabel(zh, "en", "zh-TW")).toBe("English");
    expect(zh.heading).toBe("語言");
    expect(en.heading).toBe("Language");
  });
});

describe("the settings field", () => {
  it("reads a file written before the setting existed as 跟隨系統", async () => {
    const parsed = parseDesktopSettings(olderSettings());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(languagePreferenceOf(parsed.settings)).toBe("system");
    const read = await readDesktopSettings(settingsFile(olderSettings()));
    expect(read.kind).toBe("ok");
    if (read.kind === "ok") expect(languagePreferenceOf(read.settings)).toBe("system");
    expect(languagePreferenceOf(null)).toBe("system");
  });

  it.each(SHELL_LANGUAGE_PREFERENCES)("accepts %s", (language) => {
    const settings = { ...olderSettings(), desired: { ...olderSettings().desired, language } };
    const parsed = parseDesktopSettings(settings);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(languagePreferenceOf(parsed.settings)).toBe(language);
  });

  it.each(["zh-CN", "en-US", "", 1, null])("refuses %j, like any other invalid field", (language) => {
    const parsed = parseDesktopSettings({ ...olderSettings(), desired: { ...olderSettings().desired, language } });
    expect(parsed).toMatchObject({ ok: false, kind: "invalid-schema" });
  });

  it("writes 跟隨系統 by leaving the field out, so the file keeps the shape older versions wrote", () => {
    const chosen = withLanguagePreference(olderSettings(), "zh-TW");
    expect(chosen.desired.language).toBe("zh-TW");
    const back = withLanguagePreference(chosen, "system");
    expect(back).toEqual(olderSettings());
    expect("language" in back.desired).toBe(false);
  });
});

describe("changing the language in the App", () => {
  it("saves the choice and switches every string at once", async () => {
    const { language, state, saved, changes } = harness({ system: "en-US" });
    language.apply();
    expect(state.locale).toBe("en");

    expect(await language.set("zh-TW")).toEqual({ ok: true });

    expect(saved().desired.language).toBe("zh-TW");
    expect(state.locale).toBe("zh-TW");
    expect(state.messages().trayQuit).toBe(shellMessages("zh-TW").trayQuit);
    expect(changes).toEqual(["zh-TW"]);
    expect(language.section()).toEqual({ preference: "zh-TW", systemLocale: "en" });
  });

  it("goes back to the system language with 跟隨系統, and the file loses the field", async () => {
    const { language, state, saved } = harness({ system: "zh-TW" });
    await language.set("en");
    expect(state.locale).toBe("en");
    await language.set("system");
    expect(state.locale).toBe("zh-TW");
    expect("language" in saved().desired).toBe(false);
  });

  it("follows the system language while set to 跟隨系統, and a chosen language ignores it", async () => {
    const { language, state, setSystem } = harness({ system: "en-US" });
    language.apply();
    setSystem("zh-TW");
    language.apply();
    expect(state.locale).toBe("zh-TW");
    await language.set("en");
    setSystem("zh-HK");
    language.apply();
    expect(state.locale).toBe("en");
  });

  it("reads the setting from the file at start", () => {
    const { language, state } = harness({
      system: "en-US",
      settings: withLanguagePreference(olderSettings(), "zh-TW"),
    });
    language.apply();
    expect(state.locale).toBe("zh-TW");
    expect(state.languagePreference).toBe("zh-TW");
  });

  it("says it failed and changes nothing when the settings file cannot be written", async () => {
    const { language, state } = harness({ system: "en-US" });
    language.apply();
    vi.spyOn(state, "updateSettings").mockRejectedValueOnce(new Error("disk full"));
    expect(await language.set("zh-TW")).toEqual({ ok: false, reason: "failed" });
    expect(state.locale).toBe("en");
    expect(state.languagePreference).toBe("system");
  });

  it("keeps a choice made before the first-run page committed the settings, and saves it with them", async () => {
    const { language, state, file } = harness({ system: "en-US", settings: null });
    await language.set("zh-TW");
    language.apply();
    expect(state.locale).toBe("zh-TW");
    state.settings = olderSettings();
    await commitSettings(state, { settingsFile: file } as never);
    expect((JSON.parse(readFileSync(file, "utf8")) as DesktopSettingsV1).desired.language).toBe("zh-TW");
  });
});

describe("the shell redraws in the new language", () => {
  it("rebuilds the tray menu and the application menu after a switch, without a restart", async () => {
    const { language, state } = harness({ system: "en-US" });
    language.apply();
    const tray = createShellTray({
      state,
      iconFile: "/synthetic/icon.png",
      templateIconFile: "/synthetic/icon-template.png",
      backendRunning: () => false,
      openDashboard: () => undefined,
      openStatus: () => undefined,
      openApp: () => undefined,
      openSetup: () => undefined,
      openUpdateCheck: () => undefined,
      requestQuit: () => undefined,
      log: () => undefined,
    });
    tray.create();
    const labels = () => (electron.menus.at(-1) ?? []).map((item) => item.label).filter(Boolean);
    expect(labels()).toContain(shellMessages("en").trayQuit);

    await language.set("zh-TW");
    expect(labels()).toContain(shellMessages("zh-TW").trayQuit);
    expect(labels()).not.toContain(shellMessages("en").trayQuit);

    applyAppMenu("darwin", state.messages());
    expect(JSON.stringify(electron.applicationMenu.at(-1))).toContain(shellMessages("zh-TW").menuEdit);
  });
});

describe("the Dashboard gets the same language", () => {
  it("is told the setting and the language it reads as, in a fact the protocol accepts", async () => {
    const { language } = harness({ system: "zh-TW" });
    language.apply();
    expect(language.fact()).toEqual({ preference: "system", locale: "zh-TW" });
    await language.set("en");
    const fact = language.fact();
    expect(fact).toEqual({ preference: "en", locale: "en" });
    expect(desktopFactsSchema.safeParse({ language: fact }).success).toBe(true);
  });

  it("takes a language picked in the Dashboard as the App's setting", async () => {
    const { language, state, saved } = harness({ system: "en-US" });
    language.apply();
    expect(await language.setFromDashboard("zh-TW")).toEqual({ ok: true });
    expect(state.locale).toBe("zh-TW");
    expect(saved().desired.language).toBe("zh-TW");
    expect(language.fact()).toEqual({ preference: "zh-TW", locale: "zh-TW" });
  });

  it("keeps 跟隨系統 when the Dashboard picks the language the system already reads as", async () => {
    const { language, state, changes } = harness({ system: "zh-TW" });
    language.apply();
    changes.length = 0;
    expect(await language.setFromDashboard("zh-TW")).toEqual({ ok: true });
    expect(state.languagePreference).toBe("system");
    expect(changes).toEqual([]);
  });
});
