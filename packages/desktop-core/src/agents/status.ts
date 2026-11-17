/** Who put the MCP registration in the Agent's configuration. */
export type AgentRegistrationSource = "desktop-managed" | "manual" | "plugin" | "mcpb" | "unknown";

export type AgentHookTrust = "not-applicable" | "trusted" | "needs-trust";
export type AgentRuntimeCompatibility = "compatible" | "incompatible" | "unknown";
export type AgentSelfTestOutcome = "ok" | "failed" | "not-run";

/** Everything the classifier looks at for one Agent; the caller gathers it, nothing here touches the disk. */
export interface AgentStatusFacts {
  readonly source: AgentRegistrationSource;
  /** The registration exists in the Agent's configuration. */
  readonly configWritten: boolean;
  /** The written registration is byte-for-byte what the desktop App would write (hash match). */
  readonly configMatches: boolean;
  /** Another registration or a differing value fights the desktop's (e.g. two servers under one name). */
  readonly conflict: boolean;
  readonly hookTrust: AgentHookTrust;
  readonly runtime: AgentRuntimeCompatibility;
  /** Latest desktop self-test of the launcher the registration points to. */
  readonly selfTest: AgentSelfTestOutcome;
  /** Latest observation of this host's client name by the MCP server, if any. */
  readonly observation?: { readonly contractFingerprint: string };
  /** The contract fingerprint of the MCP server the desktop would launch now (from a successful self-test). */
  readonly currentContractFingerprint?: string;
}

/** ADR-34 display states. */
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

/** What the user should do next; the UI maps each code to a sentence and a button. */
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

/** Traditional Chinese labels of the display states (ADR-34). */
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

/** The four result levels, reported separately so a written file is never read as a working connection. */
export interface AgentResultLevels {
  readonly configWritten: boolean;
  readonly selfTest: AgentSelfTestOutcome;
  /** `current`: the host saw today's tool contract; `stale`: it saw an older one; `none`: never observed. */
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
  if (!facts.observation) return "none";
  // Without a current fingerprint nothing can be proven equal, so an observation is never "current" then.
  return facts.currentContractFingerprint !== undefined &&
    facts.observation.contractFingerprint === facts.currentContractFingerprint
    ? "current"
    : "stale";
}

function unobservedNextStep(facts: AgentStatusFacts): AgentNextStep {
  if (facts.hookTrust === "needs-trust") return "trust-hooks";
  if (facts.selfTest === "failed") return "fix-self-test";
  return facts.selfTest === "ok" ? "open-agent" : "run-self-test";
}

/**
 * The display state of one Agent. A conflict, a configuration that no longer matches what the desktop wrote, or an
 * incompatible runtime comes first; a plugin, MCPB or manual registration is never claimed as ours
 * (`externally-managed`) though its observations are still reported. For the rest only an observation whose
 * fingerprint equals the current one is `observed-connected`; an older one is `needs-reconnect`; a passing
 * self-test alone is `configured-unverified`.
 */
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
