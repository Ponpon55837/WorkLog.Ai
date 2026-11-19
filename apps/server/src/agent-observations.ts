import type { SystemAgentConnections } from "@work-intelligence/core";
import {
  classifyHostObservation,
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
