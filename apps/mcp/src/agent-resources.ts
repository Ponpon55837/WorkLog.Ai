import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";

export interface AgentToolContractOperation {
  name: string;
  dispatcherName: string;
  title: string;
  description: string;
  inputShape: z.ZodRawShape;
  /** Original full runtime schema, including refinements and transforms not expressible in JSON Schema. */
  schema: z.ZodTypeAny;
  /** Human-readable rules which JSON Schema cannot express, or runtime rules beyond field shape. */
  validationNotes?: readonly string[];
  annotations: ToolAnnotations;
}

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const TOOL_CONTRACT_RESOURCE_URI = "work-intelligence://agent/tool-contracts";

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

function buildToolContractDocument(operations: readonly AgentToolContractOperation[]): string {
  const entries = operations.map((operation) => {
    const inputSchema = toJsonSchema(operation.schema);
    return [
      "## " + operation.name,
      "",
      "Dispatcher: " + operation.dispatcherName,
      "Title: " + operation.title,
      "Annotations: " + JSON.stringify(operation.annotations),
      "",
      "Use and limits: " + operation.description,
      "",
      "Input schema (derived from the complete runtime Zod schema; custom refinements may not appear here):",
      "```json",
      JSON.stringify(inputSchema, null, 2),
      "```",
      ...(operation.validationNotes?.length
        ? [
            "",
            "Validation rules not fully expressible in JSON Schema:",
            ...operation.validationNotes.map((note) => "- " + note),
          ]
        : []),
    ].join("\n");
  });
  return [
    "# Work Intelligence MCP tool contracts",
    "",
    "The four tools/list dispatchers accept an operation name and an arguments object. Use the exact operation and schema below; server-side validation still applies the original full runtime schema.",
    "Before the first write in a conversation, read this fixed resource and the applicable Work Intelligence skill rules. This resource exposes no path-based file access.",
    "",
    ...entries,
  ].join("\n\n");
}

/** Keep zod-to-json-schema's generic type instantiation behind a deliberately broad boundary. */
function toJsonSchema(schema: z.ZodTypeAny): unknown {
  const convert = zodToJsonSchema as unknown as (
    input: z.ZodTypeAny,
    options: { target: "jsonSchema7"; strictUnions: boolean; pipeStrategy: "input" },
  ) => unknown;
  return convert(schema, {
    target: "jsonSchema7",
    strictUnions: true,
    pipeStrategy: "input",
  });
}

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

export function registerToolContractsResource(
  server: McpServer,
  operations: readonly AgentToolContractOperation[],
): void {
  server.registerResource(
    "tool-contracts",
    TOOL_CONTRACT_RESOURCE_URI,
    {
      title: "Work Intelligence tool operation contracts",
      description:
        "Complete operation names, dispatchers, annotations, behavior and input schemas; read before the first write.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: buildToolContractDocument(operations),
        },
      ],
    }),
  );
}
