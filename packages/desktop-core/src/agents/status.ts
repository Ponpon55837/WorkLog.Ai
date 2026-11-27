import { classifyHostObservation } from "@work-intelligence/shared/agent-observations";
export type AgentRegistrationSource = "desktop-managed" | "manual" | "plugin" | "mcpb" | "unknown";

export type AgentHookTrust = "not-applicable" | "trusted" | "needs-trust";
export type AgentRuntimeCompatibility = "compatible" | "incompatible" | "unknown";
export type AgentSelfTestOutcome = "ok" | "failed" | "not-run";

export interface AgentStatusFacts {
  readonly source: AgentRegistrationSource;
  readonly configWritten: boolean;
  readonly configMatches: boolean;
  readonly conflict: boolean;
  readonly hookTrust: AgentHookTrust;
  readonly runtime: AgentRuntimeCompatibility;
  readonly selfTest: AgentSelfTestOutcome;
  readonly observation?: { readonly contractFingerprint: string };
  readonly currentContractFingerprint?: string;
}

export const AGENT_DISPLAY_STATES = [
  "observed-connected",
  "configured-unverified",
  "needs-trust",
  "externally-managed",
  "conflict",
  "runtime-incompatible",
  "needs-reconnect",
  "not-configured",
] as const;
export type AgentDisplayState = (typeof AGENT_DISPLAY_STATES)[number];

export const AGENT_NEXT_STEPS = [
  "none",
  "resolve-conflict",
  "rewrite-config",
  "fix-runtime",
  "set-up-agent",
  "run-self-test",
  "fix-self-test",
  "trust-hooks",
  "reconnect-agent",
  "open-agent",
] as const;
export type AgentNextStep = (typeof AGENT_NEXT_STEPS)[number];

export const AGENT_DISPLAY_STATE_LABELS: Readonly<Record<AgentDisplayState, string>> = {
  "observed-connected": "已觀察到連線",
  "configured-unverified": "已配置、待確認",
  "needs-trust": "需要信任／授權",
  "externally-managed": "外部管理",
  conflict: "設定衝突",
  "runtime-incompatible": "runtime 不相容",
  "needs-reconnect": "契約更新，需重新連線",
  "not-configured": "尚未配置",
};

export interface AgentResultLevels {
  readonly configWritten: boolean;
  readonly selfTest: AgentSelfTestOutcome;
  readonly hostObservation: "current" | "stale" | "none";
  readonly trustReminderPending: boolean;
}

export interface AgentStatus {
  readonly state: AgentDisplayState;
  readonly levels: AgentResultLevels;
  readonly nextStep: AgentNextStep;
}

const EXTERNAL_SOURCES: ReadonlySet<AgentRegistrationSource> = new Set(["plugin", "mcpb", "manual"]);

function hostObservation(facts: AgentStatusFacts): AgentResultLevels["hostObservation"] {
  return classifyHostObservation(facts.observation, facts.currentContractFingerprint);
}

function unobservedNextStep(facts: AgentStatusFacts): AgentNextStep {
  if (facts.hookTrust === "needs-trust") return "trust-hooks";
  if (facts.selfTest === "failed") return "fix-self-test";
  return facts.selfTest === "ok" ? "open-agent" : "run-self-test";
}

export function classifyAgentStatus(facts: AgentStatusFacts): AgentStatus {
  const observation = hostObservation(facts);
  const levels: AgentResultLevels = {
    configWritten: facts.configWritten,
    selfTest: facts.selfTest,
    hostObservation: observation,
    trustReminderPending: facts.hookTrust === "needs-trust",
  };
  const status = (state: AgentDisplayState, nextStep: AgentNextStep): AgentStatus => ({ state, levels, nextStep });

  if (facts.conflict) return status("conflict", "resolve-conflict");
  if (facts.runtime === "incompatible") return status("runtime-incompatible", "fix-runtime");

  const external = EXTERNAL_SOURCES.has(facts.source) || (facts.source === "unknown" && observation !== "none");
  if (external) return status("externally-managed", observation === "stale" ? "reconnect-agent" : "none");

  if (!facts.configWritten) return status("not-configured", "set-up-agent");
  if (!facts.configMatches) return status("conflict", "rewrite-config");
  if (observation === "current")
    return status("observed-connected", facts.hookTrust === "needs-trust" ? "trust-hooks" : "none");
  if (observation === "stale") return status("needs-reconnect", "reconnect-agent");
  if (facts.hookTrust === "needs-trust") return status("needs-trust", "trust-hooks");
  return status("configured-unverified", unobservedNextStep(facts));
}
