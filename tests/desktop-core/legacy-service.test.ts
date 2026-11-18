import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUserServicePlan } from "../../apps/server/src/user-service.js";
import {
  createLegacyCommandRunner,
  decodeLegacyDefinition,
  detectLegacyService,
  legacyDefinitionDigest,
  legacyServiceDefinitionPath,
  type DetectLegacyServiceOptions,
  type LegacyServiceCommandResult,
  type LegacyServiceFileStat,
  type LegacyServiceFound,
} from "../../packages/desktop-core/src/legacy-service/index.js";

type Platform = "darwin" | "linux" | "win32";
type Reply = LegacyServiceCommandResult | "hang";

const directories: string[] = [];
const POSIX_ROOT = "/srv/Work Log ünï 專案/it's $HOME";
const WINDOWS_ROOT = "C:\\Users\\Ünï Üser\\Work Log 專案 & co";
const WINDOWS_HOME = "C:\\Users\\Ünï Üser";
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const WINDOWS_ENVIRONMENT = { SystemRoot: "C:\\Windows" };

/** What the structured Windows query prints: numeric state, enabled flags, and the task XML as base64 of UTF-8. */
function taskReply(
  task: { state: number; enabled?: boolean; logon?: boolean; xml?: string } | "absent",
): LegacyServiceCommandResult {
  if (task === "absent") return { stdout: "{}\r\n", code: 0 };
  const { xml, ...rest } = task;
  const body = {
    enabled: true,
    logon: true,
    ...rest,
    ...(xml === undefined ? {} : { xml: Buffer.from(xml, "utf8").toString("base64") }),
  };
  return { stdout: `${JSON.stringify(body)}\r\n`, code: 0 };
}

function systemdReply(
  values: { LoadState?: string; ActiveState?: string; UnitFileState?: string },
  code = 0,
): LegacyServiceCommandResult {
  return {
    stdout: Object.entries(values)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
    code,
  };
}

function tempHome(): string {
  const directory = mkdtempSync(join(tmpdir(), "wi-legacy-service-"));
  directories.push(directory);
  return directory;
}

function planFor(platform: Platform, home: string, root: string, environment: NodeJS.ProcessEnv = {}) {
  return createUserServicePlan({
    platform,
    homeDirectory: home,
    repositoryRoot: root,
    environment: { ...environment, PATH: "" },
    nodeExecutable: platform === "win32" ? "C:\\Program Files\\nodejs\\node.exe" : "/usr/local/bin/node",
    packageManagerExecutable: platform === "win32" ? "C:\\Users\\Ünï Üser\\pnpm.cmd" : "/usr/local/bin/pnpm",
    userId: "S-1-5-21-1-2-3-1001",
    uid: 501,
  });
}

/** Writes the exact bytes the installer would write for a POSIX platform; returns the plan's definition path. */
function installPosix(platform: "darwin" | "linux", home: string, environment: NodeJS.ProcessEnv = {}): string {
  const plan = planFor(platform, home, POSIX_ROOT, environment);
  const file = plan.files[0]!;
  mkdirSync(dirname(file.path), { recursive: true });
  writeFileSync(file.path, file.contents);
  return file.path;
}

function fakeRunner(replies: Record<string, Reply> = {}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runCommand: NonNullable<DetectLegacyServiceOptions["runCommand"]> = (command, args) => {
    calls.push({ command, args });
    const reply = replies[`${command} ${args.join(" ")}`] ?? replies[command] ?? { stdout: "", code: 1 };
    return reply === "hang" ? new Promise(() => undefined) : Promise.resolve(reply);
  };
  return { calls, runCommand };
}

/** A virtual file system for a definition path that cannot exist on the test host (Windows paths on POSIX, and back). */
function virtualFiles(files: Record<string, string | LegacyServiceFileStat>) {
  return {
    lstatFile: (path: string) => {
      const entry = files[path];
      if (entry === undefined) return Promise.resolve(null);
      if (typeof entry !== "string") return Promise.resolve(entry);
      return Promise.resolve({ isSymbolicLink: false, isFile: true, size: entry.length });
    },
    readTextFile: (path: string) => {
      const entry = files[path];
      return typeof entry === "string" ? Promise.resolve(entry) : Promise.reject(new Error("unreadable"));
    },
  };
}

function found(detection: Awaited<ReturnType<typeof detectLegacyService>>): LegacyServiceFound {
  if (detection.kind !== "found") throw new Error("expected a legacy service");
  return detection;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("detectLegacyService: nothing installed", () => {
  it("reports none and runs no command on macOS and Linux without a definition", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      const runner = fakeRunner();
      const result = await detectLegacyService({
        platform,
        homeDirectory: tempHome(),
        environment: {},
        runCommand: runner.runCommand,
      });
      expect(result).toEqual({ kind: "none" });
      expect(runner.calls).toEqual([]);
    }
  });

  it("reports none on Windows when neither the XML copy nor the task exists", async () => {
    const runner = fakeRunner({ [POWERSHELL]: taskReply("absent") });
    const result = await detectLegacyService({
      platform: "win32",
      homeDirectory: WINDOWS_HOME,
      environment: WINDOWS_ENVIRONMENT,
      runCommand: runner.runCommand,
      ...virtualFiles({}),
    });
    expect(result).toEqual({ kind: "none" });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.command).toBe(POWERSHELL);
    expect(runner.calls[0]!.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    expect(runner.calls[0]!.args[3]).toContain("Get-ScheduledTask -TaskPath '\\' -TaskName 'Work Intelligence'");
  });

  it("reports none on an unsupported platform", async () => {
    expect(await detectLegacyService({ platform: "freebsd", homeDirectory: "/home/a", environment: {} })).toEqual({
      kind: "none",
    });
  });
});

describe("detectLegacyService: recognised definitions", () => {
  it("recognises the macOS LaunchAgent, reads root, database and default port, and queries launchctl", async () => {
    const home = tempHome();
    const path = installPosix("darwin", home);
    const runner = fakeRunner({ "/bin/launchctl": { stdout: "state = running\n\tpid = 42", code: 0 } });
    const result = found(
      await detectLegacyService({ platform: "darwin", homeDirectory: home, environment: {}, uid: 501, ...runner }),
    );
    expect(result).toMatchObject({
      platform: "darwin",
      definitionPath: path,
      definitionSource: "file",
      recognised: true,
      repositoryRoot: POSIX_ROOT,
      databasePath: `${POSIX_ROOT}/data/work-intelligence.sqlite`,
      port: 3210,
      running: "running",
    });
    expect(runner.calls).toEqual([
      { command: "/bin/launchctl", args: ["print", "gui/501/ai.workintelligence.server"] },
    ]);
  });

  it("recognises the Linux unit, honours XDG_CONFIG_HOME, and reports stopped", async () => {
    // A POSIX home with in-memory files: on a Windows test host a real temp folder is not POSIX-absolute, so it could
    // never be a Linux XDG_CONFIG_HOME.
    const home = "/home/tester";
    const environment = { XDG_CONFIG_HOME: "/home/tester/xdg ünï" };
    const file = planFor("linux", home, POSIX_ROOT, environment).files[0]!;
    const path = file.path;
    const runner = fakeRunner({
      systemctl: systemdReply({ LoadState: "loaded", ActiveState: "inactive", UnitFileState: "disabled" }),
    });
    const result = found(
      await detectLegacyService({
        platform: "linux",
        homeDirectory: home,
        environment,
        ...runner,
        ...virtualFiles({ [path]: file.contents }),
      }),
    );
    expect(path).toBe("/home/tester/xdg ünï/systemd/user/work-intelligence.service");
    expect(result).toMatchObject({
      definitionPath: path,
      recognised: true,
      repositoryRoot: POSIX_ROOT,
      databasePath: `${POSIX_ROOT}/data/work-intelligence.sqlite`,
      running: "stopped",
    });
    expect(runner.calls).toEqual([
      {
        command: "systemctl",
        args: [
          "--user",
          "show",
          "work-intelligence.service",
          "--property=LoadState",
          "--property=ActiveState",
          "--property=UnitFileState",
        ],
      },
    ]);
  });

  it("fingerprints only a recognised definition, so the disable acts on exactly what was previewed", async () => {
    const home = "/home/tester";
    const file = planFor("linux", home, POSIX_ROOT).files[0]!;
    const detect = (contents: string) =>
      detectLegacyService({
        platform: "linux",
        homeDirectory: home,
        environment: {},
        ...fakeRunner({ systemctl: systemdReply({ LoadState: "loaded", ActiveState: "active" }) }),
        ...virtualFiles({ [file.path]: contents }),
      }).then(found);
    const recognised = await detect(file.contents);
    expect(recognised.definitionDigest).toBe(legacyDefinitionDigest(file.contents));
    expect(recognised.definitionDigest).toMatch(/^[0-9a-f]{64}$/);
    const foreign = await detect("[Unit]\nDescription=something else\n");
    expect(foreign.recognised).toBe(false);
    expect(foreign.definitionDigest).toBeUndefined();
  });

  it("recognises the Windows task XML copy, decodes quoting, and reads the numeric task state", async () => {
    const plan = planFor("win32", WINDOWS_HOME, WINDOWS_ROOT);
    const file = plan.files[0]!;
    const runner = fakeRunner({ [POWERSHELL]: taskReply({ state: 4 }) });
    const result = found(
      await detectLegacyService({
        platform: "win32",
        homeDirectory: WINDOWS_HOME,
        environment: WINDOWS_ENVIRONMENT,
        runCommand: runner.runCommand,
        ...virtualFiles({ [file.path]: file.contents }),
      }),
    );
    expect(result).toMatchObject({
      platform: "win32",
      definitionPath: file.path,
      definitionSource: "file",
      recognised: true,
      repositoryRoot: WINDOWS_ROOT,
      databasePath: `${WINDOWS_ROOT}\\data\\work-intelligence.sqlite`,
      port: 3210,
      running: "running",
    });
  });

  it("falls back to the task XML on Windows when the copy is gone", async () => {
    const plan = planFor("win32", WINDOWS_HOME, WINDOWS_ROOT);
    const runner = fakeRunner({ [POWERSHELL]: taskReply({ state: 3, xml: plan.files[0]!.contents }) });
    const result = found(
      await detectLegacyService({
        platform: "win32",
        homeDirectory: WINDOWS_HOME,
        environment: WINDOWS_ENVIRONMENT,
        runCommand: runner.runCommand,
        ...virtualFiles({}),
      }),
    );
    expect(result).toMatchObject({
      definitionPath: "\\Work Intelligence",
      definitionSource: "task-query",
      recognised: true,
      repositoryRoot: WINDOWS_ROOT,
      databasePath: `${WINDOWS_ROOT}\\data\\work-intelligence.sqlite`,
      running: "stopped",
    });
  });

  it("decodes the UTF-16LE file with a BOM that the installer writes, and plain UTF-8", () => {
    const plan = planFor("win32", WINDOWS_HOME, WINDOWS_ROOT);
    const written = Buffer.from(String.fromCharCode(0xfeff) + plan.files[0]!.contents, "utf16le");
    expect(decodeLegacyDefinition(written)).toBe(plan.files[0]!.contents);
    expect(decodeLegacyDefinition(Buffer.from("ünï", "utf8"))).toBe("ünï");
  });
});

describe("detectLegacyService: database and port", () => {
  async function detectWithDatabase(database: string) {
    const home = tempHome();
    const plan = planFor("linux", home, POSIX_ROOT, { WORK_INTELLIGENCE_DB: database });
    const path = legacyServiceDefinitionPath({ platform: "linux", homeDirectory: home, environment: {} });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, plan.files[0]!.contents);
    return found(
      await detectLegacyService({ platform: "linux", homeDirectory: home, environment: {}, ...fakeRunner() }),
    );
  }

  it("keeps an absolute database", async () => {
    expect((await detectWithDatabase("/data/Ünï/wi.sqlite")).databasePath).toBe("/data/Ünï/wi.sqlite");
  });

  it("resolves a relative WORK_INTELLIGENCE_DB at install time against the checkout", async () => {
    expect((await detectWithDatabase("db/other.sqlite")).databasePath).toBe(`${POSIX_ROOT}/db/other.sqlite`);
  });

  it("resolves a hand-edited relative database argument against the checkout", async () => {
    const home = tempHome();
    const plan = planFor("darwin", home, POSIX_ROOT);
    const edited = plan.files[0]!.contents.replace(plan.databasePath.replaceAll("'", "&apos;"), "rel/edited.sqlite");
    const path = legacyServiceDefinitionPath({ platform: "darwin", homeDirectory: home, environment: {} });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, edited);
    const result = found(
      await detectLegacyService({ platform: "darwin", homeDirectory: home, environment: {}, ...fakeRunner() }),
    );
    expect(result.databasePath).toBe(`${POSIX_ROOT}/rel/edited.sqlite`);
  });

  it("uses the port a definition names, otherwise the default 3210", async () => {
    const home = tempHome();
    const plan = planFor("darwin", home, POSIX_ROOT);
    const withPort = plan.files[0]!.contents.replace(
      "  <key>RunAtLoad</key>",
      "  <key>EnvironmentVariables</key>\n  <dict>\n    <key>WORK_INTELLIGENCE_PORT</key>\n    <string>4321</string>\n  </dict>\n  <key>RunAtLoad</key>",
    );
    const path = legacyServiceDefinitionPath({ platform: "darwin", homeDirectory: home, environment: {} });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, withPort);
    const result = found(
      await detectLegacyService({ platform: "darwin", homeDirectory: home, environment: {}, ...fakeRunner() }),
    );
    expect(result.port).toBe(4321);
  });
});

describe("detectLegacyService: unrecognised definitions", () => {
  it("reports found but not recognised for foreign content under the service name", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      const home = tempHome();
      const path = legacyServiceDefinitionPath({ platform, homeDirectory: home, environment: {} });
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "[Service]\nExecStart=/usr/bin/other-thing\n");
      const result = found(
        await detectLegacyService({ platform, homeDirectory: home, environment: {}, ...fakeRunner() }),
      );
      expect(result.recognised).toBe(false);
      expect(result.repositoryRoot).toBeUndefined();
      expect(result.databasePath).toBeUndefined();
    }
  });

  it("rejects an installer file whose runner path does not match its checkout", async () => {
    const home = tempHome();
    const plan = planFor("linux", home, POSIX_ROOT);
    const path = plan.files[0]!.path;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, plan.files[0]!.contents.replace("scripts/service-runner.mjs", "scripts/evil.mjs"));
    const result = found(
      await detectLegacyService({ platform: "linux", homeDirectory: home, environment: {}, ...fakeRunner() }),
    );
    expect(result.recognised).toBe(false);
  });

  it("rejects a Windows task with a different URI", async () => {
    const plan = planFor("win32", WINDOWS_HOME, WINDOWS_ROOT);
    const file = plan.files[0]!;
    const result = found(
      await detectLegacyService({
        platform: "win32",
        homeDirectory: WINDOWS_HOME,
        environment: WINDOWS_ENVIRONMENT,
        runCommand: fakeRunner().runCommand,
        ...virtualFiles({ [file.path]: file.contents.replace("<URI>\\Work Intelligence", "<URI>\\Other") }),
      }),
    );
    expect(result.recognised).toBe(false);
  });

  it("does not follow a symlink, reports it as unrecognised, and never reads it", async () => {
    const home = tempHome();
    const target = join(home, "elsewhere.plist");
    const plan = planFor("darwin", home, POSIX_ROOT);
    writeFileSync(target, plan.files[0]!.contents);
    const path = plan.files[0]!.path;
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target, path);
    let reads = 0;
    const result = found(
      await detectLegacyService({
        platform: "darwin",
        homeDirectory: home,
        environment: {},
        readTextFile: () => {
          reads += 1;
          return Promise.resolve("");
        },
        ...fakeRunner(),
      }),
    );
    expect(result).toMatchObject({ definitionPath: path, recognised: false });
    expect(reads).toBe(0);
  });

  it("treats a directory or an oversized file at the definition path as unrecognised", async () => {
    const plan = planFor("win32", WINDOWS_HOME, WINDOWS_ROOT);
    const file = plan.files[0]!;
    for (const stat of [
      { isSymbolicLink: false, isFile: false, size: 0 },
      { isSymbolicLink: false, isFile: true, size: 10_000_000 },
    ]) {
      const result = found(
        await detectLegacyService({
          platform: "win32",
          homeDirectory: WINDOWS_HOME,
          environment: WINDOWS_ENVIRONMENT,
          runCommand: fakeRunner().runCommand,
          ...virtualFiles({ [file.path]: stat }),
        }),
      );
      expect(result.recognised).toBe(false);
    }
  });
});

describe("detectLegacyService: running status", () => {
  async function runningOn(platform: "darwin" | "linux", reply: Reply, timeoutMs?: number) {
    const home = tempHome();
    installPosix(platform, home);
    const command = platform === "darwin" ? "/bin/launchctl" : "systemctl";
    return found(
      await detectLegacyService({
        platform,
        homeDirectory: home,
        environment: {},
        timeoutMs,
        ...fakeRunner({ [command]: reply }),
      }),
    ).running;
  }

  it("maps launchctl and systemctl results", async () => {
    expect(await runningOn("darwin", { stdout: "state = not running", code: 0 })).toBe("stopped");
    expect(await runningOn("darwin", { stdout: "", code: 1 })).toBe("unknown");
    const unit = (ActiveState: string) => systemdReply({ LoadState: "loaded", ActiveState });
    expect(await runningOn("linux", unit("active"))).toBe("running");
    expect(await runningOn("linux", unit("failed"))).toBe("stopped");
    expect(await runningOn("linux", unit("inactive"))).toBe("stopped");
    expect(await runningOn("linux", { stdout: "", code: 1 })).toBe("unknown");
    expect(await runningOn("linux", unit("activating"))).toBe("unknown");
  });

  it("maps a hung command to unknown within the deadline", async () => {
    const started = Date.now();
    expect(await runningOn("linux", "hang", 80)).toBe("unknown");
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("maps a rejected command to unknown", async () => {
    const home = tempHome();
    installPosix("linux", home);
    const result = found(
      await detectLegacyService({
        platform: "linux",
        homeDirectory: home,
        environment: {},
        runCommand: () => Promise.reject(new Error("spawn systemctl ENOENT")),
      }),
    );
    expect(result).toMatchObject({ recognised: true, running: "unknown" });
  });

  it("reads the Windows state from numbers, so the system language does not matter", async () => {
    const plan = planFor("win32", WINDOWS_HOME, WINDOWS_ROOT);
    const file = plan.files[0]!;
    const stateOf = async (reply: LegacyServiceCommandResult) =>
      found(
        await detectLegacyService({
          platform: "win32",
          homeDirectory: WINDOWS_HOME,
          environment: WINDOWS_ENVIRONMENT,
          runCommand: fakeRunner({ [POWERSHELL]: reply }).runCommand,
          ...virtualFiles({ [file.path]: file.contents }),
        }),
      ).running;
    // The same JSON comes back on a zh-TW Windows: nothing in it is a translated word.
    expect(await stateOf(taskReply({ state: 4 }))).toBe("running");
    expect(await stateOf(taskReply({ state: 3 }))).toBe("stopped");
    expect(await stateOf(taskReply({ state: 2 }))).toBe("stopped");
    expect(await stateOf(taskReply({ state: 1 }))).toBe("stopped");
    expect(await stateOf(taskReply({ state: 0 }))).toBe("unknown");
    for (const stdout of ["garbage", "", "[]", "null", '{"state":"Running"}']) {
      expect(await stateOf({ stdout, code: 0 })).toBe("unknown");
    }
    expect(await stateOf({ stdout: taskReply({ state: 4 }).stdout, code: 1 })).toBe("unknown");
  });

  it("keeps the whole Windows detection inside the deadline when schtasks hangs", async () => {
    const started = Date.now();
    const result = await detectLegacyService({
      platform: "win32",
      homeDirectory: WINDOWS_HOME,
      environment: WINDOWS_ENVIRONMENT,
      runCommand: fakeRunner({ [POWERSHELL]: "hang" }).runCommand,
      timeoutMs: 80,
      ...virtualFiles({}),
    });
    // No answer is not "nothing": an old task registered without a definition file cannot be ruled out.
    expect(result).toEqual({ kind: "unknown" });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("reports unknown on Windows when the task query fails or answers with something unreadable, without a file", async () => {
    for (const reply of [
      { stdout: "", code: 1 },
      { stdout: "garbage", code: 0 },
    ]) {
      const result = await detectLegacyService({
        platform: "win32",
        homeDirectory: WINDOWS_HOME,
        environment: WINDOWS_ENVIRONMENT,
        runCommand: fakeRunner({ [POWERSHELL]: reply }).runCommand,
        ...virtualFiles({}),
      });
      expect(result).toEqual({ kind: "unknown" });
    }
  });
});

describe("detectLegacyService: starts at login", () => {
  async function onPosix(platform: "darwin" | "linux", reply: Reply, edit?: (contents: string) => string) {
    const home = tempHome();
    const path = installPosix(platform, home);
    if (edit) writeFileSync(path, edit(readFileSync(path, "utf8")));
    return detectLegacyService({
      platform,
      homeDirectory: home,
      environment: {},
      uid: 501,
      ...fakeRunner({ [platform === "darwin" ? "/bin/launchctl" : "systemctl"]: reply }),
    });
  }

  async function onWindows(reply: LegacyServiceCommandResult) {
    const file = planFor("win32", WINDOWS_HOME, WINDOWS_ROOT).files[0]!;
    return detectLegacyService({
      platform: "win32",
      homeDirectory: WINDOWS_HOME,
      environment: WINDOWS_ENVIRONMENT,
      runCommand: fakeRunner({ [POWERSHELL]: reply }).runCommand,
      ...virtualFiles({ [file.path]: file.contents }),
    });
  }

  it("macOS: a loaded agent that is not running but has RunAtLoad starts at login", async () => {
    const result = found(await onPosix("darwin", { stdout: "state = not running", code: 0 }));
    expect(result).toMatchObject({ running: "stopped", enabled: "enabled" });
  });

  it("macOS: a loaded agent without RunAtLoad does not start at login, and the print output can say it too", async () => {
    const withoutRunAtLoad = (contents: string) =>
      contents.replace("<key>RunAtLoad</key>\n  <true/>", "<key>RunAtLoad</key>\n  <false/>");
    const result = found(await onPosix("darwin", { stdout: "state = not running", code: 0 }, withoutRunAtLoad));
    expect(result.enabled).toBe("disabled");
    const unreadable = found(
      await onPosix("darwin", { stdout: "state = waiting\n\tproperties = runatload", code: 0 }, () => "<plist/>"),
    );
    expect(unreadable).toMatchObject({ recognised: false, enabled: "enabled" });
    const unknown = found(await onPosix("darwin", { stdout: "state = waiting", code: 0 }, () => "<plist/>"));
    expect(unknown.enabled).toBe("unknown");
  });

  it("macOS: launchctl that does not know the label means a stale plist, so nothing is found", async () => {
    expect(await onPosix("darwin", { stdout: "", code: 113 })).toEqual({ kind: "none" });
    // Any other failure is not proof that the service is gone.
    expect(found(await onPosix("darwin", { stdout: "", code: 1 }))).toMatchObject({ running: "unknown" });
    expect(found(await onPosix("darwin", { stdout: "", code: 1 })).enabled).toBeUndefined();
  });

  it("Linux: systemd's unit file state tells whether it starts at login", async () => {
    const stateOf = async (UnitFileState: string | undefined) =>
      found(await onPosix("linux", systemdReply({ LoadState: "loaded", ActiveState: "inactive", UnitFileState })))
        .enabled;
    expect(await stateOf("enabled")).toBe("enabled");
    expect(await stateOf("enabled-runtime")).toBe("enabled");
    expect(await stateOf("disabled")).toBe("disabled");
    expect(await stateOf("masked")).toBe("disabled");
    expect(await stateOf("static")).toBe("disabled");
    expect(await stateOf(undefined)).toBe("unknown");
  });

  it("Linux: a unit systemd does not know is a stale definition, so nothing is found", async () => {
    expect(await onPosix("linux", systemdReply({ LoadState: "not-found", ActiveState: "inactive" }))).toEqual({
      kind: "none",
    });
    // No LoadState at all (no user bus, systemctl missing) proves nothing.
    expect(found(await onPosix("linux", { stdout: "", code: 1 }))).toMatchObject({ running: "unknown" });
  });

  it("Windows: an enabled task with an enabled logon trigger starts at login", async () => {
    expect(found(await onWindows(taskReply({ state: 3 })))).toMatchObject({ running: "stopped", enabled: "enabled" });
  });

  it("Windows: a disabled task, a disabled task setting, or no logon trigger does not start at login", async () => {
    expect(found(await onWindows(taskReply({ state: 1, enabled: false }))).enabled).toBe("disabled");
    expect(found(await onWindows(taskReply({ state: 3, enabled: false }))).enabled).toBe("disabled");
    expect(found(await onWindows(taskReply({ state: 3, logon: false }))).enabled).toBe("disabled");
    expect(found(await onWindows({ stdout: '{"state":3}', code: 0 })).enabled).toBe("unknown");
  });

  it("Windows: a task the scheduler does not know is a stale XML copy, so nothing is found", async () => {
    expect(await onWindows(taskReply("absent"))).toEqual({ kind: "none" });
    // A failed query proves nothing.
    expect(found(await onWindows({ stdout: "", code: 1 }))).toMatchObject({ running: "unknown" });
  });

  it("Windows: the task XML comes back through PowerShell as UTF-8, so a non-ASCII user name stays intact", async () => {
    const xml = planFor("win32", WINDOWS_HOME, WINDOWS_ROOT).files[0]!.contents;
    const result = found(
      await detectLegacyService({
        platform: "win32",
        homeDirectory: WINDOWS_HOME,
        environment: WINDOWS_ENVIRONMENT,
        runCommand: fakeRunner({ [POWERSHELL]: taskReply({ state: 3, xml }) }).runCommand,
        ...virtualFiles({}),
      }),
    );
    expect(result.databasePath).toBe("C:\\Users\\Ünï Üser\\Work Log 專案 & co\\data\\work-intelligence.sqlite");
  });

  it("Windows: a task query without usable XML and without a copy finds nothing", async () => {
    const result = await detectLegacyService({
      platform: "win32",
      homeDirectory: WINDOWS_HOME,
      environment: WINDOWS_ENVIRONMENT,
      runCommand: fakeRunner({ [POWERSHELL]: taskReply({ state: 3 }) }).runCommand,
      ...virtualFiles({}),
    });
    expect(result).toEqual({ kind: "none" });
  });
});

describe("the default command runner", () => {
  const node = process.execPath;

  it("returns stdout and code 0 for a command that succeeds", async () => {
    expect(await createLegacyCommandRunner(5000)(node, ["-e", "process.stdout.write('active\\n')"])).toEqual({
      stdout: "active\n",
      code: 0,
    });
  });

  it("keeps stdout and the exit code of a command that fails", async () => {
    expect(
      await createLegacyCommandRunner(5000)(node, ["-e", "process.stdout.write('inactive'); process.exit(3)"]),
    ).toEqual({ stdout: "inactive", code: 3 });
  });

  it("drops the output of a command killed at the deadline and reports -1", async () => {
    expect(
      await createLegacyCommandRunner(100)(node, [
        "-e",
        "process.stdout.write('partial'); setInterval(() => {}, 1000)",
      ]),
    ).toEqual({ stdout: "", code: -1 });
  });

  it("reports code 1 when the command cannot be started", async () => {
    const result = await createLegacyCommandRunner(5000)(join(tempHome(), "no-such-tool"), []);
    expect(result.code).toBe(1);
  });
});

describe("detectLegacyService: the default file readers", () => {
  it("reads a real definition through lstat and the UTF-8/UTF-16 decoder", async () => {
    const home = tempHome();
    installPosix("linux", home);
    const result = found(
      await detectLegacyService({ platform: "linux", homeDirectory: home, environment: {}, ...fakeRunner() }),
    );
    expect(result).toMatchObject({ recognised: true, repositoryRoot: POSIX_ROOT });
  });

  it("treats an lstat that throws as present but unrecognised", async () => {
    const result = found(
      await detectLegacyService({
        platform: "linux",
        homeDirectory: tempHome(),
        environment: {},
        lstatFile: () => {
          throw new Error("EACCES");
        },
        ...fakeRunner(),
      }),
    );
    expect(result).toMatchObject({ recognised: false, running: "unknown" });
  });

  it("does no work with a zero budget and swallows what was started", async () => {
    const runner = fakeRunner();
    const result = found(
      await detectLegacyService({
        platform: "linux",
        homeDirectory: tempHome(),
        environment: {},
        timeoutMs: 0,
        lstatFile: () => Promise.reject(new Error("too late")),
        runCommand: (command, args) => {
          void runner.runCommand(command, args);
          return Promise.reject(new Error("too late"));
        },
      }),
    );
    expect(result).toMatchObject({ recognised: false, running: "unknown" });
  });
});
