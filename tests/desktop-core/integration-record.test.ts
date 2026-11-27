import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalInstallationPath,
  INTEGRATION_RECORD_FILE_NAME,
  integrationConfigDirectory,
  integrationRecordPath,
  launcherShimPath,
  parseIntegrationRecord,
  publishIntegrationRecord,
  readIntegrationRecord,
} from "../../packages/desktop-core/src/integration/index.js";
import {
  configDirectory,
  parseDesktopIntegration,
} from "../../plugins/work-intelligence/scripts/desktop-integration.mjs";

let directory = "";

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-integration-"));
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

const POSIX_INPUTS = {
  runtimeRoot: "/Users/test user/Library/Application Support/WorkIntelligence/runtime",
  appExecutable: "/Applications/Work Intelligence.app/Contents/MacOS/Work Intelligence",
  appVersion: "1.7.0",
};
const WINDOWS_INPUTS = {
  runtimeRoot: "C:\\Users\\測試 user\\AppData\\Local\\WorkIntelligence\\runtime",
  appExecutable: "C:\\Users\\測試 user\\AppData\\Local\\Programs\\Work Intelligence\\Work Intelligence.exe",
  appVersion: "1.7.0",
};

function recordText(platform: NodeJS.Platform, change: Record<string, unknown> = {}): string {
  const inputs = platform === "win32" ? WINDOWS_INPUTS : POSIX_INPUTS;
  return JSON.stringify({
    version: 1,
    launcherPath: launcherShimPath(inputs.runtimeRoot, platform),
    ...inputs,
    writtenAt: "2026-01-01T00:00:00.000Z",
    ...change,
  });
}

function windowsRoot(runtimeRoot: string): Record<string, unknown> {
  return { runtimeRoot, launcherPath: launcherShimPath(runtimeRoot, "win32") };
}

describe("publishIntegrationRecord", () => {
  it("writes the record atomically: only paths and the version, with the shim of the runtime root", async () => {
    const file = path.join(directory, "config", INTEGRATION_RECORD_FILE_NAME);
    expect(await publishIntegrationRecord(file, POSIX_INPUTS, { platform: "linux" })).toBe("written");
    const written = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    expect(Object.keys(written)).toEqual([
      "version",
      "launcherPath",
      "runtimeRoot",
      "appExecutable",
      "appVersion",
      "writtenAt",
    ]);
    expect(written.launcherPath).toBe(`${POSIX_INPUTS.runtimeRoot}/bin/work-intelligence-launcher`);
    expect(await readIntegrationRecord(file, "linux")).toMatchObject(POSIX_INPUTS);
    expect((await fs.readdir(path.dirname(file))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("writes nothing when the file already says the same, whatever time it is", async () => {
    const file = path.join(directory, INTEGRATION_RECORD_FILE_NAME);
    await publishIntegrationRecord(file, POSIX_INPUTS, { platform: "linux", now: () => new Date(1_000) });
    const before = await fs.stat(file);
    expect(
      await publishIntegrationRecord(file, POSIX_INPUTS, { platform: "linux", now: () => new Date(9_999_000) }),
    ).toBe("unchanged");
    const after = await fs.stat(file);
    expect({ ino: after.ino, mtimeMs: after.mtimeMs }).toEqual({ ino: before.ino, mtimeMs: before.mtimeMs });
  });

  it.each([
    ["the app version", { appVersion: "1.8.0" }],
    ["the app executable", { appExecutable: "/Applications/Moved.app/Contents/MacOS/Moved" }],
    ["the runtime root", { runtimeRoot: "/Users/test/runtime-elsewhere" }],
  ])("rewrites it when %s changes", async (_name, change) => {
    const file = path.join(directory, INTEGRATION_RECORD_FILE_NAME);
    await publishIntegrationRecord(file, POSIX_INPUTS, { platform: "linux" });
    expect(await publishIntegrationRecord(file, { ...POSIX_INPUTS, ...change }, { platform: "linux" })).toBe("written");
    expect(await readIntegrationRecord(file, "linux")).toMatchObject(change);
  });

  it("repairs a damaged or foreign file", async () => {
    const file = path.join(directory, INTEGRATION_RECORD_FILE_NAME);
    await fs.writeFile(file, "{not json");
    expect(await publishIntegrationRecord(file, POSIX_INPUTS, { platform: "linux" })).toBe("written");
    expect(await readIntegrationRecord(file, "linux")).toMatchObject(POSIX_INPUTS);
  });

  it.each([
    ["a relative runtime root", { ...POSIX_INPUTS, runtimeRoot: "runtime" }],
    ["a runtime root with .. segments", { ...POSIX_INPUTS, runtimeRoot: "/a/../b" }],
    ["a relative app executable", { ...POSIX_INPUTS, appExecutable: "app" }],
    ["an empty version", { ...POSIX_INPUTS, appVersion: "" }],
  ])("refuses to write %s", async (_name, inputs) => {
    const file = path.join(directory, INTEGRATION_RECORD_FILE_NAME);
    await expect(publishIntegrationRecord(file, inputs, { platform: "linux" })).rejects.toThrow(RangeError);
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("canonical installation paths", () => {
  const throwing = (): string => {
    throw new Error("ENOENT");
  };

  it("stores the real path of a symlinked runtime root and executable, and a warm start through it writes nothing", async (context) => {
    const real = path.join(await fs.realpath(directory), "real");
    await fs.mkdir(path.join(real, "runtime"), { recursive: true });
    await fs.writeFile(path.join(real, "app"), "");
    const link = path.join(directory, "link");
    try {
      await fs.symlink(real, link, "dir");
    } catch {
      context.skip();
    }
    const inputs = { ...POSIX_INPUTS, runtimeRoot: path.join(link, "runtime"), appExecutable: path.join(link, "app") };
    const file = path.join(directory, INTEGRATION_RECORD_FILE_NAME);
    const platform = process.platform;
    expect(await publishIntegrationRecord(file, inputs, { platform, now: () => new Date(1_000) })).toBe("written");
    const record = await readIntegrationRecord(file, platform);
    expect(record).toMatchObject({
      runtimeRoot: path.join(real, "runtime"),
      appExecutable: path.join(real, "app"),
      launcherPath: launcherShimPath(path.join(real, "runtime"), platform),
    });
    const before = await fs.stat(file);
    expect(await publishIntegrationRecord(file, inputs, { platform, now: () => new Date(9_000_000) })).toBe(
      "unchanged",
    );
    expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs);
  });

  it("uses the injected realpath and derives the launcher path from the canonical runtime root", async () => {
    const file = path.join(directory, INTEGRATION_RECORD_FILE_NAME);
    const realpath = (value: string) => value.replace("/link/", "/real/");
    const inputs = { ...POSIX_INPUTS, runtimeRoot: "/link/runtime", appExecutable: "/link/app" };
    await publishIntegrationRecord(file, inputs, { platform: "linux", realpath });
    expect(await readIntegrationRecord(file, "linux")).toMatchObject({
      runtimeRoot: "/real/runtime",
      appExecutable: "/real/app",
      launcherPath: "/real/runtime/bin/work-intelligence-launcher",
    });
    expect(await publishIntegrationRecord(file, inputs, { platform: "linux", realpath })).toBe("unchanged");
  });

  it("keeps the value as given when the path cannot be resolved", () => {
    expect(canonicalInstallationPath("/missing/app", "linux", throwing)).toBe("/missing/app");
    expect(canonicalInstallationPath("C:\\Missing\\app.exe", "win32", throwing)).toBe("C:\\Missing\\app.exe");
  });

  it("does not turn a relative path into an absolute one", () => {
    expect(canonicalInstallationPath("runtime", "linux", () => "/cwd/runtime")).toBe("runtime");
    expect(canonicalInstallationPath("C:runtime", "win32", () => "C:\\cwd\\runtime")).toBe("C:runtime");
  });

  it("strips the Windows verbatim prefix of a drive path and takes the real letter case", () => {
    expect(canonicalInstallationPath("c:\\progra~1\\app.exe", "win32", () => "\\\\?\\C:\\Program Files\\app.exe")).toBe(
      "C:\\Program Files\\app.exe",
    );
    expect(canonicalInstallationPath("c:\\users\\app.exe", "win32", () => "C:\\Users\\app.exe")).toBe(
      "C:\\Users\\app.exe",
    );
  });

  it.each([
    ["a UNC path", "\\\\server\\share\\runtime"],
    ["a verbatim UNC path", "\\\\?\\UNC\\server\\share\\runtime"],
  ])("keeps the original when Windows resolves it to %s", async (_name, resolved) => {
    expect(canonicalInstallationPath("Z:\\runtime", "win32", () => resolved)).toBe("Z:\\runtime");
    const file = path.join(directory, INTEGRATION_RECORD_FILE_NAME);
    const inputs = { ...WINDOWS_INPUTS, runtimeRoot: "Z:\\runtime" };
    await publishIntegrationRecord(file, inputs, { platform: "win32", realpath: () => resolved });
    expect(await readIntegrationRecord(file, "win32")).toMatchObject({ runtimeRoot: "Z:\\runtime" });
  });

  it("returns the resolved path on POSIX without touching it", () => {
    expect(canonicalInstallationPath("/var/x", "darwin", () => "/private/var/x")).toBe("/private/var/x");
  });
});

describe("where the record lives", () => {
  it("is next to plugin-link.json: WORK_INTELLIGENCE_CONFIG_DIR, else ~/.work-intelligence", () => {
    const home = path.join(directory, "home");
    expect(integrationConfigDirectory({ env: {}, homedir: home })).toBe(path.join(home, ".work-intelligence"));
    expect(integrationConfigDirectory({ env: { WORK_INTELLIGENCE_CONFIG_DIR: "  " }, homedir: home })).toBe(
      path.join(home, ".work-intelligence"),
    );
    const env = { WORK_INTELLIGENCE_CONFIG_DIR: path.join(directory, "config") };
    expect(integrationRecordPath({ env, homedir: home })).toBe(
      path.join(directory, "config", "desktop-integration.json"),
    );
    for (const environment of [{}, env]) {
      expect(configDirectory(environment, home)).toBe(integrationConfigDirectory({ env: environment, homedir: home }));
    }
  });
});

describe("the validation rules of the App and of the plugin script", () => {
  const platforms: NodeJS.Platform[] = ["linux", "win32"];
  const corpus: Array<[string, (platform: NodeJS.Platform) => string, boolean]> = [
    ["a valid record", (platform) => recordText(platform), true],
    [
      "a launcher path of another runtime",
      (platform) =>
        recordText(platform, {
          launcherPath:
            platform === "win32" ? "C:\\x\\bin\\work-intelligence-launcher.cmd" : "/x/bin/work-intelligence-launcher",
        }),
      false,
    ],
    [
      "a relative launcher path",
      (platform) => recordText(platform, { launcherPath: "bin/work-intelligence-launcher" }),
      false,
    ],
    ["a relative runtime root", (platform) => recordText(platform, { runtimeRoot: "runtime" }), false],
    ["a relative app executable", (platform) => recordText(platform, { appExecutable: "app" }), false],
    [
      "a non-normalized app executable",
      (platform) => recordText(platform, { appExecutable: platform === "win32" ? "C:\\a\\..\\b.exe" : "/a/../b" }),
      false,
    ],
    ["an extra field", (platform) => recordText(platform, { extra: true }), false],
    ["another version", (platform) => recordText(platform, { version: 2 }), false],
    ["a string version", (platform) => recordText(platform, { version: "1" }), false],
    ["an empty app version", (platform) => recordText(platform, { appVersion: "" }), false],
    ["a numeric app version", (platform) => recordText(platform, { appVersion: 1 }), false],
    [
      "a NUL in a path",
      (platform) => recordText(platform, { appExecutable: `${platform === "win32" ? "C:\\a" : "/a"}\0b` }),
      false,
    ],
    ["an array", () => "[]", false],
    ["null", () => "null", false],
    ["not JSON", () => "{", false],
    ["an empty file", () => "", false],
  ];

  it.each(platforms)("agree on every case on %s", (platform) => {
    for (const [name, text, valid] of corpus) {
      const input = text(platform);
      expect(parseIntegrationRecord(input, platform) !== undefined, `App: ${name}`).toBe(valid);
      expect(parseDesktopIntegration(input, platform) !== undefined, `plugin: ${name}`).toBe(valid);
    }
  });

  const windowsCorpus: Array<[string, Record<string, unknown>, boolean]> = [
    ["a UNC runtime root", windowsRoot("\\\\server\\share\\runtime"), false],
    ["a verbatim UNC runtime root", windowsRoot("\\\\?\\UNC\\server\\share\\runtime"), false],
    ["a verbatim drive runtime root", windowsRoot("\\\\?\\C:\\runtime"), false],
    ["a device-namespace runtime root", windowsRoot("\\\\.\\C:\\runtime"), false],
    ["a UNC app executable", { appExecutable: "\\\\server\\share\\app.exe" }, false],
    ["a device-namespace app executable", { appExecutable: "\\\\.\\pipe\\app.exe" }, false],
    ["a rooted path without a drive", windowsRoot("\\runtime"), false],
    ["a drive-relative path", windowsRoot("C:runtime"), false],
    ["a runtime root with a .. segment", windowsRoot("C:\\a\\..\\b"), false],
    ["a forward-slash app executable", { appExecutable: "C:/Program Files/app.exe" }, false],
    ["a lower-case drive and mixed-case folders", windowsRoot("c:\\USERS\\Test\\Runtime"), true],
    [
      "the POSIX shim name",
      { launcherPath: "C:\\runtime\\bin\\work-intelligence-launcher", runtimeRoot: "C:\\runtime" },
      false,
    ],
  ];

  it.each(windowsCorpus)("agree on Windows paths: %s", (_name, change, valid) => {
    const input = recordText("win32", change);
    expect(parseIntegrationRecord(input, "win32") !== undefined).toBe(valid);
    expect(parseDesktopIntegration(input, "win32") !== undefined).toBe(valid);
  });

  it("read a valid record the same way", () => {
    for (const platform of platforms) {
      expect(parseDesktopIntegration(recordText(platform), platform)).toEqual(
        parseIntegrationRecord(recordText(platform), platform),
      );
    }
  });

  it("do not accept a Windows record on POSIX or the reverse", () => {
    expect(parseIntegrationRecord(recordText("win32"), "linux")).toBeUndefined();
    expect(parseDesktopIntegration(recordText("linux"), "win32")).toBeUndefined();
  });
});
