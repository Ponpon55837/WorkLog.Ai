import { createHash } from "node:crypto";

/** The part of a `tools/list` entry that is the tool contract; titles and descriptions are prose, not contract. */
export interface McpToolContractSource {
  readonly name: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly annotations?: unknown;
}

/**
 * Set by the desktop self-test on the MCP process it spawns: the server then opens no database and writes no runtime
 * state, because a self-test only needs to prove the server starts and lists its tools.
 */
export const MCP_SELFTEST_ENVIRONMENT = "WORK_INTELLIGENCE_MCP_SELFTEST";

/** The `clientInfo.name` the desktop self-test sends; the server must never record it as a real host. */
export const SELFTEST_CLIENT_NAME = "work-intelligence-desktop-selftest";

/** The file in the config directory where the MCP server records what a real Agent host saw (see the desktop Agent page). */
export const AGENT_OBSERVATIONS_FILE = "agent-observations.json";

/**
 * The packaged runtime's own tool-contract fingerprint, written next to its MCP bundles at build time
 * (`apps/mcp/dist/` inside the runtime), so the desktop can compare it with what a host saw without starting the server.
 */
export const MCP_CONTRACT_FINGERPRINT_FILE = "contract-fingerprint.json";

/** JSON with every object's keys sorted, so two equal values always serialize to the same text. */
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

/**
 * A SHA-256 (hex) over the tools' name, inputSchema and, when present, outputSchema and annotations, sorted by tool
 * name with sorted object keys. The MCP server (recording what a host saw) and the desktop self-test (what the
 * current build offers) both call this, so the two fingerprints are equal exactly when the tool contract is equal:
 * order of tools or keys and wording of descriptions never change it, a changed schema or annotation always does.
 */
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
