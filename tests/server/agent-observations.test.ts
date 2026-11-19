import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SystemAgentConnections } from "../../packages/core/src/index.js";
import { classifyAgentStatus } from "../../packages/desktop-core/src/agents/status.js";
import { classifyHostObservation } from "../../packages/shared/src/agent-observations.js";
import { withHostObservations } from "../../apps/server/src/agent-observations.js";

// Synthetic files only. The Web status must judge a host by the same rule as the App's Agent tab.
const CURRENT = "a".repeat(64);
const OLD = "b".repeat(64);
let root = "";
let configDirectory = "";
let runtimeRoot = "";

const CONNECTIONS = {
  codex: { mcpRegistered: "registered", canonicalSkill: "current", legacySkill: "current", hook: "installed" },
  claudeCode: { mcpRegistered: "registered", skill: "current", hook: "installed" },
} as unknown as SystemAgentConnections;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agent-observations-"));
  configDirectory = join(root, "config");
  runtimeRoot = join(root, "runtime-root");
  mkdirSync(configDirectory, { recursive: true });
  const dist = join(runtimeRoot, "runtimes", "runtime-1", "app", "libexec", "apps", "mcp", "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(runtimeRoot, "current"), "runtime-1\n");
  writeFileSync(join(dist, "contract-fingerprint.json"), JSON.stringify({ version: 1, contractFingerprint: CURRENT }));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function observe(entries: Record<string, string>): void {
  const observations = Object.fromEntries(
    Object.entries(entries).map(([name, contractFingerprint]) => [
      name,
      { contractFingerprint, observedAt: "2026-11-19T00:00:00.000Z" },
    ]),
  );
  writeFileSync(join(configDirectory, "agent-observations.json"), JSON.stringify({ observations }));
}

describe("withHostObservations", () => {
  it("reports current, stale and none per Agent from the MCP's record and the installed contract", () => {
    observe({ "codex-mcp-client": CURRENT, "claude-code": OLD });
    const result = withHostObservations(CONNECTIONS, runtimeRoot, configDirectory);
    expect(result.codex.observation).toBe("current");
    expect(result.claudeCode.observation).toBe("stale");
    expect(result.codex.mcpRegistered).toBe("registered");
  });

  it("reports none when nothing was observed, and never claims current without the installed contract", () => {
    expect(withHostObservations(CONNECTIONS, runtimeRoot, configDirectory).codex.observation).toBe("none");
    observe({ "codex-mcp-client": CURRENT });
    expect(withHostObservations(CONNECTIONS, join(root, "no-runtime"), configDirectory).codex.observation).toBe(
      "stale",
    );
  });

  it("agrees with the App's Agent classification for every combination", () => {
    const observed = [undefined, { contractFingerprint: CURRENT }, { contractFingerprint: OLD }];
    for (const observation of observed) {
      for (const current of [undefined, CURRENT]) {
        const app = classifyAgentStatus({
          source: "desktop-managed",
          configWritten: true,
          configMatches: true,
          conflict: false,
          hookTrust: "not-applicable",
          runtime: "compatible",
          selfTest: "ok",
          ...(observation ? { observation } : {}),
          ...(current ? { currentContractFingerprint: current } : {}),
        }).levels.hostObservation;
        expect(classifyHostObservation(observation, current)).toBe(app);
      }
    }
  });
});
