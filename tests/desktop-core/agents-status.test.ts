import { describe, expect, it } from "vitest";
import {
  AGENT_DISPLAY_STATES,
  AGENT_DISPLAY_STATE_LABELS,
  classifyAgentStatus,
  hostForClientName,
  type AgentStatusFacts,
} from "../../packages/desktop-core/src/agents/index.js";

const CURRENT = "c".repeat(64);
const OLD = "o".repeat(64);

function facts(overrides: Partial<AgentStatusFacts> = {}): AgentStatusFacts {
  return {
    source: "desktop-managed",
    configWritten: true,
    configMatches: true,
    conflict: false,
    hookTrust: "trusted",
    runtime: "compatible",
    selfTest: "ok",
    currentContractFingerprint: CURRENT,
    ...overrides,
  };
}

describe("classifyAgentStatus", () => {
  const cases: [string, Partial<AgentStatusFacts>, string, string][] = [
    [
      "observation equal to the current contract",
      { observation: { contractFingerprint: CURRENT } },
      "observed-connected",
      "none",
    ],
    [
      "observation with an older contract",
      { observation: { contractFingerprint: OLD } },
      "needs-reconnect",
      "reconnect-agent",
    ],
    ["self-test ok, never observed", {}, "configured-unverified", "open-agent"],
    ["self-test not run, never observed", { selfTest: "not-run" }, "configured-unverified", "run-self-test"],
    ["self-test failed, never observed", { selfTest: "failed" }, "configured-unverified", "fix-self-test"],
    ["trust pending, never observed", { hookTrust: "needs-trust" }, "needs-trust", "trust-hooks"],
    [
      "trust pending after an old observation",
      { hookTrust: "needs-trust", observation: { contractFingerprint: OLD } },
      "needs-reconnect",
      "reconnect-agent",
    ],
    ["nothing written", { configWritten: false, selfTest: "not-run" }, "not-configured", "set-up-agent"],
    ["written config that drifted", { configMatches: false }, "conflict", "rewrite-config"],
    ["flagged conflict", { conflict: true }, "conflict", "resolve-conflict"],
    ["incompatible runtime", { runtime: "incompatible" }, "runtime-incompatible", "fix-runtime"],
    ["unknown runtime is not incompatible", { runtime: "unknown" }, "configured-unverified", "open-agent"],
    ["plugin registration", { source: "plugin" }, "externally-managed", "none"],
    ["mcpb registration", { source: "mcpb", configWritten: false }, "externally-managed", "none"],
    ["manual registration", { source: "manual" }, "externally-managed", "none"],
    [
      "manual registration with an old observation",
      { source: "manual", observation: { contractFingerprint: OLD } },
      "externally-managed",
      "reconnect-agent",
    ],
    [
      "unknown source that a host observed",
      { source: "unknown", configWritten: false, observation: { contractFingerprint: CURRENT } },
      "externally-managed",
      "none",
    ],
    ["unknown source, nothing written", { source: "unknown", configWritten: false }, "not-configured", "set-up-agent"],
    [
      "conflict beats an observation",
      { conflict: true, observation: { contractFingerprint: CURRENT } },
      "conflict",
      "resolve-conflict",
    ],
    ["conflict beats external management", { conflict: true, source: "plugin" }, "conflict", "resolve-conflict"],
    [
      "incompatible runtime beats an observation",
      { runtime: "incompatible", observation: { contractFingerprint: CURRENT } },
      "runtime-incompatible",
      "fix-runtime",
    ],
    [
      "observation but no current fingerprint to compare",
      { currentContractFingerprint: undefined, observation: { contractFingerprint: CURRENT } },
      "needs-reconnect",
      "reconnect-agent",
    ],
  ];

  it.each(cases)("%s", (_name, overrides, state, nextStep) => {
    const status = classifyAgentStatus(facts(overrides));
    expect({ state: status.state, nextStep: status.nextStep }).toEqual({ state, nextStep });
  });

  it("reaches every display state", () => {
    const reached = new Set(cases.map(([, overrides]) => classifyAgentStatus(facts(overrides)).state));
    expect([...reached].sort()).toEqual([...AGENT_DISPLAY_STATES].sort());
  });

  it("labels every display state", () => {
    expect(Object.keys(AGENT_DISPLAY_STATE_LABELS).sort()).toEqual([...AGENT_DISPLAY_STATES].sort());
  });

  it("reports the four result levels separately from the state", () => {
    const written = classifyAgentStatus(facts({ selfTest: "not-run" }));
    expect(written.levels).toEqual({
      configWritten: true,
      selfTest: "not-run",
      hostObservation: "none",
      trustReminderPending: false,
    });
    const observed = classifyAgentStatus(
      facts({ hookTrust: "needs-trust", observation: { contractFingerprint: CURRENT } }),
    );
    expect(observed.state).toBe("observed-connected");
    expect(observed.levels).toMatchObject({ hostObservation: "current", trustReminderPending: true });
    expect(observed.nextStep).toBe("trust-hooks");
  });

  it("never reports connected for a written file alone", () => {
    expect(classifyAgentStatus(facts({ selfTest: "ok" })).state).not.toBe("observed-connected");
  });

  it("still reports observations of an externally managed source", () => {
    const status = classifyAgentStatus(facts({ source: "plugin", observation: { contractFingerprint: CURRENT } }));
    expect(status.levels.hostObservation).toBe("current");
  });
});

describe("hostForClientName", () => {
  it.each([
    ["claude-code", "claude-code"],
    ["codex-mcp-client", "codex"],
    ["Codex-MCP-Client", "codex"],
    ["claude-ai", "claude-desktop"],
  ])("maps %s to %s", (name, host) => {
    expect(hostForClientName(name)).toBe(host);
  });

  it("does not guess unknown names", () => {
    expect(hostForClientName("cursor")).toBeUndefined();
    expect(hostForClientName("work-intelligence-desktop-selftest")).toBeUndefined();
  });
});
