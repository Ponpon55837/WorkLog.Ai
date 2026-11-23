/** Types for scripts/agent-usage-report.mjs, so tests can import it. */
export interface UsageMetrics {
  turns: number;
  assistantMessages: number;
  sidechainLines: number;
  toolCalls: number;
  toolCallsByName: Record<string, number>;
  workIntelligenceTools: Record<string, number>;
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number; reasoningOutput?: number };
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
  formats: { claudeCodeLines: number; codexLines: number };
  sessions: SessionUsage[];
  total: UsageMetrics & { sessions: number };
  skippedLines: number;
  codexTokenMismatches: number;
  codexTokenSourceDisagreements: number;
  codexForkedSessions: number;
  codexIgnoredLines: number;
}
export declare function summarizeFiles(
  paths: string[],
  options?: { since?: string; until?: string },
): Promise<UsageReport>;
export interface UsageShapes {
  skippedLines: number;
  shapes: { key: string; count: number; paths: { path: string; types: string[] }[] }[];
}
export declare function summarizeShapes(paths: string[]): Promise<UsageShapes>;
