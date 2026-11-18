import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { repairInputSchemas } from "../../packages/desktop-core/src/shell/repair-ipc.js";
import {
  canDisableLegacyService,
  countLegacyRunners,
  describeLegacyDisableSteps,
  detectLegacyBusy,
  executeLegacyDisable,
  legacyDefinitionDigest,
  legacyDisableFileSystem,
  legacyProcessIsAlive,
  matchesLegacyRunner,
  legacyRunnerTrees,
  parseWindowsProcesses,
  planLegacyDisable,
  type LegacyDisableDependencies,
  type LegacyDisablePlan,
  type LegacyDisableStepText,
  type LegacyServiceDetection,
  type LegacyServiceFound,
  type WindowsProcessEntry,
} from "../../packages/desktop-core/src/legacy-service/index.js";

const directories: string[] = [];
const DEFINITION = "<plist>synthetic definition</plist>\n";
const WINDOWS_ROOT = "C:\\Users\\Ünï\\Work Log 專案";
const WINDOWS_ENVIRONMENT = { SystemRoot: "C:\\Windows" };
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const TASKKILL = "C:\\Windows\\System32\\taskkill.exe";
const SCHTASKS = "C:\\Windows\\System32\\schtasks.exe";

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "wi-legacy-disable-"));
  directories.push(directory);
  return directory;
}

function found(overrides: Partial<LegacyServiceFound> = {}): LegacyServiceFound {
  return {
    kind: "found",
    platform: "linux",
    definitionPath: "/home/synthetic/.config/systemd/user/work-intelligence.service",
    definitionSource: "file",
    recognised: true,
    repositoryRoot: "/srv/synthetic-checkout",
    databasePath: "/srv/synthetic-checkout/data/work-intelligence.sqlite",
    port: 43210,
    running: "running",
    enabled: "enabled",
    definitionDigest: legacyDefinitionDigest(DEFINITION),
    ...overrides,
  };
}

interface Harness {
  readonly dependencies: LegacyDisableDependencies;
  readonly calls: string[];
  readonly files: Map<string, string>;
}

/** Fake OS: records every command, serves the definition from memory, frees the port after `busyPolls` checks. */
function harness(options: {
  detections: LegacyServiceDetection[];
  files?: Record<string, string>;
  busyPolls?: number;
  processes?: WindowsProcessEntry[];
  listCode?: number;
  alive?: Set<number>;
  failing?: Record<string, number>;
  /** `launchctl print` / `systemctl is-enabled` still succeed after the stop: the service is still loaded or enabled. */
  stillLoaded?: boolean;
}): Harness {
  const calls: string[] = [];
  const files = new Map(Object.entries(options.files ?? {}));
  const detections = [...options.detections];
  let polls = 0;
  let clock = 0;
  const alive = options.alive ?? new Set<number>();
  return {
    calls,
    files,
    dependencies: {
      environment: WINDOWS_ENVIRONMENT,
      stopWaitMs: 2000,
      runCommand: async (command, args) => {
        calls.push([command, ...args].join(" "));
        if (command === POWERSHELL) {
          const payload = Buffer.from(JSON.stringify(options.processes ?? []), "utf8").toString("base64");
          return { stdout: payload, code: options.listCode ?? 0 };
        }
        // taskkill /T: the process and every descendant of it.
        if (command === TASKKILL) {
          const tree = legacyRunnerTrees(
            (options.processes ?? []).map((entry) =>
              entry.pid === Number(args[1]) ? { ...entry, name: "node.exe", commandLine: "KILL-ROOT" } : entry,
            ),
            "KILL-ROOT",
          );
          for (const pid of tree.members) alive.delete(pid);
        }
        if (args[0] === "print" || args.includes("is-enabled")) {
          return { stdout: "", code: options.stillLoaded ? 0 : 113 };
        }
        const key = `${command} ${args[0] ?? ""}`.trim();
        return { stdout: "", code: options.failing?.[key] ?? 0 };
      },
      detect: async () => detections.shift() ?? { kind: "none" },
      isPortFree: async () => {
        polls += 1;
        return polls > (options.busyPolls ?? 0);
      },
      isProcessAlive: (pid) => alive.has(pid),
      readDefinition: async (file) => {
        const text = files.get(file);
        if (text === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return Buffer.from(text, "utf8");
      },
      lstat: async (file) => (files.has(file) ? { isFile: true, isSymbolicLink: false } : null),
      unlink: async (file) => {
        calls.push(`unlink ${file}`);
        files.delete(file);
      },
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      now: () => clock,
    },
  };
}

function plan(detection: LegacyServiceFound): LegacyDisablePlan {
  const result = planLegacyDisable(detection, { uid: 501, environment: WINDOWS_ENVIRONMENT });
  if (!result) throw new Error("expected a plan");
  return result;
}

/** Each step's sentence is a marker here, so the test pins which step maps to which sentence, not the wording. */
const STEP_TEXT: LegacyDisableStepText = {
  stopTask: "stop-task:{name}",
  removeTask: "remove-task:{name}",
  endRunners: "end",
  stopService: "stop:{name}",
  checkStopped: "check",
  refreshService: "refresh",
  deleteFile: "delete:{path}",
  other: "other",
};

describe("planLegacyDisable", () => {
  it("never plans for an unrecognised definition, an unknown checkout or a missing digest", () => {
    expect(planLegacyDisable({ kind: "none" })).toBeNull();
    expect(planLegacyDisable(found({ recognised: false }))).toBeNull();
    expect(planLegacyDisable(found({ repositoryRoot: undefined }))).toBeNull();
    expect(planLegacyDisable(found({ definitionDigest: undefined }))).toBeNull();
  });

  it("follows pnpm service:uninstall on each platform, with fixed names only", () => {
    expect(
      describeLegacyDisableSteps(plan(found({ platform: "darwin", definitionPath: "/p/ai.plist" })), STEP_TEXT),
    ).toEqual(["stop:ai.workintelligence.server", "check", "delete:/p/ai.plist"]);
    expect(describeLegacyDisableSteps(plan(found()), STEP_TEXT)).toEqual([
      "stop:work-intelligence.service",
      "check",
      "delete:/home/synthetic/.config/systemd/user/work-intelligence.service",
      "refresh",
    ]);
    const windows = plan(
      found({ platform: "win32", repositoryRoot: WINDOWS_ROOT, definitionPath: "C:\\data\\task.xml" }),
    );
    expect(windows.hardStop).toBe(true);
    expect(windows.steps.map((step) => step.kind)).toEqual(["command", "end-runners", "command", "remove-definition"]);
    expect(windows.steps[1]).toMatchObject({ runnerPath: `${WINDOWS_ROOT}\\scripts\\service-runner.mjs` });
    expect(windows.steps[0]).toMatchObject({
      run: { command: SCHTASKS, args: ["/End", "/TN", "\\Work Intelligence"] },
    });
    expect(describeLegacyDisableSteps(windows, STEP_TEXT)).toEqual([
      "stop-task:Work Intelligence",
      "end",
      "remove-task:Work Intelligence",
      "delete:C:\\data\\task.xml",
    ]);
  });

  it("does not remove a file for a task found only through the task query", () => {
    const windows = plan(
      found({
        platform: "win32",
        repositoryRoot: WINDOWS_ROOT,
        definitionSource: "task-query",
        definitionPath: "\\Work Intelligence",
      }),
    );
    expect(windows.steps.some((step) => step.kind === "remove-definition")).toBe(false);
  });
});

describe("matchesLegacyRunner", () => {
  const runner = `${WINDOWS_ROOT}\\scripts\\service-runner.mjs`;

  it.each([
    `"C:\\Program Files\\nodejs\\node.exe" "${runner}" C:\\db.sqlite`,
    `node.exe ${runner.toUpperCase()}`,
    `node.exe "${runner.replaceAll("\\", "/")}"`,
    `node.exe "${runner.replaceAll("\\", "\\\\")}"`,
  ])("matches this checkout's runner: %s", (commandLine) => {
    expect(matchesLegacyRunner(commandLine, runner)).toBe(true);
  });

  it.each([
    `node.exe "D:\\copy\\${runner}"`,
    `node.exe "${WINDOWS_ROOT} 2\\scripts\\service-runner.mjs"`,
    `node.exe "${runner}.bak"`,
    `node.exe "C:\\other\\scripts\\service-runner.mjs"`,
    "node.exe server.js --port 43210",
  ])("does not match any other process: %s", (commandLine) => {
    expect(matchesLegacyRunner(commandLine, runner)).toBe(false);
  });
});

describe("parseWindowsProcesses", () => {
  it("reads a list or a single object and drops malformed entries", () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");
    expect(
      parseWindowsProcesses(encode([{ pid: 4, parentPid: 1, name: "node.exe", commandLine: "a" }, { pid: "x" }])),
    ).toEqual([{ pid: 4, parentPid: 1, name: "node.exe", commandLine: "a" }]);
    // A system process has no command line: it is kept (it may be a descendant) with an empty one.
    expect(parseWindowsProcesses(encode({ pid: 7, parentPid: 4, name: "conhost.exe", commandLine: null }))).toEqual([
      { pid: 7, parentPid: 4, name: "conhost.exe", commandLine: "" },
    ]);
    expect(parseWindowsProcesses("not base64 json")).toBeNull();
  });
});

describe("legacyRunnerTrees (DT-13)", () => {
  const runner = `${WINDOWS_ROOT}\\scripts\\service-runner.mjs`;
  const node = (pid: number, parentPid: number, commandLine: string): WindowsProcessEntry => ({
    pid,
    parentPid,
    name: "node.exe",
    commandLine,
  });

  it("finds this checkout's runner and all its descendants, and nothing else", () => {
    const processes = [
      { pid: 4, parentPid: 0, name: "System", commandLine: "" },
      node(41, 900, `node.exe "${runner}"`),
      { pid: 44, parentPid: 41, name: "conhost.exe", commandLine: "" },
      { pid: 50, parentPid: 41, name: "cmd.exe", commandLine: "pnpm start" },
      node(51, 50, "node.exe apps/server/dist/start-api.js"),
      node(52, 51, "node.exe worker.js"),
      node(60, 900, `node.exe "C:\\other\\scripts\\service-runner.mjs"`),
      node(61, 60, "node.exe apps/server/dist/start-api.js"),
      // A runner path in a process that is not node.exe is not a runner.
      { pid: 70, parentPid: 900, name: "notepad.exe", commandLine: `notepad "${runner}"` },
    ];
    const trees = legacyRunnerTrees(processes, runner);
    expect(trees.roots).toEqual([41]);
    expect([...trees.members].sort((a, b) => a - b)).toEqual([41, 44, 50, 51, 52]);
  });

  it("survives a parent loop", () => {
    const trees = legacyRunnerTrees([node(41, 42, `node.exe "${runner}"`), node(42, 41, "node.exe x")], runner);
    expect([...trees.members].sort()).toEqual([41, 42]);
  });
});

describe("executeLegacyDisable", () => {
  const linux = found();
  const definition = { [linux.definitionPath]: DEFINITION };

  it("stops, waits for the port, removes, and verifies on Linux", async () => {
    const { dependencies, calls, files } = harness({
      detections: [linux, { kind: "none" }],
      files: definition,
      busyPolls: 3,
    });
    expect(await executeLegacyDisable(plan(linux), dependencies)).toEqual({ outcome: "disabled", endedProcesses: 0 });
    expect(calls).toEqual([
      "systemctl --user disable --now work-intelligence.service",
      "systemctl --user is-enabled work-intelligence.service",
      `unlink ${linux.definitionPath}`,
      "systemctl --user daemon-reload",
    ]);
    expect(files.size).toBe(0);
  });

  it("removes nothing while the unit is still enabled after a failed disable", async () => {
    const { dependencies, calls, files } = harness({
      detections: [linux],
      files: definition,
      failing: { "systemctl --user": 1 },
      stillLoaded: true,
    });
    expect(await executeLegacyDisable(plan(linux), dependencies)).toEqual({
      outcome: "failed",
      step: "systemctl --user",
      detail: "the old service is still loaded or enabled",
      removed: false,
      stopAttempted: true,
    });
    expect(calls.some((call) => call.startsWith("unlink") || call.includes("daemon-reload"))).toBe(false);
    expect(files.size).toBe(1);
  });

  it("removes nothing on macOS while launchd still holds the job after a failed bootout", async () => {
    const mac = found({ platform: "darwin", definitionPath: "/p/ai.plist" });
    const { dependencies, calls, files } = harness({
      detections: [mac],
      files: { "/p/ai.plist": DEFINITION },
      failing: { "launchctl bootout": 5 },
      stillLoaded: true,
    });
    expect(await executeLegacyDisable(plan(mac), dependencies)).toMatchObject({
      outcome: "failed",
      step: "launchctl print",
      removed: false,
      stopAttempted: true,
    });
    expect(calls).toEqual([
      "launchctl bootout gui/501/ai.workintelligence.server",
      "launchctl print gui/501/ai.workintelligence.server",
    ]);
    expect(files.size).toBe(1);
  });

  it("treats a verification command that cannot run as not loaded", async () => {
    const { dependencies, files } = harness({ detections: [linux, { kind: "none" }], files: definition });
    const throwing: LegacyDisableDependencies = {
      ...dependencies,
      runCommand: async (command, args) => {
        if (args.includes("is-enabled")) throw new Error("spawn failed");
        return dependencies.runCommand(command, args);
      },
    };
    expect(await executeLegacyDisable(plan(linux), throwing)).toEqual({ outcome: "disabled", endedProcesses: 0 });
    expect(files.size).toBe(0);
  });

  it("goes on on macOS when bootout fails only because the job was not loaded", async () => {
    const mac = found({ platform: "darwin", definitionPath: "/p/ai.plist" });
    const { dependencies, files } = harness({
      detections: [mac, { kind: "none" }],
      files: { "/p/ai.plist": DEFINITION },
      failing: { "launchctl bootout": 5 },
    });
    expect(await executeLegacyDisable(plan(mac), dependencies)).toEqual({ outcome: "disabled", endedProcesses: 0 });
    expect(files.size).toBe(0);
  });

  it.each([
    ["is gone", { kind: "none" } as const],
    ["was edited", found({ definitionDigest: legacyDefinitionDigest("edited") })],
    ["is no longer recognised", found({ recognised: false })],
    ["points at another checkout", found({ repositoryRoot: "/srv/other" })],
  ])("does nothing when the definition %s since the preview", async (_name, now) => {
    const { dependencies, calls, files } = harness({ detections: [now], files: definition });
    expect(await executeLegacyDisable(plan(linux), dependencies)).toEqual({ outcome: "changed" });
    expect(calls).toEqual([]);
    expect(files.size).toBe(1);
  });

  it("removes nothing while the old backend still holds the port", async () => {
    const { dependencies, calls, files } = harness({ detections: [linux], files: definition, busyPolls: 1_000 });
    expect(await executeLegacyDisable(plan(linux), dependencies)).toEqual({ outcome: "still-running", port: 43210 });
    expect(calls).toEqual([
      "systemctl --user disable --now work-intelligence.service",
      "systemctl --user is-enabled work-intelligence.service",
    ]);
    expect(files.size).toBe(1);
  });

  it("refuses to unlink a definition that changed after the recheck", async () => {
    const { dependencies, calls } = harness({
      detections: [linux],
      files: { [linux.definitionPath]: "swapped in between" },
    });
    expect(await executeLegacyDisable(plan(linux), dependencies)).toMatchObject({
      outcome: "failed",
      step: "remove-definition",
      removed: false,
      stopAttempted: true,
    });
    expect(calls.some((call) => call.startsWith("unlink"))).toBe(false);
  });

  it("reports a registration that is still there afterwards", async () => {
    const { dependencies } = harness({ detections: [linux, linux], files: definition });
    expect(await executeLegacyDisable(plan(linux), dependencies)).toMatchObject({ outcome: "failed", step: "verify" });
  });

  describe("on Windows", () => {
    const xml = "C:\\Users\\Ünï\\AppData\\Local\\Work Intelligence\\service\\work-intelligence.task.xml";
    const windows = found({ platform: "win32", repositoryRoot: WINDOWS_ROOT, definitionPath: xml });
    const runner = `${WINDOWS_ROOT}\\scripts\\service-runner.mjs`;
    const entry = (pid: number, parentPid: number, commandLine: string, name = "node.exe"): WindowsProcessEntry => ({
      pid,
      parentPid,
      name,
      commandLine,
    });
    const processes = [
      entry(41, 900, `"C:\\nodejs\\node.exe" "${runner}" db`),
      entry(45, 41, "pnpm start", "cmd.exe"),
      entry(46, 45, "node.exe apps/server/dist/start-api.js"),
      entry(42, 900, `"C:\\nodejs\\node.exe" "C:\\other\\scripts\\service-runner.mjs" db`),
      entry(43, 900, "node.exe vite --port 43210"),
    ];

    it("ends only this checkout's runner trees, waits for them, then deletes the task", async () => {
      const { dependencies, calls, files } = harness({
        detections: [windows, { kind: "none" }],
        files: { [xml]: DEFINITION },
        processes,
        alive: new Set([41, 42, 43, 45, 46]),
      });
      expect(await executeLegacyDisable(plan(windows), dependencies)).toEqual({
        outcome: "disabled",
        endedProcesses: 3,
      });
      expect(calls.filter((call) => !call.startsWith(POWERSHELL))).toEqual([
        `${SCHTASKS} /End /TN \\Work Intelligence`,
        `${TASKKILL} /PID 41 /T /F`,
        `${SCHTASKS} /Delete /TN \\Work Intelligence /F`,
        `unlink ${xml}`,
      ]);
      expect(files.size).toBe(0);
    });

    it("waits for every descendant of the runner, not only the runner (DT-13)", async () => {
      const { dependencies, calls } = harness({
        detections: [windows],
        files: { [xml]: DEFINITION },
        processes,
        alive: new Set([41, 45, 46]),
      });
      // The old server outlives its runner: the port may already be free, the tree is not gone.
      const lingering: LegacyDisableDependencies = {
        ...dependencies,
        isProcessAlive: (pid) => pid === 46 || dependencies.isProcessAlive(pid),
      };
      expect(await executeLegacyDisable(plan(windows), lingering)).toEqual({ outcome: "still-running", port: 43210 });
      expect(calls.filter((call) => call.startsWith(TASKKILL))).toEqual([`${TASKKILL} /PID 41 /T /F`]);
      expect(calls.some((call) => call.includes("/Delete"))).toBe(false);
    });

    it("keeps the task when the process list cannot be read", async () => {
      const { dependencies, calls } = harness({ detections: [windows], files: { [xml]: DEFINITION }, listCode: 1 });
      expect(await executeLegacyDisable(plan(windows), dependencies)).toMatchObject({
        outcome: "failed",
        step: "list-runners",
        removed: false,
      });
      expect(calls.some((call) => call.includes("/Delete"))).toBe(false);
    });

    it("goes on when taskkill cannot run because the runner already exited", async () => {
      const { dependencies, files } = harness({
        detections: [windows, { kind: "none" }],
        files: { [xml]: DEFINITION },
        processes,
      });
      const exited: LegacyDisableDependencies = {
        ...dependencies,
        runCommand: async (command, args) => {
          if (command === TASKKILL) throw new Error("no such process");
          return dependencies.runCommand(command, args);
        },
      };
      expect(await executeLegacyDisable(plan(windows), exited)).toMatchObject({ outcome: "disabled" });
      expect(files.size).toBe(0);
    });

    it("keeps the task while an ended tree is still alive", async () => {
      const { dependencies, calls } = harness({
        detections: [windows],
        files: { [xml]: DEFINITION },
        processes,
        alive: new Set([41]),
      });
      const stubborn: LegacyDisableDependencies = {
        ...dependencies,
        runCommand: async (command, args) =>
          command === TASKKILL ? { stdout: "", code: 128 } : dependencies.runCommand(command, args),
      };
      expect(await executeLegacyDisable(plan(windows), stubborn)).toEqual({ outcome: "still-running", port: 43210 });
      expect(calls.some((call) => call.includes("/Delete"))).toBe(false);
    });

    it("fails without removing the file when schtasks /Delete fails", async () => {
      const { dependencies, files } = harness({
        detections: [windows],
        files: { [xml]: DEFINITION },
        failing: { [`${SCHTASKS} /Delete`]: 1 },
      });
      expect(await executeLegacyDisable(plan(windows), dependencies)).toMatchObject({
        outcome: "failed",
        step: "schtasks.exe /Delete",
        removed: false,
      });
      expect(files.size).toBe(1);
    });
  });

  it("never unlinks through a symbolic link (real file system)", async () => {
    const directory = tempDirectory();
    const target = join(directory, "target.service");
    const link = join(directory, "work-intelligence.service");
    writeFileSync(target, DEFINITION);
    symlinkSync(target, link);
    const detection = found({ definitionPath: link });
    const { dependencies } = harness({ detections: [detection] });
    const real = { ...dependencies, ...legacyDisableFileSystem };
    expect(await executeLegacyDisable(plan(detection), real)).toMatchObject({
      outcome: "failed",
      step: "remove-definition",
    });
    expect(existsSync(link)).toBe(true);
    expect(existsSync(target)).toBe(true);
  });

  it("removes the regular definition file it previewed (real file system)", async () => {
    const file = join(tempDirectory(), "work-intelligence.service");
    writeFileSync(file, DEFINITION);
    const detection = found({ definitionPath: file });
    const { dependencies } = harness({ detections: [detection, { kind: "none" }] });
    const real = { ...dependencies, ...legacyDisableFileSystem };
    expect(await executeLegacyDisable(plan(detection), real)).toEqual({ outcome: "disabled", endedProcesses: 0 });
    expect(existsSync(file)).toBe(false);
  });
});

describe("legacyProcessIsAlive", () => {
  it("tells a live process from an exited one", () => {
    expect(legacyProcessIsAlive(process.pid)).toBe(true);
    const exited = spawnSync(process.execPath, ["-e", ""]);
    expect(legacyProcessIsAlive(exited.pid as number)).toBe(false);
  });
});

describe("detectLegacyBusy", () => {
  function layout() {
    const directory = tempDirectory();
    const database = join(directory, "data", "work-intelligence.sqlite");
    const backups = join(directory, "backups");
    mkdirSync(join(directory, "data"), { recursive: true });
    mkdirSync(backups);
    return { directory, database, backups };
  }

  function importDirectory(database: string, name: string, marker = "work-intelligence transfer directory v1\n") {
    const directory = join(database, "..", ".work-intelligence-transfer", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, ".wi-transfer"), marker);
    return directory;
  }

  it("is quiet with nothing in progress, and when the places cannot be read", async () => {
    const { database, backups } = layout();
    expect(await detectLegacyBusy({ databasePath: database, backupDirectory: backups })).toEqual({
      importRunning: false,
      backupRunning: false,
    });
    expect(await detectLegacyBusy({ databasePath: "/nonexistent/synthetic.sqlite" })).toEqual({
      importRunning: false,
      backupRunning: false,
    });
  });

  it("sees a fresh import with its marker, but not an export, an orphan or a foreign directory", async () => {
    const { database } = layout();
    importDirectory(database, "export-abc123");
    importDirectory(database, "import-zzz999", "something else\n");
    const old = importDirectory(database, "import-old111");
    const hourAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(old, hourAgo, hourAgo);
    expect((await detectLegacyBusy({ databasePath: database })).importRunning).toBe(false);
    importDirectory(database, "import-Ab12Cd");
    expect((await detectLegacyBusy({ databasePath: database })).importRunning).toBe(true);
  });

  it("sees a backup staging directory only while its owner process lives", async () => {
    const { backups } = layout();
    mkdirSync(join(backups, ".wi-4242-12345678-1234-1234-1234-123456789abc.tmp"));
    expect((await detectLegacyBusy({ backupDirectory: backups, isProcessAlive: () => false })).backupRunning).toBe(
      false,
    );
    expect(
      (await detectLegacyBusy({ backupDirectory: backups, isProcessAlive: (pid) => pid === 4242 })).backupRunning,
    ).toBe(true);
  });
});

describe("the page's 停用舊的登入服務 inputs", () => {
  it("accepts only an opaque preview id and a flag, never a path or a command", () => {
    const confirm = repairInputSchemas.legacyDisableConfirm;
    const id = "0b9f6f5e-7c1e-4f3a-9d43-2a6f0d6c9a11";
    expect(confirm.safeParse({ previewId: id }).success).toBe(true);
    expect(confirm.safeParse({ previewId: id, continueWhileBusy: true }).success).toBe(true);
    expect(confirm.safeParse({ previewId: "not-a-uuid" }).success).toBe(false);
    expect(confirm.safeParse({ previewId: id, definitionPath: "/synthetic" }).success).toBe(false);
    expect(repairInputSchemas.legacyDisablePreview.safeParse({ command: "rm" }).success).toBe(false);
    expect(repairInputSchemas.legacyStartNow.safeParse({}).success).toBe(true);
  });

  it("offers the button only for what planLegacyDisable would plan", () => {
    expect(canDisableLegacyService(found())).toBe(true);
    expect(canDisableLegacyService(found({ recognised: false }))).toBe(false);
    expect(canDisableLegacyService({ kind: "none" })).toBe(false);
    expect(canDisableLegacyService(null)).toBe(false);
  });
});

describe("countLegacyRunners", () => {
  const runner = `${WINDOWS_ROOT}\\scripts\\service-runner.mjs`;
  const listing = (entries: WindowsProcessEntry[], code = 0) => ({
    runCommand: async () => ({ stdout: Buffer.from(JSON.stringify(entries), "utf8").toString("base64"), code }),
    environment: WINDOWS_ENVIRONMENT,
  });

  it("counts only this checkout's node.exe runners", async () => {
    const entries: WindowsProcessEntry[] = [
      { pid: 41, parentPid: 1, name: "node.exe", commandLine: `node.exe "${runner}"` },
      { pid: 42, parentPid: 41, name: "node.exe", commandLine: "node.exe apps/server/dist/start-api.js" },
      { pid: 43, parentPid: 1, name: "node.exe", commandLine: 'node.exe "C:\\other\\scripts\\service-runner.mjs"' },
    ];
    expect(await countLegacyRunners(runner, listing(entries))).toBe(1);
    expect(await countLegacyRunners(runner, listing([]))).toBe(0);
  });

  it("is null when the process list cannot be read", async () => {
    expect(await countLegacyRunners(runner, listing([], 1))).toBeNull();
    expect(
      await countLegacyRunners(runner, {
        runCommand: async () => {
          throw new Error("spawn failed");
        },
        environment: WINDOWS_ENVIRONMENT,
      }),
    ).toBeNull();
  });
});
