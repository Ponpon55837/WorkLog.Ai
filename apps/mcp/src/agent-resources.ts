import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
/** One operation's complete contract; the index above lists every operation id. */
export const TOOL_CONTRACT_OPERATION_URI_TEMPLATE = `${TOOL_CONTRACT_RESOURCE_URI}/{operation}`;

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

function buildToolContractIndex(operations: readonly AgentToolContractOperation[]): string {
  return [
    "# Work Intelligence MCP operation index",
    "",
    "The four tools/list dispatchers accept an operation id and an arguments object. Each line below is `operation → dispatcher: title`.",
    `Before calling an operation for the first time in a conversation, read its complete contract at ${TOOL_CONTRACT_RESOURCE_URI}/<operation> (for example ${TOOL_CONTRACT_RESOURCE_URI}/work_finalize_session): behavior, safety annotations, JSON input schema, and runtime validation rules. Unknown argument keys are rejected, not ignored. These resources expose no path-based file access.`,
    "",
    ...operations.map((operation) => `- ${operation.name} → ${operation.dispatcherName}: ${operation.title}`),
  ].join("\n");
}

function buildOperationContract(operation: AgentToolContractOperation): string {
  return [
    "## " + operation.name,
    "",
    "Dispatcher: " + operation.dispatcherName,
    "Title: " + operation.title,
    "Annotations: " + JSON.stringify(operation.annotations),
    "",
    "Use and limits: " + operation.description,
    "",
    "Input schema (JSON Schema derived from the complete runtime Zod schema; unknown keys are rejected; custom refinements may not appear here):",
    "```json",
    JSON.stringify(toJsonSchema(operation.schema)),
    "```",
    ...(operation.validationNotes?.length
      ? [
          "",
          "Validation rules not fully expressible in JSON Schema:",
          ...operation.validationNotes.map((note) => "- " + note),
        ]
      : []),
  ].join("\n");
}

/** Keep zod-to-json-schema's generic type instantiation behind a deliberately broad boundary. */
function toJsonSchema(schema: z.ZodTypeAny): unknown {
  const convert = zodToJsonSchema as unknown as (
    input: z.ZodTypeAny,
    options: { target: "jsonSchema7"; strictUnions: boolean; pipeStrategy: "input" },
  ) => unknown;
  const { $schema: _dialect, ...jsonSchema } = convert(schema, {
    target: "jsonSchema7",
    strictUnions: true,
    pipeStrategy: "input",
  }) as Record<string, unknown>;
  return jsonSchema;
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

/**
 * Publishes a compact operation index plus one resource per operation, so an Agent reads only the
 * contracts it is about to use instead of every schema at once. Documents are built once per server.
 */
export function registerToolContractsResource(
  server: McpServer,
  operations: readonly AgentToolContractOperation[],
): void {
  const index = buildToolContractIndex(operations);
  const contracts = new Map(operations.map((operation) => [operation.name, buildOperationContract(operation)]));
  const operationNames = [...contracts.keys()];

  server.registerResource(
    "tool-contracts",
    TOOL_CONTRACT_RESOURCE_URI,
    {
      title: "Work Intelligence operation index",
      description:
        "Operation ids with their dispatchers; read an operation's full contract at tool-contracts/<operation> before first use.",
      mimeType: "text/markdown",
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: index }] }),
  );

  server.registerResource(
    "tool-contract",
    new ResourceTemplate(TOOL_CONTRACT_OPERATION_URI_TEMPLATE, {
      list: undefined,
      complete: {
        operation: (value) => operationNames.filter((name) => name.startsWith(value)),
      },
    }),
    {
      title: "Work Intelligence operation contract",
      description: "One operation's dispatcher, annotations, behavior, JSON input schema, and validation rules.",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const operation = variables.operation;
      const text = typeof operation === "string" ? contracts.get(operation) : undefined;
      if (!text) throw new Error("Unknown Work Intelligence operation contract.");
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
    },
  );
}
