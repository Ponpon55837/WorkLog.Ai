import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LATEST_SCHEMA_VERSION, WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import { createWorkIntelligenceMcpServer } from "../../apps/mcp/src/server.js";
import { McpStoreAccess } from "../../apps/mcp/src/store-access.js";

// The MCP server exactly as apps/mcp/src/index.ts wires it for a standalone bundle: real tool definitions, real
// store access, real stdio transport, and no on-disk build to compare with. A repository checkout has a second,
// earlier restart check (build identity); with no dist/ under tsx that check would answer first and hide the
// per-write schema gate this experiment is about.
const databasePath = process.env.WORK_INTELLIGENCE_DB ?? "";
const storeAccess = new McpStoreAccess(() => new WorkIntelligenceStore(databasePath), {
  onFailure: (failure) =>
    console.error(`Work Intelligence MCP database unavailable (${failure.code}): ${failure.message}`),
});
const server = createWorkIntelligenceMcpServer(storeAccess, "0.0.0-barrier", LATEST_SCHEMA_VERSION);
await server.connect(new StdioServerTransport());
console.error(`Work Intelligence MCP server (schema ${LATEST_SCHEMA_VERSION}) connected using ${databasePath}`);
