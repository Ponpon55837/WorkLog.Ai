import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const AGENT_RESOURCES = [
  {
    name: "work-intelligence-skill",
    uri: "work-intelligence://agent/work-intelligence/SKILL.md",
    title: "Work Intelligence agent skill",
    description:
      "Complete instructions for using Work Intelligence safely, including project opt-in, context, recall, finalization, reports, and Knowledge workflows.",
    path: ".agents/skills/work-intelligence/SKILL.md",
  },
  {
    name: "work-record-and-report-format",
    uri: "work-intelligence://agent/work-record-and-report-format.md",
    title: "Work record and report format",
    description:
      "Canonical field definitions, evidence rules, reporting granularity, and examples referenced by the Work Intelligence skill.",
    path: "docs/work-record-and-report-format.md",
  },
] as const;

/** Exposes the complete agent contract through standard MCP resources for any connected client. */
export function registerAgentResources(server: McpServer): void {
  for (const resource of AGENT_RESOURCES) {
    server.registerResource(
      resource.name,
      resource.uri,
      {
        title: resource.title,
        description: resource.description,
        mimeType: "text/markdown",
      },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: readFileSync(resolve(REPOSITORY_ROOT, resource.path), "utf8"),
          },
        ],
      }),
    );
  }
}
