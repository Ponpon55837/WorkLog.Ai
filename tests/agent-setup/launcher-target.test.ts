import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyAgentSetupPlan,
  createAgentSetupPlan,
  inspectAgentRegistrations,
  type AgentSetupPlanOptions,
} from "@work-intelligence/agent-setup";
import { commandWords } from "../../packages/agent-setup/src/commands.js";
import { createFixture, readJson, removeFixtures, writeJson, type SetupFixture } from "./fixture.js";

const WINDOWS_SHIM = "C:\\Users\\測試 使用者\\AppData\\Local\\Work Intelligence\\bin\\work-intelligence-launcher.cmd";
const POSIX_SHIM = "/home/測試 使用者/Work Intelligence's/bin/work-intelligence-launcher";

function launcherOptions(fixture: SetupFixture, platform: NodeJS.Platform, shimPath: string): AgentSetupPlanOptions {
  return {
    ...fixture.options,
    platform,
    target: { kind: "launcher", shimPath, skillSourcePath: fixture.paths.skillSource },
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object");
  return value as Record<string, unknown>;
}

function commandsOf(file: string, event: string): string[] {
  const entries = object(readJson(file).hooks)[event] as { hooks: { command: string }[] }[];
  return entries.flatMap((entry) => entry.hooks.map((hook) => hook.command));
}

afterEach(removeFixtures);

describe.each([
  ["win32", WINDOWS_SHIM, (shim: string, action: string) => `"${shim}" ${action}`],
  ["linux", POSIX_SHIM, (shim: string, action: string) => `'${shim.replaceAll("'", "'\\''")}' ${action}`],
] as const)("launcher target on %s", (platform, shim, hookCommand) => {
  it("registers the shim for MCP and both Agents' finalize hooks, quoting paths with spaces and non-ASCII", () => {
    const fixture = createFixture();
    const options = launcherOptions(fixture, platform, shim);
    const plan = createAgentSetupPlan(options);
    expect(plan.conflicts).toEqual([]);
    expect(applyAgentSetupPlan(plan).applied).toBe(true);

    expect(object(object(readJson(fixture.paths.claudeJson).mcpServers)["work-intelligence"])).toEqual({
      type: "stdio",
      command: shim,
      args: ["mcp"],
    });
    const toml = readFileSync(fixture.paths.codexConfig, "utf8");
    expect(toml).toContain(`command = ${JSON.stringify(shim)}`);
    expect(toml).toContain('args = ["mcp"]');
    expect(commandsOf(fixture.paths.claudeSettings, "Stop")).toEqual([hookCommand(shim, "claude-finalize-reminder")]);
    for (const event of ["Stop", "UserPromptSubmit", "PreToolUse", "PostToolUse", "SessionStart"]) {
      expect(commandsOf(fixture.paths.codexHooks, event)).toEqual([hookCommand(shim, "codex-finalize-reminder")]);
    }
    // The command round-trips through the same splitter the inspector uses.
    expect(commandWords(hookCommand(shim, "claude-finalize-reminder"))).toEqual([shim, "claude-finalize-reminder"]);
    expect(readFileSync(fixture.paths.codexSkill, "utf8")).toBe(readFileSync(fixture.paths.skillSource, "utf8"));
  });

  it("is idempotent and recognises its own registrations as desktop-managed", () => {
    const fixture = createFixture();
    const options = launcherOptions(fixture, platform, shim);
    expect(applyAgentSetupPlan(createAgentSetupPlan(options)).applied).toBe(true);

    const again = createAgentSetupPlan(options);
    expect(again.mutations).toEqual([]);
    expect(again.conflicts).toEqual([]);
    const inspection = inspectAgentRegistrations(options);
    expect(inspection.duplicates).toEqual([]);
    expect(inspection.registrations.map((item) => `${item.agent}:${item.kind}:${item.source}`).sort()).toEqual([
      "claude-code:hook:desktop-managed",
      "claude-code:mcp:desktop-managed",
      "codex:hook:desktop-managed",
      "codex:mcp:desktop-managed",
    ]);
  });

  it("uninstalls what it installed and leaves user entries", () => {
    const fixture = createFixture();
    const options = launcherOptions(fixture, platform, shim);
    expect(applyAgentSetupPlan(createAgentSetupPlan(options)).applied).toBe(true);
    const removal = createAgentSetupPlan(options, "uninstall");
    expect(removal.conflicts).toEqual([]);
    expect(applyAgentSetupPlan(removal).applied).toBe(true);
    expect(object(readJson(fixture.paths.claudeJson).mcpServers)["work-intelligence"]).toBeUndefined();
    expect(object(readJson(fixture.paths.claudeJson).mcpServers).existing).toBeDefined();
    expect(readFileSync(fixture.paths.codexConfig, "utf8")).not.toContain("work-intelligence");
  });
});

describe("launcher target safety", () => {
  it("rejects a relative shim path and does not require a checkout build", () => {
    const fixture = createFixture();
    const relative = createAgentSetupPlan(launcherOptions(fixture, "linux", "bin/work-intelligence-launcher"));
    expect(relative.conflicts.join(" ")).toContain("絕對路徑");

    const fresh = createFixture();
    writeFileSync(join(fresh.options.repositoryRoot, "apps", "mcp", "dist", "launcher.js"), "x");
    const plan = createAgentSetupPlan({
      ...launcherOptions(fresh, "linux", POSIX_SHIM),
      repositoryRoot: join(fresh.temporaryRoot, "no-checkout"),
    });
    expect(plan.conflicts).toEqual([]);
  });

  it("reports a missing App skill instead of installing an empty one", () => {
    const fixture = createFixture();
    const options = launcherOptions(fixture, "linux", POSIX_SHIM);
    const plan = createAgentSetupPlan({
      ...options,
      target: { kind: "launcher", shimPath: POSIX_SHIM, skillSourcePath: join(fixture.temporaryRoot, "missing.md") },
    });
    expect(plan.conflicts.join(" ")).toContain("找不到可安裝的 work-intelligence skill");
  });

  it("migrates an owned checkout install to the launcher without a second registration", () => {
    const fixture = createFixture();
    expect(applyAgentSetupPlan(createAgentSetupPlan(fixture.options)).applied).toBe(true);
    const plan = createAgentSetupPlan(launcherOptions(fixture, "linux", POSIX_SHIM));
    expect(plan.conflicts).toEqual([]);
    expect(applyAgentSetupPlan(plan).applied).toBe(true);
    expect(commandsOf(fixture.paths.claudeSettings, "Stop")).toHaveLength(1);
    expect(commandsOf(fixture.paths.claudeSettings, "Stop")[0]).toContain("work-intelligence-launcher");
    expect(inspectAgentRegistrations(fixture.options).duplicates).toEqual([]);
  });

  it("refuses a launcher plan beside hand-written checkout registrations instead of adding a second one", () => {
    const fixture = createFixture();
    expect(applyAgentSetupPlan(createAgentSetupPlan(fixture.options)).applied).toBe(true);
    // Drop the ownership record so the checkout entries count as hand-written.
    writeFileSync(fixture.paths.manifest, JSON.stringify({ version: 2, components: [] }));
    const plan = createAgentSetupPlan(launcherOptions(fixture, "linux", POSIX_SHIM));
    expect(plan.conflicts.length).toBeGreaterThan(0);
    expect(plan.mutations.every((mutation) => !mutation.path.endsWith("settings.json"))).toBe(true);
  });

  it("refuses a checkout plan beside a desktop-managed hook instead of adding a second one", () => {
    const fixture = createFixture();
    const shim = POSIX_SHIM;
    writeJson(fixture.paths.claudeSettings, {
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: `'${shim.replaceAll("'", "'\\''")}' claude-finalize-reminder` }] },
        ],
      },
    });
    mkdirSync(dirname(fixture.paths.claudeSettings), { recursive: true });
    const plan = createAgentSetupPlan(fixture.options);
    expect(plan.conflicts.join(" ")).toContain("Claude Stop hook");
  });
});
