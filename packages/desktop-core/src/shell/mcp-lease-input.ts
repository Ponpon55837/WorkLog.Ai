import { diagnoseMcpLease, readHostObservations } from "@work-intelligence/shared/agent-observations";
import { MCP_LEASE_SCOPE_ENVIRONMENT, readMcpLeaseCensus } from "@work-intelligence/shared/mcp-runtime";
import type { McpLeaseDiagnosticsInput } from "./diagnostics-collect.js";

export function readMcpLeaseInput(runtimeRoot: string, configDirectory: string): McpLeaseDiagnosticsInput {
  const census = readMcpLeaseCensus(runtimeRoot, { [MCP_LEASE_SCOPE_ENVIRONMENT]: runtimeRoot });
  const observations = readHostObservations(configDirectory);
  const agentObserved = Object.keys(observations).length > 0;
  const diagnosis = diagnoseMcpLease(observations, census.scopeId, census.activeLeases);
  return {
    backendScopeId: census.scopeId,
    backendDirectoryWritable: census.directoryWritable,
    activeLeases: census.activeLeases,
    agentObserved,
    ...(diagnosis.observedScopeId === undefined ? {} : { observedScopeId: diagnosis.observedScopeId }),
    ...(diagnosis.directoryWritable === undefined ? {} : { observedDirectoryWritable: diagnosis.directoryWritable }),
    ...(diagnosis.cause ? { cause: diagnosis.cause } : {}),
  };
}
