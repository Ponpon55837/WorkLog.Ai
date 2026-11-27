import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { standaloneDatabasePath } from "../../packages/shared/src/database-location.js";
import { writeDesktopSettingsAtomic, type DesktopSettingsV1 } from "../../packages/desktop-core/src/settings/index.js";
import { writeDesktopSettingsPointer } from "../../packages/desktop-core/src/integration/index.js";
import {
  DESKTOP_SETTINGS_POINTER_FILE_NAME,
  databaseFromSettingsText,
  resolveDesktopDatabase,
  runLauncher,
  type DesktopDatabaseDeps,
  type LauncherHost,
} from "../../packages/desktop-core/src/runtime/index.js";
import { HOOK_BUDGET_MS, INERT_LEASE_HOST, IS_WINDOWS, installFixture, makeRoot } from "./runtime-helpers.js";

let root = "";
let runtimeDirectory = "";
let settingsFile = "";

function settings(databasePath: string): DesktopSettingsV1 {
  return {
    configVersion: 1,
    installId: "synthetic-install",
    desired: { databasePath, port: 3210, launchAtLogin: false, backupDirectory: path.join(root, "backups") },
  };
}

beforeEach(async () => {
  root = await makeRoot("desktop-database");
  runtimeDirectory = (await installFixture(root, "rt-1", { commit: true })).runtimeDirectory;
  settingsFile = path.join(root, "App 資料", "desktop-settings.json");
  await fsp.mkdir(path.dirname(settingsFile), { recursive: true });
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

interface LaunchRecord {
  readonly host: LauncherHost;
  readonly stderr: string[];
  readonly seen: (string | undefined)[];
}

function launchHost(environment: Record<string, string | undefined> = {}): LaunchRecord {
  const env = { ...environment };
  const stderr: string[] = [];
  const seen: (string | undefined)[] = [];
  const host: LauncherHost = {
    execPath: path.join(runtimeDirectory, "node/bin/node"),
    versions: { node: "24.0.0" },
    platform: "linux",
    arch: "x64",
    stdout: () => undefined,
    stderr: (text) => void stderr.push(text),
    unsetEnv: (name) => void delete env[name],
    getEnv: (name) => env[name],
    setEnv: (name, value) => void (env[name] = value),
    desktopDatabase: (launcherRoot) => resolveDesktopDatabase(launcherRoot),
    setArgv: () => undefined,
    importModule: async () => void seen.push(env.WORK_INTELLIGENCE_DB),
    ...INERT_LEASE_HOST,
  };
  return { host, stderr, seen };
}

async function launch(action: string, record: LaunchRecord): Promise<void> {
  await runLauncher({ runtimeDirectory, argv: [action] }, record.host);
}

describe("resolveDesktopDatabase", () => {
  it("has no opinion before the App recorded its settings, or before it is set up", async () => {
    expect(resolveDesktopDatabase(root)).toEqual({ kind: "none" });
    await writeDesktopSettingsPointer(root, settingsFile);
    expect(resolveDesktopDatabase(root)).toEqual({ kind: "none" });
    await fsp.rm(path.dirname(settingsFile), { recursive: true });
    expect(resolveDesktopDatabase(root)).toEqual({ kind: "none" });
  });

  it("reads the committed database through the pointer", async () => {
    const database = path.join(root, "資料 庫", "work-intelligence.sqlite");
    await writeDesktopSettingsPointer(root, settingsFile);
    await writeDesktopSettingsAtomic(settingsFile, settings(database));
    expect(resolveDesktopDatabase(root)).toEqual({ kind: "ok", databasePath: database });
  });

  it("costs a hook well under the 5 ms budget: two small reads on every call", async () => {
    // Every Agent hook pays this once per run (Q1 of 1.6.49), so it is measured on each CI OS and printed there.
    const database = path.join(root, "資料 庫", "work-intelligence.sqlite");
    await writeDesktopSettingsPointer(root, settingsFile);
    await writeDesktopSettingsAtomic(settingsFile, settings(database));
    const coldStart = performance.now();
    expect(resolveDesktopDatabase(root).kind).toBe("ok");
    const coldMs = performance.now() - coldStart;
    const samples: number[] = [];
    for (let run = 0; run < 51; run += 1) {
      const started = performance.now();
      resolveDesktopDatabase(root);
      samples.push(performance.now() - started);
    }
    samples.sort((left, right) => left - right);
    const medianMs = samples[25] ?? Number.POSITIVE_INFINITY;
    console.log(
      `[hook cost] ${JSON.stringify({ platform: process.platform, coldMs: Number(coldMs.toFixed(3)), medianMs: Number(medianMs.toFixed(3)) })}`,
    );
    // The median, so one slow sample on a busy runner does not decide it; a regression to real work would.
    expect(medianMs).toBeLessThan(HOOK_BUDGET_MS);
  });

  it("writes the pointer once and leaves an identical one alone", async () => {
    expect(await writeDesktopSettingsPointer(root, settingsFile)).toBe("written");
    expect(await writeDesktopSettingsPointer(root, settingsFile)).toBe("unchanged");
    expect(fs.readFileSync(path.join(root, DESKTOP_SETTINGS_POINTER_FILE_NAME), "utf8")).toBe(`${settingsFile}\n`);
    await expect(writeDesktopSettingsPointer(root, "relative/desktop-settings.json")).rejects.toThrow(RangeError);
  });

  it("calls a damaged, foreign or unsafe settings file invalid instead of guessing", async () => {
    await writeDesktopSettingsPointer(root, settingsFile);
    const cases: [string, string][] = [
      ["{", "設定檔不是 JSON"],
      ["[]", "設定檔不是物件"],
      [JSON.stringify({ configVersion: 2, desired: { databasePath: "/a.sqlite" } }), "不支援的設定版本"],
      [JSON.stringify({ configVersion: 1, desired: { databasePath: "relative.sqlite" } }), "沒有支援的絕對資料庫路徑"],
      [JSON.stringify({ configVersion: 1, desired: null }), "沒有支援的絕對資料庫路徑"],
      [JSON.stringify({ configVersion: 1, desired: { databasePath: "/a/../b.sqlite" } }), "沒有支援的絕對資料庫路徑"],
    ];
    for (const [text, reason] of cases) {
      fs.writeFileSync(settingsFile, text);
      const resolution = resolveDesktopDatabase(root);
      expect(resolution.kind).toBe("invalid");
      expect(resolution.kind === "invalid" && resolution.reason).toContain(reason);
    }
    fs.writeFileSync(settingsFile, "x".repeat(70 * 1024));
    expect(resolveDesktopDatabase(root)).toEqual({ kind: "invalid", reason: "設定檔過大" });
    fs.writeFileSync(path.join(root, DESKTOP_SETTINGS_POINTER_FILE_NAME), "relative/path\n");
    expect(resolveDesktopDatabase(root)).toEqual({
      kind: "invalid",
      reason: "指標檔的內容不是支援的絕對路徑",
    });
  });

  it.skipIf(IS_WINDOWS)("does not follow a symbolic link, and refuses files other users own or may write", async () => {
    const database = path.join(root, "a.sqlite");
    const real = path.join(root, "real-settings.json");
    await writeDesktopSettingsAtomic(real, settings(database));
    fs.symlinkSync(real, settingsFile);
    await writeDesktopSettingsPointer(root, settingsFile);
    expect(resolveDesktopDatabase(root)).toEqual({ kind: "invalid", reason: "設定檔是符號連結" });

    await writeDesktopSettingsPointer(root, real);
    fs.chmodSync(real, 0o666);
    expect(resolveDesktopDatabase(root)).toEqual({ kind: "invalid", reason: "設定檔所有人都可寫入" });
    fs.chmodSync(real, 0o600);
    const foreign: DesktopDatabaseDeps = {
      platform: "linux",
      uid: 4242,
      lstat: (file) => fs.lstatSync(file),
      readFile: (file) => fs.readFileSync(file),
    };
    expect(resolveDesktopDatabase(root, foreign)).toEqual({
      kind: "invalid",
      reason: "指標檔屬於其他使用者",
    });
  });

  it("accepts only Windows drive paths on Windows", () => {
    const text = (databasePath: string) => JSON.stringify({ configVersion: 1, desired: { databasePath } });
    expect(databaseFromSettingsText(text("C:\\Users\\測試 者\\wi.sqlite"), "win32")).toEqual({
      kind: "ok",
      databasePath: "C:\\Users\\測試 者\\wi.sqlite",
    });
    expect(databaseFromSettingsText(text("\\\\server\\share\\wi.sqlite"), "win32").kind).toBe("invalid");
    expect(databaseFromSettingsText(text("\\\\?\\C:\\wi.sqlite"), "win32").kind).toBe("invalid");
    expect(databaseFromSettingsText(text("/home/a/wi.sqlite"), "win32").kind).toBe("invalid");
  });
});

describe("runLauncher hands the App's database to Agent actions", () => {
  const ACTIONS = ["mcp", "claude-finalize-reminder", "codex-finalize-reminder"];

  it("gives the MCP server and both hooks the same database, also after the App changed it", async () => {
    const first = path.join(root, "first", "work-intelligence.sqlite");
    const second = path.join(root, "second 資料", "work-intelligence.sqlite");
    await writeDesktopSettingsPointer(root, settingsFile);
    await writeDesktopSettingsAtomic(settingsFile, settings(first));
    const before = launchHost();
    for (const action of ACTIONS) await launch(action, before);
    expect(before.seen).toEqual([first, first, first]);

    await writeDesktopSettingsAtomic(settingsFile, settings(second));
    const after = launchHost();
    for (const action of ACTIONS) await launch(action, after);
    expect(after.seen).toEqual([second, second, second]);
    expect(standaloneDatabasePath({ environment: { WORK_INTELLIGENCE_DB: second } })).toBe(second);
    expect(after.stderr).toEqual([]);
  });

  it("keeps an explicit WORK_INTELLIGENCE_DB and never touches serve", async () => {
    await writeDesktopSettingsPointer(root, settingsFile);
    await writeDesktopSettingsAtomic(settingsFile, settings(path.join(root, "app.sqlite")));
    const explicit = launchHost({ WORK_INTELLIGENCE_DB: "/elsewhere/b.sqlite" });
    for (const action of ACTIONS) await launch(action, explicit);
    expect(explicit.seen).toEqual(["/elsewhere/b.sqlite", "/elsewhere/b.sqlite", "/elsewhere/b.sqlite"]);
    const serve = launchHost();
    await launch("serve", serve);
    expect(serve.seen).toEqual([undefined]);
  });

  it("an adopted entry carries no database variable, so MCP and the hooks both follow the App when it changes database", async () => {
    const app = path.join(root, "app 資料", "work-intelligence.sqlite");
    await writeDesktopSettingsPointer(root, settingsFile);
    await writeDesktopSettingsAtomic(settingsFile, settings(app));
    const mcp = launchHost();
    await launch("mcp", mcp);
    const hooks = launchHost();
    for (const action of ["claude-finalize-reminder", "codex-finalize-reminder"]) await launch(action, hooks);
    expect([...mcp.seen, ...hooks.seen]).toEqual([app, app, app]);
    expect(mcp.stderr).toEqual([]);

    const moved = path.join(root, "moved", "work-intelligence.sqlite");
    await writeDesktopSettingsAtomic(settingsFile, settings(moved));
    const mcpAfter = launchHost();
    await launch("mcp", mcpAfter);
    const hooksAfter = launchHost();
    await launch("codex-finalize-reminder", hooksAfter);
    expect([...mcpAfter.seen, ...hooksAfter.seen]).toEqual([moved, moved]);

    const pinned = launchHost({ WORK_INTELLIGENCE_DB: app });
    await launch("mcp", pinned);
    expect(pinned.seen).toEqual([app]);
  });

  it("keeps the standalone rule without App settings", async () => {
    const none = launchHost();
    for (const action of ACTIONS) await launch(action, none);
    expect(none.seen).toEqual([undefined, undefined, undefined]);
    expect(none.stderr).toEqual([]);
    await writeDesktopSettingsPointer(root, settingsFile);
    const pending = launchHost();
    for (const action of ACTIONS) await launch(action, pending);
    expect(pending.seen).toEqual([undefined, undefined, undefined]);
    expect(pending.stderr).toEqual([]);
  });

  it("never falls back to another database once App settings exist but are unusable", async () => {
    await writeDesktopSettingsPointer(root, settingsFile);
    const unusable: [string, string][] = [
      ["damaged JSON", "{ damaged"],
      ["UNC path", JSON.stringify({ configVersion: 1, desired: { databasePath: "\\\\server\\share\\wi.sqlite" } })],
      ["relative path", JSON.stringify({ configVersion: 1, desired: { databasePath: "rel.sqlite" } })],
    ];
    for (const [, text] of unusable) {
      fs.writeFileSync(settingsFile, text);
      const mcp = launchHost();
      const outcome = await runLauncher({ runtimeDirectory, argv: ["mcp"] }, mcp.host);
      expect(outcome).toEqual({ kind: "exit", code: 78 });
      expect(mcp.seen).toEqual([]);
      expect(mcp.stderr).toHaveLength(1);
      expect(mcp.stderr[0]).toContain("Agent 未啟動");
      expect(mcp.stderr[0]).not.toMatch(/[A-Za-z]{4,} [A-Za-z]{3,}/);
      for (const action of ["claude-finalize-reminder", "codex-finalize-reminder"]) {
        const hook = launchHost();
        expect(await runLauncher({ runtimeDirectory, argv: [action] }, hook.host)).toEqual({ kind: "exit", code: 0 });
        expect(hook.seen).toEqual([]);
        expect(hook.stderr).toEqual([]);
      }
    }
  });

  it.each(["WORK_INTELLIGENCE_HOME", "WORK_INTELLIGENCE_CONFIG_DIR"])(
    "leaves the database to the standalone rule when %s is set",
    async (variable) => {
      await writeDesktopSettingsPointer(root, settingsFile);
      await writeDesktopSettingsAtomic(settingsFile, settings(path.join(root, "app.sqlite")));
      const explicit = launchHost({ [variable]: path.join(root, "mine") });
      for (const action of ACTIONS) await launch(action, explicit);
      expect(explicit.seen).toEqual([undefined, undefined, undefined]);
      fs.writeFileSync(settingsFile, "{ damaged");
      const damaged = launchHost({ [variable]: path.join(root, "mine") });
      for (const action of ACTIONS) await launch(action, damaged);
      expect(damaged.seen).toEqual([undefined, undefined, undefined]);
      expect(damaged.stderr).toEqual([]);
    },
  );
});
