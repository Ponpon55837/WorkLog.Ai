import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { repairInputSchemas } from "../../packages/desktop-core/src/shell/repair-ipc.js";
import {
  canDisableLegacyService,
  describeLegacyDisableSteps,
  detectLegacyBusy,
  executeLegacyDisable,
  legacyDefinitionDigest,
  legacyDisableFileSystem,
  matchesLegacyRunner,
  parseWindowsNodeProcesses,
  planLegacyDisable,
  type LegacyDisableDependencies,
  type LegacyDisablePlan,
  type LegacyServiceDetection,
  type LegacyServiceFound,
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
    port: 3210,
    running: "running",
    enabled: "enabled",
    definitionDigest: legacyDefinitionDigest(DEFINITION),
    fallbackRemoveCommand: "synthetic",
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
  processes?: { pid: number; commandLine: string }[];
  listCode?: number;
  alive?: Set<number>;
  failing?: Record<string, number>;
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
        if (command === TASKKILL) alive.delete(Number(args[1]));
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

describe("planLegacyDisable", () => {
  it("never plans for an unrecognised definition, an unknown checkout or a missing digest", () => {
    expect(planLegacyDisable({ kind: "none" })).toBeNull();
    expect(planLegacyDisable(found({ recognised: false }))).toBeNull();
    expect(planLegacyDisable(found({ repositoryRoot: undefined }))).toBeNull();
    expect(planLegacyDisable(found({ definitionDigest: undefined }))).toBeNull();
  });

  it("follows pnpm service:uninstall on each platform, with fixed names only", () => {
    expect(describeLegacyDisableSteps(plan(found({ platform: "darwin", definitionPath: "/p/ai.plist" })))).toEqual([
      "launchctl bootout gui/501/ai.workintelligence.server",
      "rm /p/ai.plist",
    ]);
    expect(describeLegacyDisableSteps(plan(found()))).toEqual([
      "systemctl --user disable --now work-intelligence.service",
      "rm /home/synthetic/.config/systemd/user/work-intelligence.service",
      "systemctl --user daemon-reload",
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
    "node.exe server.js --port 3210",
  ])("does not match any other process: %s", (commandLine) => {
    expect(matchesLegacyRunner(commandLine, runner)).toBe(false);
  });
});

describe("parseWindowsNodeProcesses", () => {
  it("reads a list or a single object and drops malformed entries", () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");
    expect(parseWindowsNodeProcesses(encode([{ pid: 4, commandLine: "a" }, { pid: "x" }]))).toEqual([
      { pid: 4, commandLine: "a" },
    ]);
    expect(parseWindowsNodeProcesses(encode({ pid: 7, commandLine: "b" }))).toEqual([{ pid: 7, commandLine: "b" }]);
    expect(parseWindowsNodeProcesses("not base64 json")).toBeNull();
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
      `unlink ${linux.definitionPath}`,
      "systemctl --user daemon-reload",
    ]);
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
    expect(await executeLegacyDisable(plan(linux), dependencies)).toEqual({ outcome: "still-running", port: 3210 });
    expect(calls).toEqual(["systemctl --user disable --now work-intelligence.service"]);
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
    const processes = [
      { pid: 41, commandLine: `"C:\\nodejs\\node.exe" "${runner}" db` },
      { pid: 42, commandLine: `"C:\\nodejs\\node.exe" "C:\\other\\scripts\\service-runner.mjs" db` },
      { pid: 43, commandLine: "node.exe vite --port 3210" },
    ];

    it("ends only this checkout's runner trees, waits for them, then deletes the task", async () => {
      const { dependencies, calls, files } = harness({
        detections: [windows, { kind: "none" }],
        files: { [xml]: DEFINITION },
        processes,
        alive: new Set([41, 42, 43]),
      });
      expect(await executeLegacyDisable(plan(windows), dependencies)).toEqual({
        outcome: "disabled",
        endedProcesses: 1,
      });
      expect(calls.filter((call) => !call.startsWith(POWERSHELL))).toEqual([
        `${SCHTASKS} /End /TN \\Work Intelligence`,
        `${TASKKILL} /PID 41 /T /F`,
        `${SCHTASKS} /Delete /TN \\Work Intelligence /F`,
        `unlink ${xml}`,
      ]);
      expect(files.size).toBe(0);
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
      expect(await executeLegacyDisable(plan(windows), stubborn)).toEqual({ outcome: "still-running", port: 3210 });
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
