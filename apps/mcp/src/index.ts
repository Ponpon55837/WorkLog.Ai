import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WorkIntelligenceStore } from "@work-intelligence/storage";
import { createWorkIntelligenceMcpServer } from "./server.js";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDataPath = resolve(appRoot, "../../data", "work-intelligence.sqlite");
const databasePath = process.env.WORK_INTELLIGENCE_DB ?? repoDataPath;
const { version } = JSON.parse(readFileSync(resolve(appRoot, "package.json"), "utf8")) as { version: string };

const store = new WorkIntelligenceStore(databasePath);
const server = createWorkIntelligenceMcpServer(store, version);
await server.connect(new StdioServerTransport());
console.error(`Work Intelligence MCP server ${version} connected using ${databasePath}`);
