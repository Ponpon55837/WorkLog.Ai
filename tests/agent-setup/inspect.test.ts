import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyAgentSetupPlan,
  codexPluginHooksPresent,
  createAgentSetupPlan,
  inspectAgentRegistrations,
  projectCodexHooksRunFinalize,
  readCodexPluginHooksPresent,
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
    const inspection = inspectAgentRegistrations({ ...fixture.options, isFile: (path) => path === SHIM });
    expect(summary(inspection)).toEqual([
      "claude-code:hook:desktop-managed",
      "claude-code:hook:manual",
      "claude-code:mcp:desktop-managed",
    ]);
    // A shim that is gone is not the App's registration any more.
    expect(summary(inspectAgentRegistrations({ ...fixture.options, isFile: () => false }))).toContain(
      "claude-code:mcp:manual",
    );
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

describe("codexPluginHooksPresent", () => {
  it("counts an enabled plugin or trust state kept for a work-intelligence@ hook, and nothing else", () => {
    const state = (key: string) => ({ hooks: { state: { [key]: { trusted_hash: "sha256:synthetic" } } } });
    expect(codexPluginHooksPresent({ plugins: { "work-intelligence@market": { enabled: true } } })).toBe(true);
    expect(codexPluginHooksPresent(state("work-intelligence@market:hooks/codex-hooks.json:stop:0:0"))).toBe(true);
    expect(codexPluginHooksPresent(state("another-plugin@market:hooks.json:stop:0:0"))).toBe(false);
    expect(codexPluginHooksPresent({ plugins: { "work-intelligence@market": { enabled: false } } })).toBe(false);
    expect(codexPluginHooksPresent({ hooks: { state: "text" } })).toBe(false);
    expect(codexPluginHooksPresent(undefined)).toBe(false);
  });

  it("reads config.toml read-only and treats a missing or broken file as no plugin hooks", () => {
    const fixture = createFixture();
    const directory = dirname(fixture.paths.codexConfig);
    writeFileSync(
      fixture.paths.codexConfig,
      '[hooks.state."work-intelligence@market:hooks/codex-hooks.json:stop:0:0"]\ntrusted_hash = "sha256:synthetic"\n',
    );
    const before = readFileSync(fixture.paths.codexConfig);
    expect(readCodexPluginHooksPresent(directory)).toBe(true);
    expect(readFileSync(fixture.paths.codexConfig)).toEqual(before);
    writeFileSync(fixture.paths.codexConfig, "[broken");
    expect(readCodexPluginHooksPresent(directory)).toBe(false);
    expect(readCodexPluginHooksPresent(join(fixture.temporaryRoot, "missing"))).toBe(false);
  });
});

describe("projectCodexHooksRunFinalize", () => {
  it("reads a checkout's own .codex/hooks.json without touching it, and ignores a missing or unrelated one", () => {
    const fixture = createFixture();
    const root = fixture.options.repositoryRoot;
    const other = join(fixture.temporaryRoot, "other repo");
    mkdirSync(join(other, ".codex"), { recursive: true });
    writeFileSync(join(other, ".codex", "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [] }] } }));
    expect(projectCodexHooksRunFinalize([root, other])).toBe(false);
    mkdirSync(join(root, ".codex"), { recursive: true });
    const hooks = join(root, ".codex", "hooks.json");
    writeFileSync(
      hooks,
      '{"hooks":{"Stop":[{"hooks":[{"command":"node apps/mcp/dist/codex-finalize-reminder.js"}]}]}}',
    );
    const before = readFileSync(hooks);
    expect(projectCodexHooksRunFinalize([other, root])).toBe(true);
    expect(readFileSync(hooks)).toEqual(before);
    expect(projectCodexHooksRunFinalize([])).toBe(false);
  });
});
