// The main-process modules this test loads use the desktop build flags; declare them as the desktop build does.
/// <reference path="../../apps/desktop/src/main/build-flags.d.ts" />
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LANGUAGE_CHOICES,
  languageChoiceLabel,
  languageMessages,
  LANGUAGE_PREFERENCES_FILE_NAME,
  parseLanguagePreferences,
  readDesktopSettings,
  readLanguagePreference,
  resolveShellLanguage,
  shellMessages,
  writeLanguagePreference,
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
const { loadSettings } = await import("../../apps/desktop/src/main/settings.js");
const { createShellTray } = await import("../../apps/desktop/src/main/tray.js");
const { applyAppMenu } = await import("../../apps/desktop/src/main/app-menu.js");

/**
 * The App's language choice (跟隨系統 / 繁體中文 / English): the one resolver, its own file next to the settings (never
 * the settings file, so an older App never asks for a repair after a downgrade), a file that cannot be used reading as
 * 跟隨系統, and the shell redrawing in the new language at once, with the Dashboard told the same language.
 * Synthetic paths only.
 */

const temporary: string[] = [];

/** A version-1 settings file as every App writes it. */
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

function dataDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "wi-shell-language-"));
  temporary.push(directory);
  return directory;
}

function harness(options: { system?: string; preferences?: string } = {}) {
  const directory = dataDirectory();
  const preferencesFile = join(directory, LANGUAGE_PREFERENCES_FILE_NAME);
  const settingsFile = join(directory, "desktop-settings.json");
  const settingsText = `${JSON.stringify(olderSettings(), null, 2)}\n`;
  writeFileSync(settingsFile, settingsText);
  if (options.preferences !== undefined) writeFileSync(preferencesFile, options.preferences);
  const state = new ShellState();
  state.settings = olderSettings();
  let system = options.system ?? "en-US";
  const changes: string[] = [];
  const logs: string[] = [];
  const paths = { preferencesFile };
  const language = createShellLanguage({
    state,
    paths,
    systemLocale: () => system,
    onChange: () => {
      changes.push(state.locale);
      state.touch();
    },
    log: (line: string) => logs.push(line),
  });
  return {
    directory,
    paths,
    preferencesFile,
    state,
    language,
    changes,
    logs,
    setSystem: (next: string) => {
      system = next;
    },
    saved: () => (existsSync(preferencesFile) ? (JSON.parse(readFileSync(preferencesFile, "utf8")) as unknown) : null),
    settingsUnchanged: () => readFileSync(settingsFile, "utf8") === settingsText,
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

  it("offers the same three choices the protocol accepts", () => {
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

describe("the language file", () => {
  it("is missing on every install so far, which reads as 跟隨系統 without a problem", async () => {
    const { preferencesFile } = harness();
    expect(await readLanguagePreference(preferencesFile)).toEqual({ preference: "system" });
  });

  it.each(["zh-TW", "en"] as const)("reads %s", (language) => {
    expect(parseLanguagePreferences(JSON.stringify({ language }))).toEqual({ preference: language });
  });

  it("reads a file without a language, or with keys a newer App added, as what it says", () => {
    expect(parseLanguagePreferences("{}")).toEqual({ preference: "system" });
    expect(parseLanguagePreferences(JSON.stringify({ language: "en", theme: "dark" }))).toEqual({ preference: "en" });
  });

  it.each([
    ["not JSON", "{ language: "],
    ["an empty file", ""],
    ["an unknown language", JSON.stringify({ language: "zh-CN" })],
    ["system written out", JSON.stringify({ language: "system" })],
    ["a number", JSON.stringify({ language: 1 })],
    ["an array", "[]"],
    ["null", "null"],
    ["an oversized file", JSON.stringify({ language: "en", padding: "x".repeat(5000) })],
  ])("reads %s as 跟隨系統 and says it is invalid", (_name, text) => {
    expect(parseLanguagePreferences(text)).toEqual({ preference: "system", problem: "invalid" });
  });

  it("reads a file that cannot be read as 跟隨系統 and says it is unreadable", async () => {
    const { preferencesFile } = harness();
    mkdirSync(preferencesFile);
    expect(await readLanguagePreference(preferencesFile)).toEqual({ preference: "system", problem: "unreadable" });
  });
  it("writes a language atomically and removes the file for 跟隨系統", async () => {
    const { preferencesFile, directory } = harness();
    await writeLanguagePreference(preferencesFile, "en");
    expect(readFileSync(preferencesFile, "utf8")).toBe('{\n  "language": "en"\n}\n');
    expect(await readLanguagePreference(preferencesFile)).toEqual({ preference: "en" });
    await writeLanguagePreference(preferencesFile, "system");
    expect(existsSync(preferencesFile)).toBe(false);
    await writeLanguagePreference(preferencesFile, "system");
    expect(readdirSync(directory)).toEqual(["desktop-settings.json"]);
  });
});

describe("starting with the language file", () => {
  it("takes the language from the file", async () => {
    const { language, state, logs } = harness({ system: "en-US", preferences: JSON.stringify({ language: "zh-TW" }) });
    await language.load();
    expect(state.languagePreference).toBe("zh-TW");
    expect(state.locale).toBe("zh-TW");
    expect(logs).toEqual([]);
  });

  it("follows the system with one log line when the file is damaged, and the start never asks for a repair", async () => {
    const { language, state, logs, directory, preferencesFile, settingsUnchanged } = harness({
      system: "zh-TW",
      preferences: "\u0000garbage",
    });
    // The start as main runs it: the settings and the language file are read side by side.
    const paths = { settingsFile: join(directory, "desktop-settings.json"), preferencesFile } as never;
    const [load] = await Promise.all([loadSettings(state, paths, (line: string) => logs.push(line)), language.load()]);
    expect(load).toBe("ok");
    expect(state.owner).not.toBe("NEEDS_REPAIR");
    expect(state.languagePreference).toBe("system");
    expect(state.locale).toBe("zh-TW");
    expect(logs).toEqual(["[shell] the language file is invalid; following the system language"]);
    expect(settingsUnchanged()).toBe(true);
  });

  it("follows the system when the file cannot be read", async () => {
    const { language, state, logs, preferencesFile } = harness({ system: "en-US" });
    mkdirSync(preferencesFile);
    await language.load();
    expect(state.locale).toBe("en");
    expect(logs).toEqual(["[shell] the language file is unreadable; following the system language"]);
  });
});

describe("changing the language in the App", () => {
  it("saves the choice in its own file, switches every string at once, and leaves the settings file alone", async () => {
    const { language, state, saved, changes, settingsUnchanged } = harness({ system: "en-US" });
    await language.load();
    expect(state.locale).toBe("en");

    expect(await language.set("zh-TW")).toEqual({ ok: true });

    expect(saved()).toEqual({ language: "zh-TW" });
    expect(state.locale).toBe("zh-TW");
    expect(state.messages().trayQuit).toBe(shellMessages("zh-TW").trayQuit);
    expect(changes).toEqual(["zh-TW"]);
    expect(language.section()).toEqual({ preference: "zh-TW", systemLocale: "en" });
    expect(settingsUnchanged()).toBe(true);
  });

  it("keeps the settings file one an older App reads", async () => {
    const { language, directory } = harness();
    await language.set("en");
    const read = await readDesktopSettings(join(directory, "desktop-settings.json"));
    expect(read).toMatchObject({ kind: "ok", settings: olderSettings() });
  });

  it("replaces the file atomically, leaving no temporary file behind", async () => {
    const { language, directory, saved } = harness();
    await language.set("en");
    await language.set("zh-TW");
    expect(saved()).toEqual({ language: "zh-TW" });
    expect(readdirSync(directory).sort()).toEqual([LANGUAGE_PREFERENCES_FILE_NAME, "desktop-settings.json"].sort());
  });

  it("goes back to the system language with 跟隨系統, which removes the file", async () => {
    const { language, state, saved } = harness({ system: "zh-TW" });
    await language.set("en");
    expect(state.locale).toBe("en");
    await language.set("system");
    expect(state.locale).toBe("zh-TW");
    expect(saved()).toBeNull();
    expect(await language.set("system")).toEqual({ ok: true });
  });

  it("follows the system language while set to 跟隨系統, and a chosen language ignores it", async () => {
    const { language, state, setSystem } = harness({ system: "en-US" });
    await language.load();
    setSystem("zh-TW");
    language.apply();
    expect(state.locale).toBe("zh-TW");
    await language.set("en");
    setSystem("zh-HK");
    language.apply();
    expect(state.locale).toBe("en");
  });

  it("can be chosen before the first-run page wrote any settings", async () => {
    const { language, state, saved } = harness({ system: "en-US" });
    state.settings = null;
    expect(await language.set("zh-TW")).toEqual({ ok: true });
    expect(saved()).toEqual({ language: "zh-TW" });
  });

  it("says it failed and changes nothing when the file cannot be written", async () => {
    const { language, state, preferencesFile, logs } = harness({ system: "en-US" });
    await language.load();
    // A directory where the file goes: the rename into place fails.
    mkdirSync(join(preferencesFile, "occupied"), { recursive: true });
    expect(await language.set("zh-TW")).toEqual({ ok: false, reason: "failed" });
    expect(state.locale).toBe("en");
    expect(state.languagePreference).toBe("system");
    expect(logs).toContain("[shell] the language choice could not be saved");
  });
});

describe("the shell redraws in the new language", () => {
  it("rebuilds the tray menu and the application menu after a switch, without a restart", async () => {
    const { language, state } = harness({ system: "en-US" });
    await language.load();
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
  it("is told the choice and the language it reads as, in a fact the protocol accepts", async () => {
    const { language } = harness({ system: "zh-TW" });
    await language.load();
    expect(language.fact()).toEqual({ preference: "system", locale: "zh-TW" });
    await language.set("en");
    const fact = language.fact();
    expect(fact).toEqual({ preference: "en", locale: "en" });
    expect(desktopFactsSchema.safeParse({ language: fact }).success).toBe(true);
  });

  it("takes a language picked in the Dashboard as the App's choice", async () => {
    const { language, state, saved } = harness({ system: "en-US" });
    await language.load();
    expect(await language.setFromDashboard("zh-TW")).toEqual({ ok: true });
    expect(state.locale).toBe("zh-TW");
    expect(saved()).toEqual({ language: "zh-TW" });
    expect(language.fact()).toEqual({ preference: "zh-TW", locale: "zh-TW" });
  });

  it("keeps 跟隨系統 when the Dashboard picks the language the system already reads as", async () => {
    const { language, state, changes, saved } = harness({ system: "zh-TW" });
    await language.load();
    changes.length = 0;
    expect(await language.setFromDashboard("zh-TW")).toEqual({ ok: true });
    expect(state.languagePreference).toBe("system");
    expect(changes).toEqual([]);
    expect(saved()).toBeNull();
  });
});
