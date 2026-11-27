import { createHash } from "node:crypto";

export interface McpToolContractSource {
  readonly name: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly annotations?: unknown;
}

export const MCP_SELFTEST_ENVIRONMENT = "WORK_INTELLIGENCE_MCP_SELFTEST";

/** The `clientInfo.name` the desktop self-test sends; the server must never record it as a real host. */
export const SELFTEST_CLIENT_NAME = "work-intelligence-desktop-selftest";

export const AGENT_OBSERVATIONS_FILE = "agent-observations.json";

export const MCP_CONTRACT_FINGERPRINT_FILE = "contract-fingerprint.json";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item ?? null)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function mcpContractFingerprint(tools: readonly McpToolContractSource[]): string {
  const contract = tools
    .map((tool) => ({
      name: tool.name,
      inputSchema: tool.inputSchema ?? null,
      ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
      ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
    }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return createHash("sha256").update(canonicalJson(contract)).digest("hex");
}
