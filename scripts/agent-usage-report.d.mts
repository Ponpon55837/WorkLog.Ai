/** Types for scripts/agent-usage-report.mjs, so tests can import it. */
export interface UsageMetrics {
  turns: number;
  assistantMessages: number;
  sidechainLines: number;
  toolCalls: number;
  toolCallsByName: Record<string, number>;
  workIntelligenceTools: Record<string, number>;
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
  mcpToolResultChars: number;
  workIntelligenceToolResultChars: number;
  unknownToolResultChars: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
}
export interface SessionUsage extends UsageMetrics {
  label: string;
  hash: string;
}
export interface UsageReport {
  format: string;
  sessions: SessionUsage[];
  total: UsageMetrics & { sessions: number };
  skippedLines: number;
  unsupportedLines: number;
}
export declare function summarizeFiles(
  paths: string[],
  options?: { since?: string; until?: string },
): Promise<UsageReport>;
