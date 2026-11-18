import { execFile, spawnSync } from "node:child_process";
import nodeConsole from "node:console";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishIntegrationRecord } from "../../packages/desktop-core/src/integration/index.js";
import {
  CLAUDE_PRE_TOOL_USE_MATCHER,
  CODEX_POST_TOOL_USE_MATCHER,
  CODEX_PRE_TOOL_USE_MATCHER,
  commandForAgentHook,
} from "@work-intelligence/agent-setup";
import {
  resolveDesktopLauncher,
  runDesktopLauncher,
} from "../../plugins/work-intelligence/scripts/desktop-integration.mjs";
import { claudePluginEnabled, codexPluginEnabled, collectDoctorFindings } from "../../apps/server/src/doctor.js";
import type { UserServiceStatus } from "../../packages/core/src/index.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pluginRoot = join(repositoryRoot, "plugins/work-intelligence");
const launcher = join(pluginRoot, "scripts/launch.mjs");
const linkScript = join(repositoryRoot, "scripts/plugin-link.mjs");
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const root = process.env.WORK_INTELLIGENCE_TEST_TMP?.trim() || tmpdir();
  const directory = mkdtempSync(join(root, "work-intelligence-plugin-"));
  temporaryDirectories.push(directory);
  return directory;
}

function readText(path: string): string {
  return readFileSync(path, "utf8").replaceAll("\r\n", "\n");
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** A checkout shaped like this repository whose built entry points only echo what they received. */
function fakeRepository(root: string, built = true): string {
  for (const file of ["pnpm-workspace.yaml", "apps/mcp/package.json", "packages/shared/package.json"]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "{}\n");
  }
  if (built) {
    mkdirSync(join(root, "apps/mcp/dist"), { recursive: true });
    const echo = (name: string) =>
      [
        `let input = "";`,
        `process.stdin.on("data", (chunk) => (input += chunk));`,
        `process.stdin.on("end", () => {`,
        `  process.stdout.write(JSON.stringify({ name: ${JSON.stringify(name)}, args: process.argv.slice(2), input }));`,
        `  process.exitCode = 3;`,
        `});`,
      ].join("\n");
    writeFileSync(join(root, "apps/mcp/dist/index.js"), echo("mcp"));
    writeFileSync(join(root, "apps/mcp/dist/finalize-reminder.js"), echo("finalize-reminder"));
  }
  return root;
}

/** The test runner's environment (Windows needs SystemRoot and friends) without any Work Intelligence location. */
function inheritedEnvironment(): NodeJS.ProcessEnv {
  const inherited = { ...process.env };
  const isolatedNames = new Set([
    "HOME",
    "USERPROFILE",
    "WORK_INTELLIGENCE_HOME",
    "WORK_INTELLIGENCE_CONFIG_DIR",
    "WORK_INTELLIGENCE_DB",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
  ]);
  for (const name of Object.keys(inherited)) {
    if (isolatedNames.has(name.toUpperCase())) delete inherited[name];
  }
  return inherited;
}

function run(script: string, args: string[], environment: NodeJS.ProcessEnv, input = "") {
  const home = environment.HOME ?? environment.USERPROFILE ?? tmpdir();
  return spawnSync(process.execPath, [script, ...args], {
    input,
    encoding: "utf8",
    env: {
      ...inheritedEnvironment(),
      HOME: home,
      USERPROFILE: home,
      WORK_INTELLIGENCE_CONFIG_DIR: join(home, ".work-intelligence"),
      CODEX_HOME: join(home, ".codex"),
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      ...environment,
    },
  });
}

/** Like {@link run}, without blocking this process, so servers started by the test keep answering. */
function spawnAsync(script: string, environment: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  const home = environment.HOME ?? tmpdir();
  return new Promise((resolveRun) => {
    execFile(
      process.execPath,
      [script],
      {
        env: {
          ...inheritedEnvironment(),
          HOME: home,
          USERPROFILE: home,
          WORK_INTELLIGENCE_CONFIG_DIR: join(home, ".work-intelligence"),
          ...environment,
        },
        timeout: 30_000,
      },
      (_error, stdout, stderr) => resolveRun({ stdout, stderr }),
    );
  });
}

/** Keeps doctor off the host's real login service (Task Scheduler on Windows takes seconds to query). */
function isolatedUserServiceStatus(home: string): UserServiceStatus {
  return {
    supported: false,
    state: "unsupported",
    manager: null,
    enabled: false,
    running: false,
    configPath: join(home, "service", "work-intelligence.conf"),
    databasePath: join(home, "data", "work-intelligence.sqlite"),
    backupDirectory: join(home, "data", "backups"),
    logPath: join(home, "logs", "server.log"),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("plugin manifests", () => {
  const version = readJson(join(repositoryRoot, "package.json")).version;

  it("ship the repository version", () => {
    expect(readJson(join(pluginRoot, ".claude-plugin/plugin.json")).version).toBe(version);
    expect(readJson(join(pluginRoot, ".codex-plugin/plugin.json")).version).toBe(version);
  });

  it("give Codex the save-reminder hooks setup:agents installs, rooted at PLUGIN_ROOT", () => {
    const codex = readJson(join(pluginRoot, ".codex-plugin/plugin.json"));
    // Codex also reads hooks/hooks.json, Claude Code's default, so the Codex hooks need a file of their own.
    expect(codex.hooks).toBe("./hooks/codex-hooks.json");
    const command = 'node "${PLUGIN_ROOT}/scripts/launch.mjs" codex-finalize-reminder';
    const handler = [{ type: "command", command }];
    expect(readJson(join(pluginRoot, "hooks/codex-hooks.json"))).toEqual({
      hooks: {
        PostToolUse: [{ matcher: CODEX_POST_TOOL_USE_MATCHER, hooks: handler }],
        Stop: [{ hooks: handler }],
        PreToolUse: [{ matcher: CODEX_PRE_TOOL_USE_MATCHER, hooks: handler }],
        UserPromptSubmit: [{ hooks: handler }],
        SessionStart: [{ matcher: "compact", hooks: handler }],
      },
    });
  });

  it("give Claude Code the Stop reminder plus the compaction hooks, all through one command", () => {
    const claude = readJson(join(pluginRoot, ".claude-plugin/plugin.json"));
    const command = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/launch.mjs" finalize-reminder';
    const handler = [{ type: "command", command }];
    expect(claude.hooks).toEqual({
      Stop: [{ hooks: handler }],
      // No matcher: both manual and automatic compactions get the summary instructions.
      PreCompact: [{ hooks: handler }],
      PreToolUse: [{ matcher: CLAUDE_PRE_TOOL_USE_MATCHER, hooks: handler }],
      SessionStart: [{ matcher: "compact", hooks: handler }],
    });
  });

  it("start the MCP server through the launcher in both agents", () => {
    const claude = readJson(join(pluginRoot, ".claude-plugin/plugin.json"));
    expect(claude.mcpServers).toEqual({
      "work-intelligence": { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/scripts/launch.mjs", "mcp"] },
    });
    expect(JSON.stringify(claude.hooks)).toContain('launch.mjs\\" finalize-reminder');
    const codex = readJson(join(pluginRoot, ".codex-plugin/plugin.json"));
    expect(existsSync(join(pluginRoot, codex.mcpServers as string))).toBe(true);
    expect(readJson(join(pluginRoot, codex.mcpServers as string)).mcpServers).toEqual({
      // Codex starts plugin servers in the plugin directory only when cwd says so.
      "work-intelligence": { command: "node", args: ["./scripts/launch.mjs", "mcp"], cwd: "." },
    });
    // Claude Code reads a root .mcp.json and Codex discovers one too; neither may load the other's paths.
    expect(existsSync(join(pluginRoot, ".mcp.json"))).toBe(false);
    expect(existsSync(join(pluginRoot, "hooks/hooks.json"))).toBe(false);
  });

  it("bundle the same skill the repository publishes", () => {
    expect(readFileSync(join(pluginRoot, "skills/work-intelligence/SKILL.md"), "utf8")).toBe(
      readFileSync(join(repositoryRoot, ".agents/skills/work-intelligence/SKILL.md"), "utf8"),
    );
  });

  it("bundle the skill's on-demand guides and the report-writing skill beside them, file for file", () => {
    for (const skill of [
      "work-intelligence/references",
      "worklog-report-writing",
      "worklog-report-writing/references",
    ]) {
      const canonical = join(repositoryRoot, ".agents/skills", skill);
      const names = readdirSync(canonical).filter((name) => name.endsWith(".md"));
      expect(names.length).toBeGreaterThan(0);
      expect(readdirSync(join(pluginRoot, "skills", skill)).filter((name) => name.endsWith(".md"))).toEqual(names);
      for (const name of names) {
        // Line endings follow the checkout (.gitattributes), so compare text with them normalized.
        expect(readText(join(pluginRoot, "skills", skill, name))).toBe(readText(join(canonical, name)));
      }
    }
  });

  it("carry the README the Anthropic directory requires: at least 40 words outside code blocks", () => {
    const readme = readFileSync(join(pluginRoot, "README.md"), "utf8").replace(/```[\s\S]*?```/g, "");
    expect(readme.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(40);
    expect(readJson(join(pluginRoot, ".claude-plugin/plugin.json")).license).toBe("MIT");
  });

  it("ship a dashboard skill that both agents can follow", () => {
    const skill = readFileSync(join(pluginRoot, "skills/dashboard/SKILL.md"), "utf8");
    expect(skill).toMatch(/^---\nname: dashboard\ndescription: .+\n---\n/);
    // Claude Code substitutes CLAUDE_PLUGIN_ROOT in skill content; Codex finds the checkout through the plugin link.
    expect(skill).toContain('node "${CLAUDE_PLUGIN_ROOT}/scripts/launch.mjs" dashboard --open');
    expect(skill).toContain('node "<checkout>/scripts/dashboard.mjs" --open');
    expect(skill).toContain("plugin-link.json");
  });

  it("ship the Web UI's icon for the Anthropic directory listing", () => {
    const icon = readJson(join(pluginRoot, ".claude-plugin/plugin.json")).icon as string;
    expect(icon).toBe("./assets/icon.svg");
    expect(readFileSync(join(pluginRoot, icon), "utf8")).toBe(
      readFileSync(join(repositoryRoot, "apps/web/public/favicon.svg"), "utf8"),
    );
  });

  it("are listed by both marketplaces", () => {
    const claude = readJson(join(repositoryRoot, ".claude-plugin/marketplace.json"));
    const codex = readJson(join(repositoryRoot, ".agents/plugins/marketplace.json"));
    expect(claude.plugins).toEqual([
      expect.objectContaining({ name: "work-intelligence", source: "./plugins/work-intelligence" }),
    ]);
    expect(codex.plugins).toEqual([
      expect.objectContaining({
        name: "work-intelligence",
        source: { source: "local", path: "./plugins/work-intelligence" },
      }),
    ]);
  });
});

describe("plugin launcher", () => {
  it("runs the repository's MCP entry point with stdio and exit code passed through", () => {
    const home = temporaryDirectory();
    const repository = fakeRepository(join(home, "checkout"));
    const result = run(launcher, ["mcp", "--extra"], { HOME: home, WORK_INTELLIGENCE_HOME: repository }, "ping");
    expect(JSON.parse(result.stdout)).toEqual({ name: "mcp", args: ["--extra"], input: "ping" });
    expect(result.status).toBe(3);
  });

  it("runs the checkout's MCP launcher when it is built, so a rebuild does not need a reconnect", () => {
    const home = temporaryDirectory();
    const repository = fakeRepository(join(home, "checkout"));
    writeFileSync(
      join(repository, "apps/mcp/dist/launcher.js"),
      'process.stdout.write(JSON.stringify({ name: "launcher", args: process.argv.slice(2) }));',
    );
    const result = run(launcher, ["mcp"], { HOME: home, WORK_INTELLIGENCE_HOME: repository });
    expect(JSON.parse(result.stdout)).toEqual({ name: "launcher", args: [] });
  });

  it("finds the repository it sits in, as when loaded in place from this marketplace", () => {
    const home = temporaryDirectory();
    const repository = fakeRepository(join(home, "checkout"));
    cpSync(pluginRoot, join(repository, "plugins/work-intelligence"), { recursive: true });
    const result = run(join(repository, "plugins/work-intelligence/scripts/launch.mjs"), ["mcp"], { HOME: home });
    expect(JSON.parse(result.stdout)).toMatchObject({ name: "mcp" });
  });

  it("follows the link written by pnpm plugin:link when copied into an agent's cache", () => {
    const home = temporaryDirectory();
    const repository = fakeRepository(join(home, "checkout"));
    const cached = join(home, "cache/work-intelligence");
    cpSync(pluginRoot, cached, { recursive: true });
    mkdirSync(join(home, ".work-intelligence"));
    writeFileSync(join(home, ".work-intelligence/plugin-link.json"), JSON.stringify({ repositoryRoot: repository }));
    const result = run(join(cached, "scripts/launch.mjs"), ["finalize-reminder"], { HOME: home }, "{}");
    expect(JSON.parse(result.stdout)).toMatchObject({ name: "finalize-reminder", input: "{}" });
    // A hook never blocks the Agent, whatever the reminder script exits with.
    expect(result.status).toBe(0);
  });

  it("skips the unbuilt marketplace clone Codex runs the plugin from and uses the linked checkout", () => {
    const home = temporaryDirectory();
    // Codex keeps a full clone of the marketplace repository and runs the plugin inside it, without building it.
    const clone = fakeRepository(join(home, ".codex/.tmp/marketplaces/worklog-ai"), false);
    cpSync(pluginRoot, join(clone, "plugins/work-intelligence"), { recursive: true });
    const repository = fakeRepository(join(home, "checkout"));
    mkdirSync(join(home, ".work-intelligence"));
    writeFileSync(join(home, ".work-intelligence/plugin-link.json"), JSON.stringify({ repositoryRoot: repository }));
    const result = run(join(clone, "plugins/work-intelligence/scripts/launch.mjs"), ["mcp"], { HOME: home }, "x");
    expect(JSON.parse(result.stdout)).toMatchObject({ name: "mcp", input: "x" });
    const unlinked = run(join(clone, "plugins/work-intelligence/scripts/launch.mjs"), ["mcp"], {
      HOME: join(home, "nobody"),
    });
    expect(unlinked.status).toBe(1);
    expect(unlinked.stderr).toContain(`${clone} (plugin location)`);
  });

  it("still runs when started through a symlinked plugin directory", () => {
    const home = temporaryDirectory();
    const repository = fakeRepository(join(home, "checkout"));
    cpSync(pluginRoot, join(home, "real"), { recursive: true });
    // A junction needs no privilege on Windows and behaves as a directory symlink elsewhere.
    symlinkSync(join(home, "real"), join(home, "linked"), "junction");
    const result = run(join(home, "linked/scripts/launch.mjs"), ["mcp"], {
      HOME: home,
      WORK_INTELLIGENCE_HOME: repository,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ name: "mcp" });
  });

  it("explains a missing repository or build, but keeps the Stop hook silent", () => {
    const home = temporaryDirectory();
    const cached = join(home, "cache/work-intelligence");
    cpSync(pluginRoot, cached, { recursive: true });
    const script = join(cached, "scripts/launch.mjs");
    const missing = run(script, ["mcp"], { HOME: home });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("pnpm plugin:link");
    for (const reminder of ["finalize-reminder", "codex-finalize-reminder"]) {
      expect(run(script, [reminder], { HOME: home }, "{}")).toMatchObject({ status: 0, stdout: "", stderr: "" });
    }
    const unbuilt = fakeRepository(join(home, "unbuilt"), false);
    const notBuilt = run(script, ["mcp"], { HOME: home, WORK_INTELLIGENCE_HOME: unbuilt });
    expect(notBuilt.status).toBe(1);
    expect(notBuilt.stderr).toContain("Run pnpm build in your checkout");
    expect(run(script, ["serve"], { HOME: home }).stderr).toContain('Unknown command "serve"');
  });
});

/** What the fake desktop installation answers: the shim echoes its action and stdin, the App records its arguments. */
const LAUNCHER_SHIM = (exitCode: number, delay = "") =>
  `#!/bin/sh\n${delay}printf 'launcher:%s:' "$1"\ncat\necho shim-diagnostic >&2\nexit ${exitCode}\n`;
const APP_STUB = '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$(dirname "$0")/app-arguments.txt"\n';

interface FakeDesktop {
  readonly runtimeRoot: string;
  readonly launcherPath: string;
  readonly appExecutable: string;
  readonly recordFile: string;
  readonly appArguments: string;
}

/** A desktop installation as the App leaves it (runtime root with the shim, an executable) plus its record. */
async function fakeDesktop(home: string, options: { exitCode?: number; shim?: string; record?: boolean } = {}) {
  const runtimeRoot = join(home, "Work Intelligence", "runtime");
  const launcherPath = join(runtimeRoot, "bin", "work-intelligence-launcher");
  const appExecutable = join(home, "Work Intelligence", "app", "work-intelligence-app");
  const runtime = join(runtimeRoot, "runtimes", "r1");
  mkdirSync(join(runtimeRoot, "bin"), { recursive: true });
  mkdirSync(runtime, { recursive: true });
  mkdirSync(dirname(appExecutable), { recursive: true });
  writeFileSync(launcherPath, options.shim ?? LAUNCHER_SHIM(options.exitCode ?? 4), { mode: 0o755 });
  writeFileSync(appExecutable, APP_STUB, { mode: 0o755 });
  chmodSync(launcherPath, 0o755);
  // What the shim reads: the pointer, the runtime's launch file, its executable and launcher script.
  writeFileSync(join(runtimeRoot, "current"), "r1\n");
  writeFileSync(join(runtime, "runtime-launch.txt"), "node\n");
  writeFileSync(join(runtime, "node"), "");
  writeFileSync(join(runtime, "launcher.mjs"), "");
  // The launcher trusts only entries nobody else can write, whatever umask the test runner has.
  for (const directory of [runtimeRoot, join(runtimeRoot, "bin")]) chmodSync(directory, 0o755);
  const recordFile = join(home, ".work-intelligence", "desktop-integration.json");
  if (options.record !== false) {
    await publishIntegrationRecord(recordFile, { runtimeRoot, appExecutable, appVersion: "1.0.0" });
    chmodSync(dirname(recordFile), 0o755);
  }
  return {
    runtimeRoot,
    launcherPath,
    appExecutable,
    recordFile,
    appArguments: join(dirname(appExecutable), "app-arguments.txt"),
  };
}

function rewriteRecord(desktop: FakeDesktop, change: (record: Record<string, unknown>) => Record<string, unknown>) {
  const record = JSON.parse(readFileSync(desktop.recordFile, "utf8")) as Record<string, unknown>;
  writeFileSync(desktop.recordFile, JSON.stringify(change(record)));
}

/**
 * The plugin copied out of this repository, as an Agent's plugin cache holds it: run in place, it would find this
 * checkout as its own location, and whether that checkout is built depends on what ran before the tests.
 */
function cachedPluginLauncher(home: string): string {
  const cached = join(home, "cache/work-intelligence");
  cpSync(pluginRoot, cached, { recursive: true });
  return join(cached, "scripts/launch.mjs");
}

async function waitForFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) return readFileSync(path, "utf8");
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`${path} did not appear`);
}

describe.skipIf(process.platform === "win32")("plugin launcher with the desktop App", () => {
  it("runs the App's fixed launcher for mcp with stdio and exit code passed through", async () => {
    const home = temporaryDirectory();
    await fakeDesktop(home);
    const result = run(launcher, ["mcp"], { HOME: home }, "ping");
    expect(result.stdout).toBe("launcher:mcp:ping");
    expect(result.status).toBe(4);
  });

  it.skipIf(process.platform === "win32")(
    "accepts group-writable folders, as a umask-002 system creates them (ADR-15 refuses world-writable only)",
    async () => {
      const home = temporaryDirectory();
      const desktop = await fakeDesktop(home);
      for (const directory of [desktop.runtimeRoot, join(desktop.runtimeRoot, "bin"), dirname(desktop.recordFile)]) {
        chmodSync(directory, 0o775);
      }
      expect(run(launcher, ["mcp"], { HOME: home }, "ping").stdout).toBe("launcher:mcp:ping");
    },
  );

  it("maps the hook commands to the launcher's actions and always exits 0, silently", async () => {
    const home = temporaryDirectory();
    await fakeDesktop(home, { exitCode: 7 });
    expect(run(launcher, ["finalize-reminder"], { HOME: home }, "{}")).toMatchObject({
      stdout: "launcher:claude-finalize-reminder:{}",
      stderr: "",
      status: 0,
    });
    expect(run(launcher, ["codex-finalize-reminder"], { HOME: home }, "{}")).toMatchObject({
      stdout: "launcher:codex-finalize-reminder:{}",
      stderr: "",
      status: 0,
    });
  });

  it("stops a hung hook at its timeout and still exits 0", async () => {
    const home = temporaryDirectory();
    const desktop = await fakeDesktop(home, { shim: LAUNCHER_SHIM(0, "exec sleep 30\n") });
    const script = join(home, "hung-hook.mjs");
    writeFileSync(
      script,
      [
        `import { runDesktopLauncher } from ${JSON.stringify(pathToFileURL(join(pluginRoot, "scripts/desktop-integration.mjs")).href)};`,
        `runDesktopLauncher({ command: ${JSON.stringify(desktop.launcherPath)}, args: ["codex-finalize-reminder"], windowsVerbatimArguments: false }, { hook: true, timeoutMs: 300 });`,
      ].join("\n"),
    );
    const started = Date.now();
    const result = run(script, [], { HOME: home });
    expect(result.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("lets a built WORK_INTELLIGENCE_HOME checkout win, and prefers the launcher over the other checkouts", async () => {
    const home = temporaryDirectory();
    await fakeDesktop(home);
    const explicit = fakeRepository(join(home, "explicit"));
    expect(JSON.parse(run(launcher, ["mcp"], { HOME: home, WORK_INTELLIGENCE_HOME: explicit }).stdout)).toMatchObject({
      name: "mcp",
    });
    const linked = fakeRepository(join(home, "linked"));
    writeFileSync(join(home, ".work-intelligence/plugin-link.json"), JSON.stringify({ repositoryRoot: linked }));
    const inPlace = fakeRepository(join(home, "in-place"));
    cpSync(pluginRoot, join(inPlace, "plugins/work-intelligence"), { recursive: true });
    for (const script of [launcher, join(inPlace, "plugins/work-intelligence/scripts/launch.mjs")]) {
      expect(run(script, ["mcp"], { HOME: home }, "x").stdout).toBe("launcher:mcp:x");
    }
    // An explicit checkout that is not built does not block the launcher.
    const unbuilt = fakeRepository(join(home, "unbuilt"), false);
    expect(run(launcher, ["mcp"], { HOME: home, WORK_INTELLIGENCE_HOME: unbuilt }, "x").stdout).toBe("launcher:mcp:x");
  });

  const unusable: Array<[string, (desktop: FakeDesktop) => void | Promise<void>]> = [
    ["no record", (desktop) => rmSync(desktop.recordFile)],
    ["a record that is not JSON", (desktop) => writeFileSync(desktop.recordFile, "{")],
    ["a record with an extra field", (desktop) => rewriteRecord(desktop, (record) => ({ ...record, extra: 1 }))],
    ["a record of another version", (desktop) => rewriteRecord(desktop, (record) => ({ ...record, version: 2 }))],
    [
      "a relative launcher path",
      (desktop) => rewriteRecord(desktop, (record) => ({ ...record, launcherPath: "bin/work-intelligence-launcher" })),
    ],
    [
      "a launcher outside runtimeRoot/bin",
      (desktop) => {
        const stray = join(dirname(desktop.runtimeRoot), "stray-launcher");
        writeFileSync(stray, LAUNCHER_SHIM(0), { mode: 0o755 });
        rewriteRecord(desktop, (record) => ({ ...record, launcherPath: stray }));
      },
    ],
    [
      "a launcher path with .. segments",
      (desktop) =>
        rewriteRecord(desktop, (record) => ({
          ...record,
          launcherPath: `${desktop.runtimeRoot}/bin/../bin/work-intelligence-launcher`,
        })),
    ],
    ["a stale record whose shim was removed", (desktop) => rmSync(desktop.launcherPath)],
    [
      "a shim that is a symlink",
      (desktop) => {
        const real = join(dirname(desktop.runtimeRoot), "real-launcher");
        writeFileSync(real, LAUNCHER_SHIM(0), { mode: 0o755 });
        rmSync(desktop.launcherPath);
        symlinkSync(real, desktop.launcherPath);
      },
    ],
    [
      "a bin directory that is a symlink",
      (desktop) => {
        const elsewhere = join(dirname(desktop.runtimeRoot), "elsewhere");
        cpSync(join(desktop.runtimeRoot, "bin"), elsewhere, { recursive: true });
        rmSync(join(desktop.runtimeRoot, "bin"), { recursive: true });
        symlinkSync(elsewhere, join(desktop.runtimeRoot, "bin"), "dir");
      },
    ],
    ["a record file everyone can write", (desktop) => chmodSync(desktop.recordFile, 0o666)],
    ["a config directory everyone can write", (desktop) => chmodSync(dirname(desktop.recordFile), 0o777)],
    ["a runtime root everyone can write", (desktop) => chmodSync(desktop.runtimeRoot, 0o777)],
    ["a bin directory everyone can write", (desktop) => chmodSync(join(desktop.runtimeRoot, "bin"), 0o777)],
    ["a shim everyone can write", (desktop) => chmodSync(desktop.launcherPath, 0o777)],
    [
      "a runtime root that is a symlink",
      (desktop) => {
        const elsewhere = join(dirname(desktop.runtimeRoot), "elsewhere-root");
        cpSync(desktop.runtimeRoot, elsewhere, { recursive: true });
        rmSync(desktop.runtimeRoot, { recursive: true });
        symlinkSync(elsewhere, desktop.runtimeRoot, "dir");
      },
    ],
    ["a missing runtime pointer (current)", (desktop) => rmSync(join(desktop.runtimeRoot, "current"))],
    [
      "a runtime pointer that is a symlink",
      (desktop) => {
        const real = join(dirname(desktop.runtimeRoot), "real-current");
        writeFileSync(real, "r1\n");
        rmSync(join(desktop.runtimeRoot, "current"));
        symlinkSync(real, join(desktop.runtimeRoot, "current"));
      },
    ],
    [
      "a runtime without its launch file",
      (desktop) => rmSync(join(desktop.runtimeRoot, "runtimes/r1/runtime-launch.txt")),
    ],
    [
      "a shim that is a directory",
      (desktop) => {
        rmSync(desktop.launcherPath);
        mkdirSync(desktop.launcherPath);
      },
    ],
  ];

  it.each(unusable)("falls back to the checkout when the desktop record is unusable: %s", async (_name, spoil) => {
    const home = temporaryDirectory();
    const desktop = await fakeDesktop(home);
    const repository = fakeRepository(join(home, "checkout"));
    writeFileSync(join(home, ".work-intelligence/plugin-link.json"), JSON.stringify({ repositoryRoot: repository }));
    // Outside this repository, whose own build would otherwise be found first as the plugin's location.
    const cached = join(home, "cache/work-intelligence");
    cpSync(pluginRoot, cached, { recursive: true });
    const cachedLauncher = join(cached, "scripts/launch.mjs");
    await spoil(desktop);
    const result = run(cachedLauncher, ["mcp"], { HOME: home }, "x");
    expect(JSON.parse(result.stdout)).toMatchObject({ name: "mcp", input: "x" });
    for (const reminder of ["finalize-reminder", "codex-finalize-reminder"]) {
      expect(run(cachedLauncher, [reminder], { HOME: home }, "{}").stdout).not.toContain("launcher:");
    }
  });

  it("hands the dashboard to the App with --open-dashboard and starts no server", async () => {
    const home = temporaryDirectory();
    const desktop = await fakeDesktop(home);
    // A built checkout would start a server (and need a free port); the App must be asked instead.
    const repository = fakeRepository(join(home, "checkout"));
    writeFileSync(join(home, ".work-intelligence/plugin-link.json"), JSON.stringify({ repositoryRoot: repository }));
    for (const script of [launcher, join(repositoryRoot, "scripts/dashboard.mjs")]) {
      rmSync(desktop.appArguments, { force: true });
      const result = run(script, ["dashboard", "--open"].slice(script === launcher ? 0 : 1), { HOME: home });
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(result.stdout).toContain("desktop App");
      expect(await waitForFile(desktop.appArguments)).toBe("--open-dashboard\n");
    }
  });

  it("keeps a WORK_INTELLIGENCE_HOME checkout's dashboard and falls back when the App is gone", async () => {
    const home = temporaryDirectory();
    const desktop = await fakeDesktop(home);
    const unbuilt = fakeRepository(join(home, "checkout"), false);
    const cachedLauncher = cachedPluginLauncher(home);
    const explicit = run(cachedLauncher, ["dashboard"], { HOME: home, WORK_INTELLIGENCE_HOME: unbuilt });
    expect(explicit.status).toBe(1);
    expect(existsSync(desktop.appArguments)).toBe(false);
    rmSync(desktop.appExecutable);
    const gone = run(cachedLauncher, ["dashboard"], { HOME: home, WORK_INTELLIGENCE_HOME: join(home, "none") });
    expect(gone.status).toBe(1);
    expect(existsSync(desktop.appArguments)).toBe(false);
  });

  it("refuses a record, runtime or shim owned by another user", async () => {
    const home = temporaryDirectory();
    await fakeDesktop(home);
    const options = { environment: { WORK_INTELLIGENCE_CONFIG_DIR: join(home, ".work-intelligence") }, home };
    const uid = process.getuid?.() ?? 0;
    expect(resolveDesktopLauncher("mcp", { ...options, uid })).toBeDefined();
    expect(resolveDesktopLauncher("mcp", { ...options, uid: uid + 1 })).toBeUndefined();
  });

  it("does not hand the dashboard to an App executable that is a symlink", async () => {
    const home = temporaryDirectory();
    const desktop = await fakeDesktop(home);
    const real = join(home, "real-app");
    writeFileSync(real, APP_STUB, { mode: 0o755 });
    rmSync(desktop.appExecutable);
    symlinkSync(real, desktop.appExecutable);
    const result = run(cachedPluginLauncher(home), ["dashboard"], { HOME: home });
    expect(result.status).toBe(1);
    expect(existsSync(desktop.appArguments)).toBe(false);
  });

  it("says why it did not use a launcher whose runtime is not ready, and starts the checkout instead", async () => {
    const home = temporaryDirectory();
    const desktop = await fakeDesktop(home);
    rmSync(join(desktop.runtimeRoot, "current"));
    const repository = fakeRepository(join(home, "checkout"));
    writeFileSync(join(home, ".work-intelligence/plugin-link.json"), JSON.stringify({ repositoryRoot: repository }));
    const cached = join(home, "cache/work-intelligence");
    cpSync(pluginRoot, cached, { recursive: true });
    const result = run(join(cached, "scripts/launch.mjs"), ["mcp"], { HOME: home }, "x");
    expect(JSON.parse(result.stdout)).toMatchObject({ name: "mcp", input: "x" });
    expect(result.stderr).toContain("launcher is not used");
    expect(result.stderr).toContain("current");
    // A hook stays silent.
    expect(run(join(cached, "scripts/launch.mjs"), ["finalize-reminder"], { HOME: home }, "{}").stderr).toBe("");
  });

  it("passes a user-configured WORK_INTELLIGENCE_DB through the launcher to the server", async () => {
    const home = temporaryDirectory();
    await fakeDesktop(home, { shim: `#!/bin/sh\nprintf '%s' "$WORK_INTELLIGENCE_DB"\n` });
    const database = join(home, "chosen.sqlite");
    expect(run(launcher, ["mcp"], { HOME: home, WORK_INTELLIGENCE_DB: database }).stdout).toBe(database);
  });

  describe("the MCPB start script", () => {
    function extension(home: string): string {
      const root = join(home, "mcpb");
      mkdirSync(join(root, "scripts"), { recursive: true });
      mkdirSync(join(root, "server/apps/mcp/dist"), { recursive: true });
      cpSync(join(repositoryRoot, "scripts/mcpb-launch.mjs"), join(root, "scripts/launch.mjs"));
      cpSync(join(pluginRoot, "scripts/desktop-integration.mjs"), join(root, "scripts/desktop-integration.mjs"));
      writeFileSync(join(root, "server/apps/mcp/dist/index.js"), 'process.stdout.write("bundled");\n');
      return join(root, "scripts/launch.mjs");
    }

    it("runs the App's launcher when its runtime is ready and the bundled server when it is not", async () => {
      const home = temporaryDirectory();
      const desktop = await fakeDesktop(home);
      const script = extension(home);
      expect(run(script, [], { HOME: home }, "x").stdout).toBe("launcher:mcp:x");
      rmSync(join(desktop.runtimeRoot, "current"));
      const fallback = run(script, [], { HOME: home }, "x");
      expect(fallback.stdout).toBe("bundled");
      expect(fallback.stderr).toContain("launcher is not used");
    });
  });

  describe("runDesktopLauncher with an injected spawn", () => {
    /** The process object and the child a launcher run touches, with what they recorded. */
    function fakes() {
      const host = Object.assign(new EventEmitter(), { exitCode: undefined as number | undefined });
      const child = Object.assign(new EventEmitter(), {
        pid: 777,
        exitCode: null as number | null,
        signalCode: null as string | null,
        killed: false,
        kill() {
          this.killed = true;
          return true;
        },
      });
      return { host: host as unknown as NodeJS.Process, child };
    }
    const launcherPlan = { command: "launcher", args: ["x"], windowsVerbatimArguments: false };

    it("keeps a hook at exit 0 and an mcp start at exit 1 with a stderr line when spawn throws", () => {
      const spawnProcess = () => {
        throw new Error("EAGAIN");
      };
      const stderr = vi.spyOn(nodeConsole, "error").mockImplementation(() => undefined);
      const hook = fakes();
      runDesktopLauncher(launcherPlan, { hook: true, spawnProcess, host: hook.host });
      expect(hook.host.exitCode).toBe(0);
      expect(stderr).not.toHaveBeenCalled();
      const mcp = fakes();
      runDesktopLauncher(launcherPlan, { hook: false, spawnProcess, host: mcp.host });
      expect(mcp.host.exitCode).toBe(1);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("EAGAIN"));
      stderr.mockRestore();
    });

    /** Runs a hook that times out on "Windows"; `taskkill` decides how the injected killer ends. */
    async function timeOutOnWindows(options: { exited?: boolean; taskkill?: "ok" | "fails" | "missing" }) {
      const { host, child } = fakes();
      if (options.exited) child.exitCode = 0;
      const killers: Array<{ file: string; args: readonly string[] }> = [];
      const spawnProcess = (file: string, args: readonly string[]) => {
        if (file === launcherPlan.command) return child;
        killers.push({ file, args });
        const killer = new EventEmitter();
        queueMicrotask(() => {
          if (options.taskkill === "missing") killer.emit("error", new Error("ENOENT"));
          else killer.emit("exit", options.taskkill === "fails" ? 128 : 0);
        });
        return killer;
      };
      runDesktopLauncher(launcherPlan, {
        hook: true,
        timeoutMs: 5,
        platform: "win32",
        environment: { SystemRoot: "C:\\Windows" },
        spawnProcess,
        host,
      });
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      return { child, killers };
    }

    it("stops the whole tree of a hung hook with System32 taskkill /T /F on Windows", async () => {
      const { child, killers } = await timeOutOnWindows({ taskkill: "ok" });
      expect(killers).toEqual([{ file: "C:\\Windows\\System32\\taskkill.exe", args: ["/PID", "777", "/T", "/F"] }]);
      expect(child.killed).toBe(false);
    });

    it.each(["fails", "missing"] as const)("falls back to killing the child when taskkill %s", async (taskkill) => {
      expect((await timeOutOnWindows({ taskkill })).child.killed).toBe(true);
    });

    it("kills nothing once the child has exited (its pid may be reused)", async () => {
      const { child, killers } = await timeOutOnWindows({ exited: true, taskkill: "ok" });
      expect(killers).toEqual([]);
      expect(child.killed).toBe(false);
    });
  });

  describe("pnpm dashboard with the App recorded", () => {
    const dashboardScript = join(repositoryRoot, "scripts/dashboard.mjs");

    async function listen(handler: Parameters<typeof createServer>[1]) {
      const server = createServer(handler);
      await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      return { port, close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())) };
    }

    it("prints the URL of a server that already answers and does not start the App", async () => {
      const home = temporaryDirectory();
      const desktop = await fakeDesktop(home);
      const answering = await listen((request, response) => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(request.url === "/api/health" ? { ok: true, database: "ok" } : {}));
      });
      try {
        const result = await spawnAsync(dashboardScript, {
          HOME: home,
          WORK_INTELLIGENCE_PORT: String(answering.port),
        });
        expect(result.stdout).toBe(`Dashboard: http://127.0.0.1:${answering.port}\n`);
        await new Promise((resolveWait) => setTimeout(resolveWait, 300));
        expect(existsSync(desktop.appArguments)).toBe(false);
      } finally {
        await answering.close();
      }
    });

    it("hands over to the App when the port is busy with something that is not Work Intelligence", async () => {
      const home = temporaryDirectory();
      const desktop = await fakeDesktop(home);
      const busy = await listen((_request, response) => response.end("not us"));
      try {
        const result = await spawnAsync(dashboardScript, { HOME: home, WORK_INTELLIGENCE_PORT: String(busy.port) });
        expect(result.stdout).toContain("The App opens the Dashboard");
        expect(await waitForFile(desktop.appArguments)).toBe("--open-dashboard\n");
      } finally {
        await busy.close();
      }
    });
  });

  it("starts the App without the Electron host variables an Agent app may carry", async () => {
    const home = temporaryDirectory();
    const desktop = await fakeDesktop(home);
    writeFileSync(
      desktop.appExecutable,
      '#!/bin/sh\nprintf \'%s|%s\' "${ELECTRON_RUN_AS_NODE-unset}" "${ELECTRON_NO_ASAR-unset}" > "$(dirname "$0")/app-arguments.txt"\n',
      { mode: 0o755 },
    );
    run(cachedPluginLauncher(home), ["dashboard"], { HOME: home, ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ASAR: "1" });
    expect(await waitForFile(desktop.appArguments)).toBe("unset|unset");
  });
});

describe("pnpm plugin:link", () => {
  it("records this checkout and removes the link on request", () => {
    const home = temporaryDirectory();
    const configDirectory = join(home, "config");
    const environment = { HOME: home, WORK_INTELLIGENCE_CONFIG_DIR: configDirectory };
    const linked = run(linkScript, [], environment);
    expect(linked.status).toBe(0);
    expect(readJson(join(configDirectory, "plugin-link.json"))).toEqual({ repositoryRoot });
    const removed = run(linkScript, ["--remove"], environment);
    expect(removed.stdout).toContain("Removed");
    expect(existsSync(join(configDirectory, "plugin-link.json"))).toBe(false);
    expect(run(linkScript, ["--remove"], environment).stdout).toContain("No plugin link");
  });
});

describe("doctor with the Claude Code plugin", () => {
  it("recognises the enabled plugin from settings.json", () => {
    expect(claudePluginEnabled({ enabledPlugins: { "work-intelligence@worklog-ai": true } })).toBe(true);
    expect(claudePluginEnabled({ enabledPlugins: { "work-intelligence@worklog-ai": false } })).toBe(false);
    expect(claudePluginEnabled({ enabledPlugins: { "other@worklog-ai": true } })).toBe(false);
    expect(claudePluginEnabled(undefined)).toBe(false);
  });

  async function claudeFindings(registered: boolean) {
    const home = temporaryDirectory();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude/settings.json"),
      JSON.stringify({ enabledPlugins: { "work-intelligence@worklog-ai": true } }),
    );
    if (registered) {
      // A checkout registration: the launcher the entry names exists.
      const launcher = join(home, "apps/mcp/dist/launcher.js");
      mkdirSync(dirname(launcher), { recursive: true });
      writeFileSync(launcher, "");
      writeFileSync(
        join(home, ".claude.json"),
        JSON.stringify({ mcpServers: { "work-intelligence": { command: "node", args: [launcher] } } }),
      );
    }
    const findings = await collectDoctorFindings({
      homeDirectory: home,
      userServiceStatus: isolatedUserServiceStatus(home),
      repositoryRoot: home,
      environment: {
        HOME: home,
        CODEX_HOME: join(home, ".codex"),
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        WORK_INTELLIGENCE_DB: join(home, "synthetic.sqlite"),
        WORK_INTELLIGENCE_PORT: "65532",
      },
    });
    return findings.filter((finding) => finding.title.startsWith("Claude"));
  }

  it("counts the plugin as the Claude connection instead of asking for a manual registration", async () => {
    const findings = await claudeFindings(false);
    expect(findings.find((finding) => finding.title === "Claude Code plugin")).toMatchObject({ severity: "ok" });
    expect(findings.map((finding) => finding.title)).not.toContain("Claude MCP");
  });

  it("warns when the plugin and the manual registration would both load", async () => {
    const findings = await claudeFindings(true);
    expect(findings.find((finding) => finding.title === "Claude Code plugin")).toMatchObject({
      severity: "warning",
      recommendation: expect.stringMatching(
        /pnpm setup:agents --uninstall.*claude mcp remove work-intelligence --scope user/,
      ),
    });
  });
});

describe("doctor with the Codex plugin", () => {
  it("recognises the enabled plugin from config.toml", () => {
    expect(codexPluginEnabled({ plugins: { "work-intelligence@worklog-ai": { enabled: true } } })).toBe(true);
    expect(codexPluginEnabled({ plugins: { "work-intelligence@worklog-ai": { enabled: false } } })).toBe(false);
    expect(codexPluginEnabled({ plugins: { "slack@openai-curated": { enabled: true } } })).toBe(false);
    expect(codexPluginEnabled(undefined)).toBe(false);
  });

  async function codexFindings(registered: boolean, manualHooks = false) {
    const home = temporaryDirectory();
    mkdirSync(join(home, ".codex"), { recursive: true });
    // The repository publishes the skill; only the user-scope copies are missing, as after setup:agents --uninstall.
    const repositoryRoot = join(home, "repository");
    mkdirSync(join(repositoryRoot, ".agents/skills/work-intelligence"), { recursive: true });
    writeFileSync(join(repositoryRoot, ".agents/skills/work-intelligence/SKILL.md"), "skill\n");
    if (manualHooks) {
      // What setup:agents writes to ~/.codex/hooks.json, pointing at the checkout's built reminder.
      const script = join(repositoryRoot, "apps/mcp/dist/codex-finalize-reminder.js");
      mkdirSync(dirname(script), { recursive: true });
      writeFileSync(script, "");
      const handler = [{ type: "command", command: commandForAgentHook(script) }];
      writeFileSync(
        join(home, ".codex/hooks.json"),
        JSON.stringify({
          hooks: {
            PostToolUse: [{ matcher: CODEX_POST_TOOL_USE_MATCHER, hooks: handler }],
            Stop: [{ hooks: handler }],
          },
        }),
      );
    }
    const launcher = join(repositoryRoot, "apps/mcp/dist/launcher.js");
    if (registered) {
      mkdirSync(dirname(launcher), { recursive: true });
      writeFileSync(launcher, "");
    }
    writeFileSync(
      join(home, ".codex/config.toml"),
      [
        '[plugins."work-intelligence@worklog-ai"]',
        "enabled = true",
        ...(registered
          ? ["", "[mcp_servers.work-intelligence]", 'command = "node"', `args = [${JSON.stringify(launcher)}]`]
          : []),
        "",
      ].join("\n"),
    );
    const findings = await collectDoctorFindings({
      homeDirectory: home,
      userServiceStatus: isolatedUserServiceStatus(home),
      repositoryRoot,
      environment: {
        HOME: home,
        CODEX_HOME: join(home, ".codex"),
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        WORK_INTELLIGENCE_DB: join(home, "synthetic.sqlite"),
        WORK_INTELLIGENCE_PORT: "65532",
      },
    });
    return findings.filter((finding) => finding.title.startsWith("Codex"));
  }

  it("counts the plugin as the Codex MCP and skill instead of asking for setup:agents", async () => {
    const findings = await codexFindings(false);
    expect(findings.find((finding) => finding.title === "Codex plugin")).toMatchObject({ severity: "ok" });
    expect(findings.map((finding) => finding.title)).not.toContain("Codex MCP");
    expect(findings.some((finding) => finding.title.includes("skill"))).toBe(false);
    // The plugin brings the save-reminder hooks, so a missing hooks.json entry is not a problem either.
    expect(findings.map((finding) => finding.title)).not.toContain("Codex 全域 hook");
  });

  it("warns when the plugin and a config.toml registration would both load", async () => {
    const findings = await codexFindings(true);
    expect(findings.find((finding) => finding.title === "Codex plugin")).toMatchObject({
      severity: "warning",
      recommendation: expect.stringContaining("codex mcp remove work-intelligence"),
    });
  });

  it("warns when hooks.json still runs the save reminder the plugin already brings", async () => {
    const findings = await codexFindings(false, true);
    expect(findings.find((finding) => finding.title === "Codex plugin")).toMatchObject({
      severity: "warning",
      recommendation: expect.stringContaining("codex-finalize-reminder.js"),
    });
    expect(findings.map((finding) => finding.title)).not.toContain("Codex 全域 hook");
  });
});
