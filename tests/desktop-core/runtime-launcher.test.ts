import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LAUNCHER_EXIT_ENTRY_FAILED,
  LAUNCHER_EXIT_INVALID_RUNTIME,
  LAUNCHER_EXIT_USAGE,
  POSIX_SHIM_NAME,
  PRINT_RUNTIME_INFO_FLAG,
  RuntimeError,
  checkLaunchConsistency,
  parseLaunchFile,
  parsePointerText,
  probeSqlite,
  runLauncher,
  runtimeLayout,
  type LauncherHost,
  type LauncherOutcome,
  type LaunchConsistencyInput,
  type RuntimeManifest,
  verifyRuntime,
} from "../../packages/desktop-core/src/runtime/index.js";
import { IS_WINDOWS, flipFirstByte, installFixture, makeRoot } from "./runtime-helpers.js";

let root = "";
let runtimeDirectory = "";

beforeEach(async () => {
  root = await makeRoot();
  runtimeDirectory = (await installFixture(root, "rt-1", { commit: true })).runtimeDirectory;
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

interface Recorded {
  readonly host: LauncherHost;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly argv: string[][];
  readonly imported: string[];
  readonly unset: string[];
}

/** `execPath` defaults to the executable of `rt-1`, which is what a shim would have started. */
function recordingHost(options: { importFails?: Error; execPath?: string } = {}): Recorded {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const argv: string[][] = [];
  const imported: string[] = [];
  const unset: string[] = [];
  const host: LauncherHost = {
    execPath: options.execPath ?? path.join(runtimeDirectory, "node/bin/node"),
    versions: { node: "24.0.0" },
    platform: "linux",
    arch: "x64",
    stdout: (text) => void stdout.push(text),
    stderr: (text) => void stderr.push(text),
    unsetEnv: (name) => void unset.push(name),
    setArgv: (value) => void argv.push(value),
    importModule: async (url) => {
      imported.push(url);
      if (options.importFails) throw options.importFails;
    },
  };
  return { host, stdout, stderr, argv, imported, unset };
}

async function launch(args: string[], recorded: Recorded, directory = runtimeDirectory): Promise<LauncherOutcome> {
  return runLauncher({ runtimeDirectory: directory, argv: args }, recorded.host);
}

describe("runLauncher", () => {
  it("imports the action's entry in this process with argv set as if it had been started directly", async () => {
    const recorded = recordingHost();
    expect(await launch(["serve", "--extra"], recorded)).toEqual({ kind: "handed-over" });
    const entry = path.join(runtimeDirectory, "app/serve.mjs");
    expect(recorded.argv).toEqual([[path.join(runtimeDirectory, "node/bin/node"), entry, "start", "--extra"]]);
    expect(recorded.imported).toEqual([pathToFileURL(entry).href]);
    expect(recorded.stdout).toEqual([]);
    expect(recorded.stderr).toEqual([]);
  });

  it("explains usage when no action is given", async () => {
    const recorded = recordingHost();
    expect(await launch([], recorded)).toEqual({ kind: "exit", code: LAUNCHER_EXIT_USAGE });
    expect(recorded.stderr.join("")).toContain(PRINT_RUNTIME_INFO_FLAG);
    expect(recorded.stdout).toEqual([]);
  });

  it("refuses actions that are not on the list without verifying or importing anything", async () => {
    const recorded = recordingHost();
    await flipFirstByte(path.join(runtimeDirectory, "launcher.mjs"));
    expect(await launch(["bash", "-c", "id"], recorded)).toEqual({ kind: "exit", code: LAUNCHER_EXIT_USAGE });
    expect(recorded.stderr.join("")).toContain("RUNTIME_ACTION_NOT_ALLOWED");
    expect(recorded.imported).toEqual([]);
  });

  it("refuses a tampered runtime with its code on stderr, and nothing on stdout", async () => {
    await flipFirstByte(path.join(runtimeDirectory, "app/mcp.js"));
    const recorded = recordingHost();
    expect(await launch(["mcp"], recorded)).toEqual({ kind: "exit", code: LAUNCHER_EXIT_INVALID_RUNTIME });
    expect(recorded.stderr.join("")).toContain("RUNTIME_FILE_TAMPERED");
    expect(recorded.stderr.join("")).toContain("app/mcp.js");
    expect(recorded.stdout).toEqual([]);
    expect(recorded.imported).toEqual([]);
  });

  it("lets hook actions through (exit 0) when the runtime is unusable, with the diagnosis on stderr", async () => {
    await flipFirstByte(path.join(runtimeDirectory, "app/hook.js"));
    for (const action of ["codex-finalize-reminder", "claude-finalize-reminder"]) {
      const recorded = recordingHost();
      expect(await launch([action], recorded)).toEqual({ kind: "exit", code: 0 });
      expect(recorded.stderr.join("")).toContain("RUNTIME_FILE_TAMPERED");
      expect(recorded.stderr.join("")).toContain("放行");
      expect(recorded.stdout).toEqual([]);
    }
  });

  it("lets a hook through when its entry fails to load, and fails mcp and serve", async () => {
    const hook = recordingHost({ importFails: new Error("boom") });
    expect(await launch(["codex-finalize-reminder"], hook)).toEqual({ kind: "exit", code: 0 });
    expect(hook.stderr.join("")).toContain("boom");
    const mcp = recordingHost({ importFails: new Error("boom") });
    expect(await launch(["mcp"], mcp)).toEqual({ kind: "exit", code: LAUNCHER_EXIT_ENTRY_FAILED });
    const text = recordingHost({ importFails: "not an Error" as unknown as Error });
    expect(await launch(["serve"], text)).toEqual({ kind: "exit", code: LAUNCHER_EXIT_ENTRY_FAILED });
    expect(text.stderr.join("")).toContain("not an Error");
  });

  it("is a usage error when the runtime does not provide a listed action", async () => {
    const { installRuntime, commitCurrent } = await import("../../packages/desktop-core/src/runtime/index.js");
    const { stageFixture, fixtureDefinition } = await import("./runtime-helpers.js");
    const directory = await stageFixture(root, "rt-2");
    const definition = fixtureDefinition("rt-2");
    await installRuntime(root, { ...definition, actions: { mcp: definition.actions.mcp! } });
    await commitCurrent(root, "rt-2");
    const recorded = recordingHost({ execPath: path.join(directory, "node/bin/node") });
    expect(await launch(["serve"], recorded, directory)).toEqual({ kind: "exit", code: LAUNCHER_EXIT_USAGE });
  });

  it("refuses to run from outside <root>/runtimes/<id>/", async () => {
    const recorded = recordingHost();
    expect(await launch(["mcp"], recorded, root)).toEqual({ kind: "exit", code: LAUNCHER_EXIT_INVALID_RUNTIME });
    expect(recorded.stderr.join("")).toContain("RUNTIME_POINTER_INVALID");
  });

  it("prints diagnostics as JSON on stdout for the diagnostic flag only", async () => {
    const recorded = recordingHost();
    expect(await launch([PRINT_RUNTIME_INFO_FLAG], recorded)).toEqual({ kind: "exit", code: 0 });
    const info = JSON.parse(recorded.stdout.join("")) as Record<string, unknown>;
    expect(info).toMatchObject({
      runtimeId: "rt-1",
      runtimeKind: "node",
      execPath: path.join(runtimeDirectory, "node/bin/node"),
      nodeVersion: "24.0.0",
      platform: "linux",
      arch: "x64",
      verification: { files: 8, hashed: 0, cached: 8 },
    });
    expect(info.sqlite).toMatchObject({ fts5: true });
    expect(recorded.imported).toEqual([]);
  });

  it("reports a broken runtime for the diagnostic flag with a failure code", async () => {
    await flipFirstByte(path.join(runtimeDirectory, "app/mcp.js"));
    const recorded = recordingHost();
    expect(await launch([PRINT_RUNTIME_INFO_FLAG], recorded)).toEqual({
      kind: "exit",
      code: LAUNCHER_EXIT_INVALID_RUNTIME,
    });
  });
});

describe("probeSqlite", () => {
  it("reports the SQLite version and FTS5 of this Node", async () => {
    const probe = await probeSqlite();
    expect(probe.error).toBeUndefined();
    expect(probe.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(probe.fts5).toBe(true);
  });
});

describe("runLauncher: the shim started what the manifest names", () => {
  it("removes the Electron variables for a plain Node runtime, and keeps them for Electron", async () => {
    const node = recordingHost();
    await launch(["mcp"], node);
    expect(node.unset.sort()).toEqual(["ELECTRON_NO_ASAR", "ELECTRON_RUN_AS_NODE"]);

    const electronDirectory = (await installFixture(root, "rt-e", { kind: "electron-run-as-node", commit: true }))
      .runtimeDirectory;
    const electron = recordingHost({ execPath: path.join(electronDirectory, "node/bin/node") });
    expect(await launch(["mcp"], electron, electronDirectory)).toEqual({ kind: "handed-over" });
    expect(electron.unset).toEqual([]);
  });

  it("refuses when the running executable is not the manifest's, importing nothing; hooks exit 0", async () => {
    await fs.copyFile(path.join(runtimeDirectory, "node/bin/node"), path.join(root, "other-node"));
    for (const action of ["mcp", "serve"]) {
      const recorded = recordingHost({ execPath: path.join(root, "other-node") });
      expect(await launch([action], recorded)).toEqual({ kind: "exit", code: LAUNCHER_EXIT_INVALID_RUNTIME });
      expect(recorded.stderr.join("")).toContain("RUNTIME_FILE_TAMPERED");
      expect(recorded.stdout).toEqual([]);
      expect(recorded.imported).toEqual([]);
    }
    const hook = recordingHost({ execPath: path.join(root, "other-node") });
    expect(await launch(["claude-finalize-reminder"], hook)).toEqual({ kind: "exit", code: 0 });
    expect(hook.stderr.join("")).toContain("放行");
    expect(hook.imported).toEqual([]);
  });

  it("refuses a current pointer that is not a legal id, and only warns about another legal one", async () => {
    await fs.writeFile(path.join(root, "current"), "../rt-1\n");
    const bad = recordingHost();
    expect(await launch(["mcp"], bad)).toEqual({ kind: "exit", code: LAUNCHER_EXIT_INVALID_RUNTIME });
    expect(bad.stderr.join("")).toContain("RUNTIME_POINTER_INVALID");
    const hook = recordingHost();
    expect(await launch(["codex-finalize-reminder"], hook)).toEqual({ kind: "exit", code: 0 });

    await installFixture(root, "rt-2", { commit: true });
    const other = recordingHost();
    expect(await launch(["mcp"], other)).toEqual({ kind: "handed-over" });
    expect(other.stderr.join("")).toContain("rt-2");
    expect(other.stderr.join("")).toContain("警告");
  });
});

describe("parseLaunchFile", () => {
  it.each([
    ["node/bin/node\n", "node/bin/node"],
    ["node/bin/node\r\n", "node/bin/node"],
    ["node/bin/node", "node/bin/node"],
    ["node/bin/node\r", "node/bin/node"],
    ["\uFEFFnode/bin/node\r\n", "node/bin/node"],
    ["a b/中文/node\n", "a b/中文/node"],
    ['a"b\\c\n', 'a"b\\c'],
  ])("reads %j as one executable", (text, expected) => {
    expect(parseLaunchFile(text)).toBe(expected);
  });

  it.each(["", "\n", "\r\n", "a\nb\n", "a\n\n", "\na\n", "a\r\nb", "\uFEFF\n"])("refuses %j", (text) => {
    expect(() => parseLaunchFile(text)).toThrow(/RUNTIME_MANIFEST_INVALID/);
  });
});

describe("parsePointerText", () => {
  it.each([
    ["rt-1\n", "rt-1"],
    ["rt-1\r\n", "rt-1"],
    ["rt-1", "rt-1"],
    ["\uFEFFrt-1\n", "rt-1"],
    ["  rt-1 \n", "rt-1"],
    ["a".repeat(128), "a".repeat(128)],
  ])("reads %j as an id", (text, expected) => {
    expect(parsePointerText(text)).toBe(expected);
  });

  it.each([
    "",
    "\n",
    "../rt-1\n",
    "rt/1",
    "rt\\1",
    "rt 1",
    "rt-1\nrt-2\n",
    ".rt",
    "-rt",
    "rt;id",
    '"rt-1"',
    "$(id)",
    "測試",
    "a".repeat(129),
  ])("refuses %j", (text) => {
    expect(() => parsePointerText(text)).toThrow(/RUNTIME_POINTER_INVALID/);
  });
});

describe("checkLaunchConsistency", () => {
  const launchFile = (): string => path.join(runtimeDirectory, "runtime-launch.txt");
  let manifest: RuntimeManifest;
  let warnings: string[];

  beforeEach(async () => {
    manifest = (await verifyRuntime(root, "rt-1")).manifest;
    warnings = [];
  });

  function check(overrides: Partial<LaunchConsistencyInput> = {}): Promise<void> {
    return checkLaunchConsistency({
      root,
      runtimeId: "rt-1",
      runtimeDirectory,
      manifest,
      execPath: path.join(runtimeDirectory, "node/bin/node"),
      platform: "linux",
      warn: (message) => void warnings.push(message),
      ...overrides,
    });
  }

  const refusal = async (overrides?: Partial<LaunchConsistencyInput>): Promise<RuntimeError> => {
    try {
      await check(overrides);
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeError);
      return error as RuntimeError;
    }
    throw new Error("the check passed");
  };

  it("passes for what the installer wrote, with no warning", async () => {
    await check();
    expect(warnings).toEqual([]);
  });

  it("refuses an id the pointer could never hold", async () => {
    for (const runtimeId of ["../rt-1", "rt 1", "a".repeat(129), ""]) {
      expect((await refusal({ runtimeId })).code).toBe("RUNTIME_POINTER_INVALID");
    }
  });

  it.each(["node/bin/node\r\n", "\uFEFFnode/bin/node\n", "node/bin/node"])(
    "accepts the launch file %j",
    async (text) => {
      await fs.writeFile(launchFile(), text);
      await check();
    },
  );

  it.each([
    "node\\bin\\node\n",
    " node/bin/node\n",
    "node/bin/node \n",
    '"node/bin/node"\n',
    "node/bin/節點\n",
    "node/bin/other\n",
    "./node/bin/node\n",
    "NODE/BIN/NODE\n",
  ])("refuses the launch file %j because it is not the manifest's executable", async (text) => {
    await fs.writeFile(launchFile(), text);
    const error = await refusal();
    expect(error.code).toBe("RUNTIME_MANIFEST_INVALID");
    expect(error.detail.expected).toBe("node/bin/node");
  });

  it.each(["", "\n", "node/bin/node\nnode/bin/node\n", "\n\nnode/bin/node\n"])(
    "refuses the launch file %j for not being exactly one line",
    async (text) => {
      await fs.writeFile(launchFile(), text);
      expect((await refusal()).code).toBe("RUNTIME_MANIFEST_INVALID");
    },
  );

  it("refuses a missing launch file", async () => {
    await fs.rm(launchFile());
    expect((await refusal()).code).toBe("RUNTIME_MANIFEST_INVALID");
  });

  it("refuses a manifest that names a different executable than the launch file", async () => {
    expect((await refusal({ manifest: { ...manifest, executable: "app/mcp.js" } })).code).toBe(
      "RUNTIME_MANIFEST_INVALID",
    );
  });

  it("refuses an execPath that is another file or does not exist", async () => {
    for (const execPath of [path.join(runtimeDirectory, "app/mcp.js"), path.join(root, "missing"), ""]) {
      const error = await refusal({ execPath });
      expect(error.code).toBe("RUNTIME_FILE_TAMPERED");
      expect(error.message).toContain("shim 啟動的不是 manifest 指定的 executable");
    }
  });

  it.skipIf(IS_WINDOWS)("compares real paths: a symlink to the executable is the executable", async () => {
    const alias = path.join(root, "alias-node");
    await fs.symlink(path.join(runtimeDirectory, "node/bin/node"), alias);
    await check({ execPath: alias });
  });

  it.skipIf(process.platform === "win32" || process.platform === "darwin")(
    "ignores case only on Windows and macOS",
    async () => {
      // Two distinct files whose names differ only by case exist on a case-sensitive file system.
      await fs.writeFile(path.join(runtimeDirectory, "node/bin/NODE"), "x");
      const execPath = path.join(runtimeDirectory, "node/bin/NODE");
      expect((await refusal({ execPath, platform: "linux" })).code).toBe("RUNTIME_FILE_TAMPERED");
      await check({ execPath, platform: "win32" });
      await check({ execPath, platform: "darwin" });
    },
  );

  it("refuses a current pointer that is missing, unreadable as an id or not a file", async () => {
    await fs.rm(path.join(root, "current"));
    expect((await refusal()).code).toBe("RUNTIME_POINTER_MISSING");
    for (const text of ["", "../rt-1\n", "rt 1\n", "rt-1\nrt-2\n", "a".repeat(129)]) {
      await fs.writeFile(path.join(root, "current"), text);
      expect((await refusal()).code, JSON.stringify(text)).toBe("RUNTIME_POINTER_INVALID");
    }
    await fs.rm(path.join(root, "current"));
    await fs.mkdir(path.join(root, "current"));
    expect((await refusal()).code).toBe("RUNTIME_MANIFEST_INVALID");
  });

  it("accepts a current pointer with a byte order mark, CRLF or spaces", async () => {
    for (const text of ["\uFEFFrt-1\r\n", "rt-1\r\n", " rt-1 \n", "rt-1"]) {
      await fs.writeFile(path.join(root, "current"), text);
      await check();
    }
    expect(warnings).toEqual([]);
  });

  it("only warns when current names another legal runtime (an update may be switching it)", async () => {
    await fs.writeFile(path.join(root, "current"), "rt-2\n");
    await check();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("rt-2");
    expect(warnings[0]).toContain("rt-1");
  });
});

describe("probeSqlite", () => {
  it("reports the SQLite version and FTS5 of this Node", async () => {
    const probe = await probeSqlite();
    expect(probe.error).toBeUndefined();
    expect(probe.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(probe.fts5).toBe(true);
  });
});

/** The shim, run for real: only on POSIX, because it is a /bin/sh script. It validates nothing; the launcher does. */
describe.skipIf(IS_WINDOWS)("POSIX shim", () => {
  const shim = (): string => path.join(runtimeLayout(root).binDirectory, POSIX_SHIM_NAME);
  const launchFile = (): string => path.join(runtimeDirectory, "runtime-launch.txt");

  function run(
    args: string[],
    env: Record<string, string> = {},
  ): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(shim(), args, { env: { PATH: "/usr/bin:/bin", ...env }, encoding: "utf8" });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it("runs the current runtime's executable with its launcher script and the caller's arguments, in a root with spaces and Chinese", async () => {
    expect(root).toMatch(/ 測試-/);
    const result = run(["mcp", "a b", "$HOME", ""]);
    expect(result.status).toBe(0);
    // The fake executable prints the two Electron flags, then each argument on a line.
    expect(result.stdout.split("\n")).toEqual([
      "11",
      path.join(runtimeDirectory, "launcher.mjs"),
      "mcp",
      "a b",
      "$HOME",
      "",
      "",
    ]);
  });

  it("sets the Electron variables for every runtime, because it cannot tell which kind it starts", async () => {
    await installFixture(root, "rt-e", { kind: "electron-run-as-node", commit: true });
    expect(run(["mcp"]).stdout.split("\n")[0]).toBe("11");
  });

  it("follows the pointer: switching current is all it takes to run another runtime", async () => {
    const other = (await installFixture(root, "rt-2", { commit: true })).runtimeDirectory;
    expect(run(["mcp"]).stdout).toContain(path.join(other, "launcher.mjs"));
  });

  it("works when started through a relative path", async () => {
    const result = spawnSync("./work-intelligence-launcher", ["mcp"], {
      cwd: runtimeLayout(root).binDirectory,
      env: { PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
  });

  it("accepts CRLF in current and in the launch file, and a pointer without a trailing newline", async () => {
    await fs.writeFile(path.join(root, "current"), "rt-1\r\n");
    expect(run(["mcp"]).status).toBe(0);
    await fs.writeFile(path.join(root, "current"), "rt-1");
    expect(run(["mcp"]).status).toBe(0);
    await fs.writeFile(launchFile(), "node/bin/node\r\n");
    expect(run(["mcp"]).status).toBe(0);
  });

  it("refuses a missing pointer with its code, exit 78 and nothing on stdout; hooks exit 0", async () => {
    await fs.rm(path.join(root, "current"));
    const mcp = run(["mcp"]);
    expect(mcp.status).toBe(78);
    expect(mcp.stdout).toBe("");
    expect(mcp.stderr).toContain("RUNTIME_POINTER_MISSING");
    expect(mcp.stderr).toContain("請從 App 重新安裝 runtime");
    for (const action of ["codex-finalize-reminder", "claude-finalize-reminder"]) {
      const hook = run([action]);
      expect(hook.status).toBe(0);
      expect(hook.stdout).toBe("");
      expect(hook.stderr).toContain("放行");
    }
  });

  it("refuses an empty pointer or launch file the same way", async () => {
    await fs.writeFile(path.join(root, "current"), "\n");
    expect(run(["mcp"]).status).toBe(78);
    expect(run(["codex-finalize-reminder"]).status).toBe(0);
    await fs.writeFile(path.join(root, "current"), "rt-1\n");
    await fs.writeFile(launchFile(), "\n");
    const mcp = run(["mcp"]);
    expect(mcp.status).toBe(78);
    expect(mcp.stderr).toContain("RUNTIME_MANIFEST_INVALID");
    expect(run(["claude-finalize-reminder"]).status).toBe(0);
  });

  it("refuses a launch file or pointer naming something that is not there; hooks exit 0", async () => {
    await fs.writeFile(launchFile(), "node/bin/missing\n");
    const missingExecutable = run(["mcp"]);
    expect(missingExecutable.status).toBe(78);
    expect(missingExecutable.stderr).toContain("RUNTIME_FILE_MISSING");
    expect(run(["codex-finalize-reminder"]).status).toBe(0);
    await fs.writeFile(launchFile(), "node/bin/node\n");
    await fs.writeFile(path.join(root, "current"), "rt-gone\n");
    expect(run(["mcp"]).status).toBe(78);
    expect(run(["claude-finalize-reminder"]).status).toBe(0);
    await fs.writeFile(path.join(root, "current"), "rt-1\n");
    await fs.rm(path.join(runtimeDirectory, "launcher.mjs"));
    expect(run(["mcp"]).status).toBe(78);
  });

  it("always starts launcher.mjs at the runtime root: a launch file cannot name another script", async () => {
    await fs.writeFile(launchFile(), "node/bin/node\napp/serve.mjs\n");
    expect(run(["mcp"]).stdout.split("\n")[1]).toBe(path.join(runtimeDirectory, "launcher.mjs"));
  });
});
