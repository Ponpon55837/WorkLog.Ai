import type { SystemAgentConnections } from "@work-intelligence/core";
import {
  classifyHostObservation,
  diagnoseMcpLease,
  type McpLeaseDiagnosis,
  readCurrentContractFingerprint,
  readHostObservations,
} from "@work-intelligence/shared/agent-observations";
import { configDirectory } from "@work-intelligence/shared/database-location";

/**
 * Adds what each Agent host last saw of the MCP tool contract. The reader and the comparison are the ones the desktop
 * App's Agent tab uses (shared), so the Web status and the App never judge a host differently.
 */
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

/**
 * Compares the lease state the MCP recorded in its observation with this backend's scope (see `diagnoseMcpLease`); one
 * small file read, made only when an Agent was seen and no lease is visible.
 */
export function mcpLeaseDiagnosis(
  backendScopeId: string,
  activeLeases: number,
  directory: string = configDirectory(),
): McpLeaseDiagnosis {
  return diagnoseMcpLease(readHostObservations(directory), backendScopeId, activeLeases);
}
