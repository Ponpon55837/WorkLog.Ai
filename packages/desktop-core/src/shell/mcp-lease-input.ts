import { diagnoseMcpLease, readHostObservations } from "@work-intelligence/shared/agent-observations";
import { MCP_LEASE_SCOPE_ENVIRONMENT, readMcpLeaseCensus } from "@work-intelligence/shared/mcp-runtime";
import type { McpLeaseDiagnosticsInput } from "./diagnostics-collect.js";

/**
 * The MCP lease facts for the diagnostics summary: the backend's own scope (the App's runtime root, which the backend is
 * started with), how many fresh leases it holds, and what the newest Agent observation in `configDirectory` says about
 * its own. The same comparison the Web status makes; ids, counts and booleans only. Never throws: a registry that cannot
 * be read is reported as not writable with no lease. The environment is the backend's own (the scope variable and nothing
 * else: the backend's allowlist passes no config-directory override).
 */
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
