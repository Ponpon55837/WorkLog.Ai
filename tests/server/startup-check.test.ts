import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as childProcess from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SystemAgentConnections } from "../../packages/core/src/index.js";
import { collectStartupHints } from "../../apps/server/src/startup-check.js";

// Every child_process function is spied on so a test can prove the check never queries services.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [name, typeof value === "function" ? vi.fn(value) : value]),
  );
});

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function connections(overrides: {
  canonical?: SystemAgentConnections["codex"]["canonicalSkill"];
  legacy?: SystemAgentConnections["codex"]["legacySkill"];
  claude?: SystemAgentConnections["claudeCode"]["skill"];
  hook?: SystemAgentConnections["codex"]["hook"];
}): SystemAgentConnections {
  return {
    codex: {
      mcpRegistered: "registered",
      canonicalSkill: overrides.canonical ?? "current",
      legacySkill: overrides.legacy ?? "current",
      hook: overrides.hook ?? "installed",
    },
    claudeCode: { mcpRegistered: "registered", skill: overrides.claude ?? "current", hook: "installed" },
  };
}

describe("collectStartupHints", () => {
  it("is silent when everything is current", () => {
    expect(collectStartupHints({ inspectConnections: () => connections({}) })).toEqual([]);
  });

  it("is silent when skills and hooks are not installed", () => {
    const hints = collectStartupHints({
      inspectConnections: () =>
        connections({ canonical: "missing", legacy: "missing", claude: "missing", hook: "missing" }),
    });
    expect(hints).toEqual([]);
  });

  it.each([
    ["Codex canonical skill", { canonical: "stale" as const }],
    ["Codex legacy skill", { legacy: "stale" as const }],
    ["Claude skill", { claude: "stale" as const }],
  ])("hints to sync when the %s is out of date", (_name, overrides) => {
    const hints = collectStartupHints({ inspectConnections: () => connections(overrides) });
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("pnpm bootstrap");
    expect(hints[0]).toContain("pnpm setup:agents");
  });

  it("hints separately when the Codex hook uses the old matcher", () => {
    const hints = collectStartupHints({ inspectConnections: () => connections({ canonical: "stale", hook: "stale" }) });
    expect(hints).toHaveLength(2);
    expect(hints[1]).toContain("hook");
  });

  it("returns an empty list instead of throwing when reading fails", () => {
    const hints = collectStartupHints({
      inspectConnections: () => {
        throw new Error("EACCES");
      },
    });
    expect(hints).toEqual([]);
  });

  it("detects an out-of-date installed skill from real files without any service query", () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-startup-"));
    temporaryDirectories.push(root);
    const repositoryRoot = join(root, "repo");
    const home = join(root, "home");
    const claudeDirectory = join(home, ".claude");
    mkdirSync(join(repositoryRoot, ".agents", "skills", "work-intelligence"), { recursive: true });
    writeFileSync(join(repositoryRoot, ".agents", "skills", "work-intelligence", "SKILL.md"), "current skill\n");
    mkdirSync(join(claudeDirectory, "skills", "work-intelligence"), { recursive: true });
    writeFileSync(join(claudeDirectory, "skills", "work-intelligence", "SKILL.md"), "an older skill\n");
    const environment = {
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: join(home, ".codex"),
      CLAUDE_CONFIG_DIR: claudeDirectory,
    };
    const previous = { ...process.env };
    Object.assign(process.env, environment);
    try {
      const hints = collectStartupHints({ repositoryRoot });
      expect(hints).toHaveLength(1);
      expect(hints[0]).toContain("已過期");
    } finally {
      for (const key of Object.keys(environment)) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }

    for (const [name, value] of Object.entries(childProcess)) {
      if (typeof value === "function" && "mock" in value) {
        expect((value as unknown as { mock: { calls: unknown[] } }).mock.calls, name).toHaveLength(0);
      }
    }
  });
});
