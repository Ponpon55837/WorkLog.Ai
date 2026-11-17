/** The Agent hosts the desktop App can show a connection state for. */
export const AGENT_HOST_IDS = ["claude-code", "codex", "claude-desktop"] as const;
export type AgentHostId = (typeof AGENT_HOST_IDS)[number];

/**
 * `clientInfo.name` each host sends in MCP `initialize`. Claude Code (`claude-code`, measured with 2.1.323) and Codex
 * (`codex-mcp-client`, from its source) are known; Claude Desktop is not documented by its vendor, so `claude-ai` is
 * the name its connector traffic is known to carry and may need a new row when a release changes it. A name missing
 * here is still recorded by the server, it just does not light up a host until someone adds it.
 */
const CLIENT_NAME_TO_HOST: ReadonlyMap<string, AgentHostId> = new Map([
  ["claude-code", "claude-code"],
  ["codex-mcp-client", "codex"],
  ["codex", "codex"],
  ["claude-ai", "claude-desktop"],
]);

/** The host a `clientInfo.name` belongs to, or undefined for a name this table does not know. */
export function hostForClientName(clientName: string): AgentHostId | undefined {
  return CLIENT_NAME_TO_HOST.get(clientName.trim().toLowerCase());
}
