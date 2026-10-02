import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { claudePluginEnabled, collectDoctorFindings } from "../../apps/server/src/doctor.js";

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

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("plugin manifests", () => {
  const version = readJson(join(repositoryRoot, "package.json")).version;

  it("ship the repository version", () => {
    expect(readJson(join(pluginRoot, ".claude-plugin/plugin.json")).version).toBe(version);
    expect(readJson(join(pluginRoot, ".codex-plugin/plugin.json")).version).toBe(version);
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
      "work-intelligence": { command: "node", args: ["./scripts/launch.mjs", "mcp"] },
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
    const hook = run(script, ["finalize-reminder"], { HOME: home }, "{}");
    expect(hook).toMatchObject({ status: 0, stdout: "", stderr: "" });
    const unbuilt = fakeRepository(join(home, "unbuilt"), false);
    const notBuilt = run(script, ["mcp"], { HOME: home, WORK_INTELLIGENCE_HOME: unbuilt });
    expect(notBuilt.status).toBe(1);
    expect(notBuilt.stderr).toContain("run pnpm build");
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
      recommendation: expect.stringContaining("pnpm setup:agents --uninstall"),
    });
  });
});
