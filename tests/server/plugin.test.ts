import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CODEX_POST_TOOL_USE_MATCHER, commandForAgentHook } from "../../apps/server/src/agent-setup.js";
import { claudePluginEnabled, codexPluginEnabled, collectDoctorFindings } from "../../apps/server/src/doctor.js";
import type { UserServiceStatus } from "../../packages/core/src/index.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pluginRoot = join(repositoryRoot, "plugins/work-intelligence");
const launcher = join(pluginRoot, "scripts/launch.mjs");
const linkScript = join(repositoryRoot, "scripts/plugin-link.mjs");
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "work-intelligence-plugin-"));
  temporaryDirectories.push(directory);
  return directory;
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
  for (const name of ["WORK_INTELLIGENCE_HOME", "WORK_INTELLIGENCE_CONFIG_DIR", "WORK_INTELLIGENCE_DB"]) {
    delete inherited[name];
  }
  return inherited;
}

function run(script: string, args: string[], environment: NodeJS.ProcessEnv, input = "") {
  return spawnSync(process.execPath, [script, ...args], {
    input,
    encoding: "utf8",
    env: { ...inheritedEnvironment(), USERPROFILE: environment.HOME, ...environment },
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
        UserPromptSubmit: [{ hooks: handler }],
      },
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

  it("carry the README the Anthropic directory requires: at least 40 words outside code blocks", () => {
    const readme = readFileSync(join(pluginRoot, "README.md"), "utf8").replace(/```[\s\S]*?```/g, "");
    expect(readme.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(40);
    expect(readJson(join(pluginRoot, ".claude-plugin/plugin.json")).license).toBe("MIT");
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
      writeFileSync(
        join(home, ".claude.json"),
        JSON.stringify({ mcpServers: { "work-intelligence": { command: "node", args: ["index.js"] } } }),
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
    writeFileSync(
      join(home, ".codex/config.toml"),
      [
        '[plugins."work-intelligence@worklog-ai"]',
        "enabled = true",
        ...(registered ? ["", "[mcp_servers.work-intelligence]", 'command = "node"', 'args = ["index.js"]'] : []),
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
