import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { architectureDiagramSchema } from "@work-intelligence/schema";
import { z } from "zod";

export interface AgentToolContractOperation {
  name: string;
  dispatcherName: string;
  title: string;
  description: string;
  inputShape: z.ZodObject["shape"];
  /** Original full runtime schema, including refinements and transforms not expressible in JSON Schema. */
  schema: z.ZodType;
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
      "Core instructions for every session: project opt-in and privacy, start of work, finalization, and links to the on-demand flow guides.",
    path: ".agents/skills/work-intelligence/SKILL.md",
  },
  {
    name: "work-intelligence-reading-records",
    uri: "work-intelligence://agent/work-intelligence/references/reading-records.md",
    title: "Reading records, context, and recall",
    description:
      "Partial Session reads, context omissions and supplements, recall ranking and confidence, and Knowledge search matches.",
    path: ".agents/skills/work-intelligence/references/reading-records.md",
  },
  {
    name: "work-intelligence-diagrams",
    uri: "work-intelligence://agent/work-intelligence/references/diagrams.md",
    title: "Session diagrams",
    description: "When and how to attach a validated architecture v1 diagram to a Session.",
    path: ".agents/skills/work-intelligence/references/diagrams.md",
  },
  {
    name: "work-intelligence-repair-and-backfill",
    uri: "work-intelligence://agent/work-intelligence/references/repair-and-backfill.md",
    title: "Repair and backfill Sessions",
    description: "Correcting a saved Session in place, records saved at task start, and metadata backfill.",
    path: ".agents/skills/work-intelligence/references/repair-and-backfill.md",
  },
  {
    name: "work-intelligence-outstanding-cleanup",
    uri: "work-intelligence://agent/work-intelligence/references/outstanding-cleanup.md",
    title: "Outstanding item cleanup",
    description: "Reviewing a Web-created 整理未結項 request through evidence-linked proposals.",
    path: ".agents/skills/work-intelligence/references/outstanding-cleanup.md",
  },
  {
    name: "work-intelligence-synthesis",
    uri: "work-intelligence://agent/work-intelligence/references/synthesis.md",
    title: "Report synthesis and writing",
    description: "Report synthesis by period, the ReportSummary field mapping, and source coverage.",
    path: ".agents/skills/work-intelligence/references/synthesis.md",
  },
  {
    name: "work-intelligence-knowledge",
    uri: "work-intelligence://agent/work-intelligence/references/knowledge.md",
    title: "Knowledge workflows",
    description: "Knowledge candidates, standing Knowledge pages, and recording Knowledge.",
    path: ".agents/skills/work-intelligence/references/knowledge.md",
  },
  {
    name: "work-record-and-report-format",
    uri: "work-intelligence://agent/work-record-and-report-format.md",
    title: "Work record and report format",
    description:
      "Canonical field definitions, evidence rules, reporting granularity, and examples referenced by the Work Intelligence skill.",
    path: "docs/work-record-and-report-format.md",
  },
  {
    name: "worklog-report-writing",
    uri: "work-intelligence://agent/worklog-report-writing/SKILL.md",
    title: "Work report writing",
    description: "Outcome-first bilingual writing with source and status fidelity.",
    path: ".agents/skills/worklog-report-writing/SKILL.md",
  },
  {
    name: "worklog-report-writing-en",
    uri: "work-intelligence://agent/worklog-report-writing/references/en.md",
    title: "Clear English work reports",
    description: "STE-inspired English writing, without a compliance claim.",
    path: ".agents/skills/worklog-report-writing/references/en.md",
  },
  {
    name: "worklog-report-writing-zh",
    uri: "work-intelligence://agent/worklog-report-writing/references/zh-TW.md",
    title: "Clear Traditional Chinese work reports",
    description: "Plain Traditional Chinese with stable technical terms.",
    path: ".agents/skills/worklog-report-writing/references/zh-TW.md",
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

/** Keep the advertised contract aligned with the schema's accepted input in Zod 4. */
function toJsonSchema(schema: z.ZodType): unknown {
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(schema, {
    target: "draft-7",
    io: "input",
    unrepresentable: "any",
    override: ({ zodSchema, jsonSchema }) => {
      if (zodSchema instanceof z.ZodObject) {
        const catchall = zodSchema._zod.def.catchall;
        if (catchall === undefined || catchall instanceof z.ZodNever) jsonSchema.additionalProperties = false;
      }
      if (
        zodSchema instanceof z.ZodString &&
        zodSchema._zod.def.checks?.some((check) => (check._zod.def as { format?: string }).format === "datetime")
      ) {
        delete jsonSchema.pattern;
      }
    },
  }) as Record<string, unknown>;
  return jsonSchema;
}

/** Exposes the complete agent contract through standard MCP resources for any connected client. */
export function registerAgentResources(server: McpServer): void {
  server.registerResource(
    "architecture-diagram-v1",
    "work-intelligence://agent/architecture-diagram-v1",
    {
      title: "Architecture diagram version 1",
      mimeType: "text/markdown",
      description: "Bounded JSON source format, reference validation, and author-defined paths; no executable HTML.",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: [
            "# Architecture diagram v1",
            "Send kind=architecture, formatVersion=1, source=JSON.stringify(data). New writes require explicit kind and version; historical Mermaid is read/import-only. Architecture source is limited to 100,000 characters, 200 nodes, 500 edges, 40 flat groups and 20 author-defined paths.",
            "Ids must be unique per collection and must not use credential prefixes sk- or xox[abprs]-. Every group and endpoint reference must exist. Path edgeIds must exist and connect in order; paths describe authored intent, not observed execution. Source paths are project-relative metadata only and never authorize file access. Unknown fields and unsupported versions are rejected. Labels/descriptions are escaped plain text, not HTML.",
            "```json",
            JSON.stringify(toJsonSchema(architectureDiagramSchema)),
            "```",
          ].join("\n"),
        },
      ],
    }),
  );
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
