import type { SystemAgentConnections } from "@work-intelligence/core";
import {
  classifyHostObservation,
  diagnoseMcpLease,
  type McpLeaseDiagnosis,
  readCurrentContractFingerprint,
  readHostObservations,
} from "@work-intelligence/shared/agent-observations";
import { configDirectory } from "@work-intelligence/shared/database-location";

export function withHostObservations(
  connections: SystemAgentConnections,
  runtimeRoot: string,
  directory: string = configDirectory(),
): SystemAgentConnections {
  const observations = readHostObservations(directory);
  const current = readCurrentContractFingerprint(runtimeRoot);
  return {
    codex: { ...connections.codex, observation: classifyHostObservation(observations.codex, current) },
    claudeCode: {
      ...connections.claudeCode,
      observation: classifyHostObservation(observations["claude-code"], current),
    },
  };
}

export function mcpLeaseDiagnosis(
  backendScopeId: string,
  activeLeases: number,
  directory: string = configDirectory(),
): McpLeaseDiagnosis {
  return diagnoseMcpLease(readHostObservations(directory), backendScopeId, activeLeases);
}
