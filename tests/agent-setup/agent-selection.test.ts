import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { applyAgentSetupPlan, createAgentSetupPlan, type AgentSetupPlanOptions } from "@work-intelligence/agent-setup";
import { createFixture, removeFixtures, type SetupFixture } from "./fixture.js";

const SHIM = "/home/synthetic/Work Intelligence/bin/work-intelligence-launcher";

function launcherOptions(fixture: SetupFixture, extra: Partial<AgentSetupPlanOptions>): AgentSetupPlanOptions {
  return {
    ...fixture.options,
    platform: "linux",
    target: { kind: "launcher", shimPath: SHIM, skillSourcePath: fixture.paths.skillSource },
    ...extra,
  };
}

afterEach(removeFixtures);

function snapshot(fixture: SetupFixture): Record<string, string | undefined> {
  const read = (path: string): string | undefined =>
    existsSync(path) && statSync(path).isFile() ? readFileSync(path, "utf8") : undefined;
  return {
    codexConfig: read(fixture.paths.codexConfig),
    codexHooks: read(fixture.paths.codexHooks),
    claudeJson: read(fixture.paths.claudeJson),
    claudeSettings: read(fixture.paths.claudeSettings),
  };
}

describe("installing for selected Agents only", () => {
  it("leaves Codex's files as they were when only Claude Code is selected", () => {
    const fixture = createFixture();
    const before = snapshot(fixture);
    const plan = createAgentSetupPlan(launcherOptions(fixture, { agents: ["claude-code"] }));
    expect(plan.conflicts).toEqual([]);
    expect(applyAgentSetupPlan(plan).applied).toBe(true);
    const after = snapshot(fixture);
    expect(after.codexConfig).toBe(before.codexConfig);
    expect(after.codexHooks).toBe(before.codexHooks);
    expect(after.claudeJson).toContain("work-intelligence");
    expect(after.claudeSettings).toContain("claude-finalize-reminder");
  });

  it("leaves Claude Code's files as they were when only Codex is selected", () => {
    const fixture = createFixture();
    const before = snapshot(fixture);
    const plan = createAgentSetupPlan(launcherOptions(fixture, { agents: ["codex"] }));
    expect(plan.conflicts).toEqual([]);
    expect(applyAgentSetupPlan(plan).applied).toBe(true);
    const after = snapshot(fixture);
    expect(after.claudeJson).toBe(before.claudeJson);
    expect(after.claudeSettings).toBe(before.claudeSettings);
    expect(after.codexConfig).toContain("work-intelligence");
  });

  it("a conflict in an Agent that was not selected does not block the selected one", () => {
    const fixture = createFixture();
    // A directory where Codex's config belongs: Codex's side cannot be read, so it is refused as a whole.
    rmSync(fixture.paths.codexConfig);
    mkdirSync(fixture.paths.codexConfig);
    expect(createAgentSetupPlan(launcherOptions(fixture, {})).conflicts.length).toBeGreaterThan(0);
    const plan = createAgentSetupPlan(launcherOptions(fixture, { agents: ["claude-code"] }));
    expect(plan.conflicts).toEqual([]);
    expect(applyAgentSetupPlan(plan).applied).toBe(true);
    expect(snapshot(fixture).claudeJson).toContain("work-intelligence");
  });

  it("selecting both is the same plan as selecting nothing special", () => {
    const fixture = createFixture();
    const both = createAgentSetupPlan(launcherOptions(fixture, { agents: ["codex", "claude-code"] }));
    const defaults = createAgentSetupPlan(launcherOptions(fixture, {}));
    expect(both.mutations.map((entry) => entry.path)).toEqual(defaults.mutations.map((entry) => entry.path));
  });
});
