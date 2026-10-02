import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const version = (JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as { version: string }).version;
const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bundle-test", version: "1" } },
});
const SKILL = JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  method: "resources/read",
  params: { uri: "work-intelligence://agent/work-intelligence/SKILL.md" },
});
let output: string;

/** The test runner's environment (Windows needs SystemRoot and friends) without any Work Intelligence location. */
function environmentFor(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const inherited = { ...process.env };
  for (const name of ["WORK_INTELLIGENCE_HOME", "WORK_INTELLIGENCE_CONFIG_DIR", "WORK_INTELLIGENCE_DB"]) {
    delete inherited[name];
  }
  return { ...inherited, HOME: home, USERPROFILE: home, ...extra };
}

/** Runs the copied plugin's MCP server through its launcher and returns the JSON-RPC responses by id. */
function talkToPlugin(pluginRoot: string, home: string, extra: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [join(pluginRoot, "scripts/launch.mjs"), "mcp"], {
    input: `${INITIALIZE}\n${SKILL}\n`,
    encoding: "utf8",
    env: environmentFor(home, extra),
    cwd: home,
    timeout: 30_000,
  });
  const responses = new Map<number, { result?: Record<string, unknown> }>();
  for (const line of result.stdout.split("\n").filter(Boolean)) {
    const message = JSON.parse(line) as { id?: number; result?: Record<string, unknown> };
    if (typeof message.id === "number") responses.set(message.id, message);
  }
  return { responses, stderr: result.stderr };
}

function copyPlugin(home: string): string {
  const target = join(home, "plugin-cache/work-intelligence");
  cpSync(join(output, "work-intelligence"), target, { recursive: true });
  return target;
}

beforeAll(() => {
  output = mkdtempSync(join(tmpdir(), "work-intelligence-plugin-build-"));
  const build = spawnSync(process.execPath, [join(repositoryRoot, "scripts/build-plugin.mjs"), output], {
    encoding: "utf8",
  });
  if (build.status !== 0) throw new Error(`build-plugin failed: ${build.stderr}`);
}, 120_000);

afterAll(() => {
  rmSync(output, { recursive: true, force: true });
});

describe("pnpm build:plugin", () => {
  it("writes the plugin, its zip and a Claude Desktop extension", () => {
    expect(existsSync(join(output, "work-intelligence/server/apps/mcp/dist/index.js"))).toBe(true);
    expect(existsSync(join(output, "work-intelligence/server/apps/mcp/dist/finalize-reminder.js"))).toBe(true);
    expect(existsSync(join(output, "work-intelligence/server/apps/mcp/dist/codex-finalize-reminder.js"))).toBe(true);
    expect(
      readFileSync(join(output, "work-intelligence/server/.agents/skills/work-intelligence/SKILL.md"), "utf8"),
    ).toBe(readFileSync(join(repositoryRoot, ".agents/skills/work-intelligence/SKILL.md"), "utf8"));
    const extension = readFileSync(join(output, `work-intelligence-${version}.mcpb`));
    for (const name of [
      "manifest.json",
      "server/apps/mcp/dist/index.js",
      "server/docs/work-record-and-report-format.md",
    ]) {
      expect(extension.includes(Buffer.from(name))).toBe(true);
    }
    expect(existsSync(join(output, `work-intelligence-plugin-${version}.zip`))).toBe(true);
  });

  it("bundles a server that runs with no checkout and keeps its database in the user's directory", () => {
    const home = mkdtempSync(join(tmpdir(), "work-intelligence-plugin-home-"));
    try {
      const { responses, stderr } = talkToPlugin(copyPlugin(home), home);
      expect(responses.get(1)?.result?.serverInfo).toEqual({ name: "work-intelligence", version });
      const skill = (responses.get(2)?.result?.contents as Array<{ text: string }> | undefined)?.[0]?.text;
      expect(skill).toContain("name: work-intelligence");
      expect(stderr).toContain(join(home, ".work-intelligence", "data", "work-intelligence.sqlite"));
      expect(existsSync(join(home, ".work-intelligence", "data", "work-intelligence.sqlite"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  it("opens the linked checkout's database when that checkout is not built", () => {
    const home = mkdtempSync(join(tmpdir(), "work-intelligence-plugin-home-"));
    try {
      const checkout = join(home, "checkout");
      mkdirSync(join(checkout, "apps/mcp"), { recursive: true });
      mkdirSync(join(checkout, "packages/shared"), { recursive: true });
      writeFileSync(join(checkout, "pnpm-workspace.yaml"), "");
      writeFileSync(join(checkout, "apps/mcp/package.json"), "{}");
      writeFileSync(join(checkout, "packages/shared/package.json"), "{}");
      const { responses, stderr } = talkToPlugin(copyPlugin(home), home, { WORK_INTELLIGENCE_HOME: checkout });
      expect(responses.get(1)?.result?.serverInfo).toMatchObject({ name: "work-intelligence" });
      expect(stderr).toContain(join(checkout, "data", "work-intelligence.sqlite"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
