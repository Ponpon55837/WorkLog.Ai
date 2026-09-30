import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LATEST_SCHEMA_VERSION } from "@work-intelligence/storage";
import { createWorkIntelligenceMcpServer } from "./server.js";

/** Fingerprints the actual advertised tools and resources without opening a database or registering a lease. */
export async function computeMcpCompatibility(
  schemaVersion = LATEST_SCHEMA_VERSION,
): Promise<{ compatibilityId: string; schemaVersion: number }> {
  const server = createWorkIntelligenceMcpServer(null, "build", schemaVersion, {
    code: "BUILD_ONLY",
    message: "build",
  });
  const client = new Client({ name: "build-contract", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    const index = await client.readResource({ uri: "work-intelligence://agent/tool-contracts" });
    const text = index.contents.map((content) => ("text" in content ? content.text : "")).join("\n");
    const operations = [...text.matchAll(/^- (work_\w+) → /gm)].map((match) => match[1]).sort();
    if (tools.nextCursor || operations.length === 0) throw new Error("Incomplete MCP compatibility contract snapshot.");
    const contracts = await Promise.all(
      operations.map((operation) =>
        client.readResource({ uri: `work-intelligence://agent/tool-contracts/${operation}` }),
      ),
    );
    const compatibilityId = createHash("sha256")
      .update(
        JSON.stringify({
          schemaVersion,
          instructions: client.getInstructions(),
          tools,
          index,
          contracts,
        }),
      )
      .digest("hex");
    return { compatibilityId, schemaVersion };
  } finally {
    await client.close();
    await server.close();
  }
}
