import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyAgentSetupPlan,
  createAgentSetupPlan,
  inspectAgentRegistrations,
  type AgentRegistrationInspection,
} from "@work-intelligence/agent-setup";
import { createFixture, readJson, removeFixtures, writeJson } from "./fixture.js";

const SHIM = "/opt/Work Intelligence/bin/work-intelligence-launcher";

function summary(inspection: AgentRegistrationInspection): string[] {
  return inspection.registrations.map((item) => `${item.agent}:${item.kind}:${item.source}`).sort();
}

afterEach(removeFixtures);

describe("inspectAgentRegistrations", () => {
  it("reports nothing for a clean home", () => {
    const fixture = createFixture();
    expect(inspectAgentRegistrations(fixture.options)).toEqual({ registrations: [], duplicates: [], unreadable: [] });
  });

  it("classifies a setup:agents checkout install as manual", () => {
    const fixture = createFixture();
    expect(applyAgentSetupPlan(createAgentSetupPlan(fixture.options)).applied).toBe(true);
    const inspection = inspectAgentRegistrations(fixture.options);
    expect(summary(inspection)).toEqual([
      "claude-code:hook:manual",
      "claude-code:mcp:manual",
      "codex:hook:manual",
      "codex:mcp:manual",
    ]);
    expect(inspection.duplicates).toEqual([]);
    expect(inspection.registrations.every((item) => item.location.startsWith(fixture.options.homeDirectory))).toBe(
      true,
    );
  });

  it("flags a plugin plus a manual registration as duplicate MCP and hooks for that Agent only", () => {
    const fixture = createFixture();
    expect(applyAgentSetupPlan(createAgentSetupPlan(fixture.options)).applied).toBe(true);
    writeJson(fixture.paths.claudeSettings, {
      ...readJson(fixture.paths.claudeSettings),
      enabledPlugins: { "work-intelligence@fixture": true },
    });

    const inspection = inspectAgentRegistrations(fixture.options);

    expect(inspection.duplicates).toEqual([
      { code: "duplicate-registration", agent: "claude-code", kind: "mcp", sources: ["manual", "plugin"] },
      { code: "duplicate-registration", agent: "claude-code", kind: "hook", sources: ["manual", "plugin"] },
    ]);
  });

  it("surfaces the duplicate as a plan finding without adding a second registration", () => {
    const fixture = createFixture();
    expect(applyAgentSetupPlan(createAgentSetupPlan(fixture.options)).applied).toBe(true);
    writeFileSync(
      fixture.paths.codexConfig,
      `${readFileSync(fixture.paths.codexConfig, "utf8")}\n[plugins."work-intelligence@fixture"]\nenabled = true\n`,
    );

    const plan = createAgentSetupPlan(fixture.options);

    expect(plan.findings).toEqual([
      { code: "duplicate-registration", agent: "codex", kind: "mcp", sources: ["manual", "plugin"] },
      { code: "duplicate-registration", agent: "codex", kind: "hook", sources: ["manual", "plugin"] },
    ]);
    expect(plan.mutations.every((mutation) => !mutation.path.includes(".codex"))).toBe(true);
    expect(plan.conflicts).toEqual([]);
  });

  it("flags a desktop-managed registration beside a manual one", () => {
    const fixture = createFixture();
    writeJson(fixture.paths.claudeJson, {
      mcpServers: { "work-intelligence": { type: "stdio", command: SHIM, args: ["mcp"] } },
    });
    writeJson(fixture.paths.claudeSettings, {
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: `'${SHIM}' claude-finalize-reminder` }] },
          { hooks: [{ type: "command", command: "node '/repo/apps/mcp/dist/finalize-reminder.js'" }] },
        ],
      },
    });
    const inspection = inspectAgentRegistrations(fixture.options);
    expect(summary(inspection)).toEqual([
      "claude-code:hook:desktop-managed",
      "claude-code:hook:manual",
      "claude-code:mcp:desktop-managed",
    ]);
    expect(inspection.duplicates).toEqual([
      { code: "duplicate-registration", agent: "claude-code", kind: "hook", sources: ["desktop-managed", "manual"] },
    ]);
  });

  it("finds Claude Desktop manual stdio and MCPB registrations and an unknown entry shape", () => {
    const fixture = createFixture();
    const desktop = join(fixture.temporaryRoot, "claude-desktop");
    mkdirSync(desktop, { recursive: true });
    writeJson(join(desktop, "claude_desktop_config.json"), {
      mcpServers: { "work-intelligence": { command: "node", args: ["/repo/apps/mcp/dist/launcher.js"] } },
    });
    writeJson(join(desktop, "extensions-installations.json"), { extensions: { "work-intelligence-mcpb": {} } });
    writeJson(fixture.paths.claudeJson, { mcpServers: { "work-intelligence": "not an object" } });

    const inspection = inspectAgentRegistrations({ ...fixture.options, claudeDesktopConfigDirectory: desktop });

    expect(summary(inspection)).toEqual([
      "claude-code:mcp:unknown",
      "claude-desktop:mcp:manual",
      "claude-desktop:mcp:mcpb",
    ]);
    expect(inspection.duplicates).toEqual([
      { code: "duplicate-registration", agent: "claude-desktop", kind: "mcp", sources: ["manual", "mcpb"] },
    ]);
  });

  it("uses the per-platform Claude Desktop directory by default", () => {
    const fixture = createFixture();
    const directories = {
      win32: join("AppData", "Roaming", "Claude"),
      darwin: join("Library", "Application Support", "Claude"),
      linux: join(".config", "Claude"),
    } as const;
    for (const [platform, relative] of Object.entries(directories)) {
      const directory = join(fixture.options.homeDirectory, relative);
      mkdirSync(directory, { recursive: true });
      writeJson(join(directory, "claude_desktop_config.json"), {
        mcpServers: { "work-intelligence": { command: "x" } },
      });
      const inspection = inspectAgentRegistrations({ ...fixture.options, platform: platform as NodeJS.Platform });
      expect(inspection.registrations.map((item) => item.location)).toEqual([
        join(directory, "claude_desktop_config.json"),
      ]);
    }
  });

  it("reports files that exist but do not parse without claiming a registration", () => {
    const fixture = createFixture();
    writeFileSync(fixture.paths.codexConfig, "this = = not toml");
    writeFileSync(fixture.paths.claudeJson, "{ nope");
    mkdirSync(join(fixture.options.homeDirectory, ".claude"), { recursive: true });
    writeFileSync(fixture.paths.claudeSettings, "[]");
    const inspection = inspectAgentRegistrations(fixture.options);
    expect(inspection.registrations).toEqual([]);
    expect(inspection.unreadable.sort()).toEqual(
      [fixture.paths.codexConfig, fixture.paths.claudeJson, fixture.paths.claudeSettings].sort(),
    );
  });
});
