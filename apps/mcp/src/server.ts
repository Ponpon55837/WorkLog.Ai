import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  attachDiagramInputSchema,
  attachEvidenceInputSchema,
  cancelMetadataBackfillRequestInputSchema,
  cancelReportSynthesisRequestInputSchema,
  contextQuerySchema,
  graphPathQuerySchema,
  graphQuerySchema,
  handoffImportApplyInputSchema,
  handoffImportOptionsSchema,
  knowledgeHistoryQuerySchema,
  knowledgePageContextQuerySchema,
  markKnowledgePageCheckedInputSchema,
  knowledgeQuerySchema,
  mcpCreateMetadataBackfillRequestInputSchema,
  mcpCreateReportSynthesisRequestInputSchema,
  mcpCreateReportSynthesisRequestInputObjectSchema,
  mcpFinalizeSessionInputSchema,
  mcpListSessionsInputSchema,
  mcpListSessionsInputSchemaBase,
  mcpOutstandingItemListQuerySchema,
  metadataBackfillApplyInputSchema,
  metadataBackfillPreviewQuerySchema,
  metadataBackfillRequestContextQuerySchema,
  metadataBackfillRequestQuerySchema,
  projectStatusQuerySchema,
  recallQuerySchema,
  recallQuerySchemaBase,
  recordKnowledgeInputSchema,
  requestKnowledgePageUpdateInputSchema,
  reportExportQueryObjectSchema,
  reportExportQuerySchema,
  reportQueryObjectSchema,
  reportQuerySchema,
  reportSynthesisContextQuerySchema,
  reportSynthesisRequestQuerySchema,
  reportSynthesisRequestQueryObjectSchema,
  retryReportSynthesisRequestInputSchema,
  saveKnowledgePageInputSchema,
  saveReportSummaryInputSchema,
  searchQuerySchema,
  searchQuerySchemaBase,
  sessionDetailQuerySchema,
  setEvidenceVoidInputSchema,
  setEvidenceVoidInputSchemaBase,
  setSessionVoidInputSchema,
  setSessionVoidInputSchemaBase,
  linkSessionsInputSchema,
  knowledgeCandidateContextQuerySchema,
  knowledgeCandidateContextQuerySchemaBase,
  requestKnowledgeCandidatesInputSchema,
  submitKnowledgeCandidatesInputSchema,
  updateKnowledgeInputSchema,
  updateKnowledgeInputSchemaBase,
  updateSessionMetadataInputSchema,
  updateSessionSummaryInputSchema,
  updateSessionWorkSummaryInputSchema,
  updateSessionWorkSummaryInputSchemaBase,
} from "@work-intelligence/schema";
import { truncateText } from "@work-intelligence/shared";
import type { McpRestartStatus } from "@work-intelligence/shared/mcp-runtime";
import {
  DATABASE_BUSY_MESSAGE,
  isDatabaseBusyError,
  toSessionDigests,
  type WorkIntelligenceStore,
} from "@work-intelligence/storage";
import {
  registerAgentResources,
  registerToolContractsResource,
  type AgentToolContractOperation,
} from "./agent-resources.js";
import {
  implementationDetail,
  knowledgeCandidateContract,
  knowledgePageContract,
  metadataBackfillContract,
  reportSynthesisContract,
  serverInstructions,
  workRecordContract,
} from "./contracts.js";
import { parseMcpInput } from "./input.js";
import { sessionTextResult, textResult } from "./result.js";

interface StoreToolDefinition<S extends z.ZodTypeAny> {
  title: string;
  description: string;
  /** Advertised input shape; may be the unrefined base object of `schema`. */
  inputShape: z.ZodRawShape;
  /** Full validation schema, including cross-field refinements. */
  schema: S;
  annotations: ToolAnnotations;
  /** Rules that are enforced by runtime refinements or handler logic rather than JSON Schema alone. */
  validationNotes?: readonly string[];
  invalidMessage: string;
  /** Session-shaped results also expose sessionId/verification as structuredContent. */
  sessionResult?: boolean;
  /** Attach the process build status to this operation's result. */
  includeServerStatus?: boolean;
  run: (input: z.infer<S>) => unknown;
}

export interface McpStartupFailure {
  code: string;
  message: string;
}

interface RegisteredStoreTool extends AgentToolContractOperation {
  invoke: (input: unknown) => Promise<CallToolResult>;
}

interface ToolDispatcherDefinition {
  name: string;
  title: string;
  description: string;
  annotations: ToolAnnotations;
}

type OutstandingItemListPage = Extract<
  ReturnType<WorkIntelligenceStore["listOutstandingItems"]>,
  { outcome: "outstanding_items" }
>;
type OutstandingItemTruncationMarker =
  | "projectNameTruncated"
  | "sourceSessionTitleTruncated"
  | "sourceSessionCompletedAtTruncated"
  | "textTruncated"
  | "createdAtTruncated"
  | "updatedAtTruncated";
type OutstandingItemDisplayKey =
  "projectName" | "sourceSessionTitle" | "sourceSessionCompletedAt" | "text" | "createdAt" | "updatedAt";
interface OutstandingItemDisplayField {
  key: OutstandingItemDisplayKey;
  marker: OutstandingItemTruncationMarker;
}
type OutstandingItemResponseItem = OutstandingItemListPage["items"][number] &
  Partial<Record<OutstandingItemTruncationMarker, true>>;
type OutstandingItemsResponse = Omit<OutstandingItemListPage, "items"> & {
  items: OutstandingItemResponseItem[];
  responseBudget?: {
    limit: number;
    omittedCount: number;
    omissions: Array<{ rowOnPage: number; reason: string }>;
    readWith: "Web UI or project export";
  };
};

/** Reads only the central SQLite; nothing outside the tracked-project registry is touched. */
const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
const OUTSTANDING_ITEM_TEXT_LENGTH = 4_000;
const OUTSTANDING_ITEM_RESPONSE_LIMIT = 30_000;
const OUTSTANDING_ITEM_DISPLAY_FIELDS: readonly OutstandingItemDisplayField[] = [
  { key: "projectName", marker: "projectNameTruncated" },
  { key: "sourceSessionTitle", marker: "sourceSessionTitleTruncated" },
  { key: "sourceSessionCompletedAt", marker: "sourceSessionCompletedAtTruncated" },
  { key: "text", marker: "textTruncated" },
  { key: "createdAt", marker: "createdAtTruncated" },
  { key: "updatedAt", marker: "updatedAtTruncated" },
];
/** Adds records or advances request state; retrying the same payload has no further effect. */
const ADDITIVE_IDEMPOTENT: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
/** Creates a new record or attempt on every call. */
const ADDITIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
/** Can replace existing values (the previous state stays in audit history where the tool says so). */
const OVERWRITE_IDEMPOTENT: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

const TOOL_DISPATCHERS: readonly ToolDispatcherDefinition[] = [
  {
    name: "work_read",
    title: "Read Work Intelligence",
    description:
      "Run one read-only Work Intelligence operation. Read the operation catalog for its complete schema and result rules. If a result's server.restartRequired is true, tell the user to reconnect the MCP before continuing.",
    annotations: READ_ONLY,
  },
  {
    name: "work_write_idempotent",
    title: "Write Work Intelligence records",
    description: "Run one idempotent additive write. Read its complete contract before the first write.",
    annotations: ADDITIVE_IDEMPOTENT,
  },
  {
    name: "work_write_additive",
    title: "Add Work Intelligence records or proposals",
    description:
      "Create an additive record, request, proposal, or processing attempt; repeated calls may create another item. Read its complete contract first.",
    annotations: ADDITIVE,
  },
  {
    name: "work_write_overwrite",
    title: "Update or void Work Intelligence records",
    description:
      "Update, link, void, or restore existing data with destructive, idempotent semantics. Read its complete contract and verify scope before writing.",
    annotations: OVERWRITE_IDEMPOTENT,
  },
];

function truncateAtCodeUnitLimit(value: string, limit: number): { text: string; truncated: boolean } {
  if (value.length <= limit) return { text: value, truncated: false };
  if (limit <= 0) return { text: "", truncated: true };

  let prefixLength = limit - 1;
  const lastPrefixCodeUnit = value.charCodeAt(prefixLength - 1);
  const nextCodeUnit = value.charCodeAt(prefixLength);
  if (
    lastPrefixCodeUnit >= 0xd800 &&
    lastPrefixCodeUnit <= 0xdbff &&
    nextCodeUnit >= 0xdc00 &&
    nextCodeUnit <= 0xdfff
  ) {
    prefixLength -= 1;
  }
  return { text: `${value.slice(0, prefixLength)}…`, truncated: true };
}

function serializedResponseLength(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}

function budgetOutstandingItemsResponse(result: OutstandingItemListPage): OutstandingItemsResponse {
  const items = result.items.map((item): OutstandingItemResponseItem => {
    const boundedText = truncateAtCodeUnitLimit(item.text, OUTSTANDING_ITEM_TEXT_LENGTH);
    return {
      ...item,
      text: boundedText.text,
      ...(boundedText.truncated ? { textTruncated: true } : {}),
    };
  });
  const response: OutstandingItemsResponse = { ...result, items };
  if (serializedResponseLength(response) <= OUTSTANDING_ITEM_RESPONSE_LIMIT) return response;

  const maximumDisplayLength = Math.max(
    0,
    ...items.flatMap((item) => OUTSTANDING_ITEM_DISPLAY_FIELDS.map(({ key }) => item[key].length)),
  );
  const applyDisplayLimit = (limit: number): OutstandingItemResponseItem[] =>
    items.map((source) => {
      const bounded = { ...source };
      for (const field of OUTSTANDING_ITEM_DISPLAY_FIELDS) {
        const shortened = truncateAtCodeUnitLimit(source[field.key], limit);
        bounded[field.key] = shortened.text;
        if (shortened.truncated || source[field.marker] === true) {
          bounded[field.marker] = true;
        } else {
          delete bounded[field.marker];
        }
      }
      return bounded;
    });

  response.items = applyDisplayLimit(0);
  if (serializedResponseLength(response) <= OUTSTANDING_ITEM_RESPONSE_LIMIT) {
    let low = 0;
    let high = maximumDisplayLength;
    let bestLimit = 0;
    while (low <= high) {
      const candidateLimit = Math.floor((low + high) / 2);
      response.items = applyDisplayLimit(candidateLimit);
      if (serializedResponseLength(response) <= OUTSTANDING_ITEM_RESPONSE_LIMIT) {
        bestLimit = candidateLimit;
        low = candidateLimit + 1;
      } else {
        high = candidateLimit - 1;
      }
    }
    response.items = applyDisplayLimit(bestLimit);
    return response;
  }

  const remainingItems = response.items.map((item, index) => ({ item, index }));
  const omittedRows: Array<{ rowOnPage: number; reason: string }> = [];
  const updateBudgetOmissions = (): void => {
    response.responseBudget = {
      limit: OUTSTANDING_ITEM_RESPONSE_LIMIT,
      omittedCount: omittedRows.length,
      omissions: [...omittedRows].sort((left, right) => left.rowOnPage - right.rowOnPage),
      readWith: "Web UI or project export",
    };
  };

  while (serializedResponseLength(response) > OUTSTANDING_ITEM_RESPONSE_LIMIT && remainingItems.length > 0) {
    let largestItemIndex = 0;
    let largestItemSize = -1;
    remainingItems.forEach(({ item }, index) => {
      const itemSize = serializedResponseLength(item);
      if (itemSize > largestItemSize) {
        largestItemIndex = index;
        largestItemSize = itemSize;
      }
    });
    const [omitted] = remainingItems.splice(largestItemIndex, 1);
    if (!omitted) break;
    omittedRows.push({
      rowOnPage: omitted.index + 1,
      reason: "Stable identifiers alone exceed the 30,000-code-unit MCP response limit.",
    });
    response.items = remainingItems.map(({ item }) => item);
    updateBudgetOmissions();
  }

  if (serializedResponseLength(response) > OUTSTANDING_ITEM_RESPONSE_LIMIT) {
    response.items = [];
    for (const { index } of remainingItems) {
      omittedRows.push({
        rowOnPage: index + 1,
        reason: "Stable identifiers alone exceed the 30,000-code-unit MCP response limit.",
      });
    }
    updateBudgetOmissions();
  }
  return response;
}

function dispatcherForAnnotations(annotations: ToolAnnotations): ToolDispatcherDefinition {
  const dispatcher = TOOL_DISPATCHERS.find(
    (candidate) =>
      candidate.annotations.readOnlyHint === annotations.readOnlyHint &&
      candidate.annotations.destructiveHint === annotations.destructiveHint &&
      candidate.annotations.idempotentHint === annotations.idempotentHint &&
      candidate.annotations.openWorldHint === annotations.openWorldHint,
  );
  if (!dispatcher) throw new Error("Unsupported MCP tool annotation combination.");
  return dispatcher;
}

function createDispatcherSchema(operations: readonly RegisteredStoreTool[]) {
  const [first, ...rest] = operations.map((operation) => operation.name);
  if (!first) throw new Error("MCP tool dispatcher cannot be empty.");
  return z
    .object({
      operation: z.enum([first, ...rest] as [string, ...string[]]),
      arguments: z.record(z.unknown()).optional(),
    })
    .strict();
}

function registerToolDispatchers(server: McpServer, operations: Map<string, RegisteredStoreTool>): void {
  for (const dispatcher of TOOL_DISPATCHERS) {
    const members = [...operations.values()].filter((operation) => operation.dispatcherName === dispatcher.name);
    const inputSchema = createDispatcherSchema(members);
    server.registerTool(
      dispatcher.name,
      {
        title: dispatcher.title,
        description: dispatcher.description,
        inputSchema,
        annotations: { title: dispatcher.title, ...dispatcher.annotations },
      },
      async (input: unknown) => {
        const parsed = parseMcpInput(inputSchema, input);
        if (!parsed.success) {
          return {
            isError: true,
            ...textResult({
              code: "INVALID_OPERATION_CALL",
              error: "Invalid Work Intelligence operation call.",
              details: parsed.error.flatten(),
            }),
          };
        }
        const operation = operations.get(parsed.data.operation);
        if (!operation || operation.dispatcherName !== dispatcher.name) {
          return {
            isError: true,
            ...textResult({ code: "UNKNOWN_OPERATION", error: "Operation is not available through this dispatcher." }),
          };
        }
        return operation.invoke(parsed.data.arguments ?? {});
      },
    );
  }
}

function compactSearchExcerpt(
  value: string,
  terms: readonly string[],
  maxLength: number,
): { text: string; truncated: boolean } {
  if (value.length <= maxLength) return { text: value, truncated: false };
  const lower = value.toLocaleLowerCase();
  const position = terms.reduce((best, term) => {
    const found = lower.indexOf(term);
    return found >= 0 && (best < 0 || found < best) ? found : best;
  }, -1);
  const leadingMarker = position > Math.floor(maxLength / 3);
  const contentLength = maxLength - (leadingMarker ? 2 : 1);
  const start = Math.max(
    0,
    Math.min(position < 0 ? 0 : position - Math.floor(contentLength / 3), value.length - contentLength),
  );
  return {
    text: `${start > 0 ? "…" : ""}${value.slice(start, start + contentLength).trimEnd()}…`,
    truncated: true,
  };
}

function withServerRestartStatus(result: unknown, getRestartStatus: () => McpRestartStatus): unknown {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return { ...result, server: getRestartStatus() };
  }
  return { result, server: getRestartStatus() };
}

export function createWorkIntelligenceMcpServer(
  storeOrUnavailable: WorkIntelligenceStore | null,
  version: string,
  schemaVersion: number,
  startupFailure?: McpStartupFailure,
  getRestartStatus: () => McpRestartStatus = () => ({ restartRequired: false, monitoringAvailable: false }),
): McpServer {
  if (!storeOrUnavailable && !startupFailure) {
    throw new Error("An initialized store or a startup failure is required to create the MCP server.");
  }

  const store = storeOrUnavailable as WorkIntelligenceStore;
  const failureInstructions = startupFailure
    ? ` Database startup failed (${startupFailure.code}): ${startupFailure.message} All tools return this startup error until the MCP process is restarted.`
    : "";
  const instructions = `${serverInstructions} Application version: ${version}; schema version: ${schemaVersion}.${failureInstructions}`;
  const server = new McpServer({ name: "work-intelligence", version }, { instructions });
  registerAgentResources(server);
  const registeredStoreTools = new Map<string, RegisteredStoreTool>();

  function registerStoreTool<S extends z.ZodTypeAny>(name: string, definition: StoreToolDefinition<S>): void {
    if (registeredStoreTools.has(name)) throw new Error(`Duplicate MCP operation: ${name}`);
    const dispatcher = dispatcherForAnnotations(definition.annotations);
    registeredStoreTools.set(name, {
      name,
      dispatcherName: dispatcher.name,
      title: definition.title,
      description: definition.description,
      inputShape: definition.inputShape,
      schema: definition.schema,
      validationNotes: definition.validationNotes,
      annotations: { title: definition.title, ...definition.annotations },
      invoke: async (input: unknown) => {
        if (startupFailure) {
          return {
            isError: true,
            ...textResult({ code: startupFailure.code, error: startupFailure.message }),
          };
        }

        const parsed = parseMcpInput(definition.schema, input);
        if (!parsed.success) {
          return {
            isError: true,
            ...textResult({ error: definition.invalidMessage, details: parsed.error.flatten() }),
          };
        }
        try {
          const result = await definition.run(parsed.data);
          const output = definition.includeServerStatus ? withServerRestartStatus(result, getRestartStatus) : result;
          return definition.sessionResult ? sessionTextResult(output) : textResult(output);
        } catch (error) {
          if (!isDatabaseBusyError(error)) {
            throw error;
          }
          return {
            isError: true,
            ...textResult({ code: "DATABASE_BUSY", error: DATABASE_BUSY_MESSAGE }),
          };
        }
      },
    });
  }

  // ── Project and Session ────────────────────────────────────────────────

  registerStoreTool("work_get_project_status", {
    title: "Get project recording status",
    description:
      "Return whether a workspace root is tracked, paused, ignored, or unregistered in Work Intelligence, plus MCP build status. Call this before preparing a finalize payload: only tracked projects are recorded. The result includes clock (serverTime, timeZone, utcOffset): take the current time from it, never from your own estimate. If server.restartRequired is true, tell the user to reconnect the MCP before continuing. This is read-only and cannot change recording status; only the user can do that in the Web UI.",
    inputShape: projectStatusQuerySchema.shape,
    schema: projectStatusQuerySchema,
    annotations: READ_ONLY,
    invalidMessage: "Invalid project status query.",
    includeServerStatus: true,
    run: (input) => store.getProjectStatus(input.projectRoot),
  });

  registerStoreTool("work_finalize_session", {
    title: "Finalize a work session",
    description:
      "Finalize a completed planning/execution/verification/closing session. Provide summary plus the required five-section workSummary; inspect the worktree and provide changedFiles (use [] only when no files were intentionally changed) plus an explicit verification status: passed, failed, or not_run. When known, provide baselineChangedFiles captured at the start of this work; those paths are excluded from the Session's changed files. A file already changed at the baseline is excluded even if edited again during this work; a rename from a baseline path is recorded as an added file. Optionally provide changedFilesProvenance with Agent, handoff, Git, or worktree evidence references and changedFileChanges with added, modified, deleted, or renamed semantics (renamed requires previousPath). If this work relied on recalled Knowledge, report appliedKnowledgeIds (still valid; confirms them) and contradictedKnowledgeIds (no longer true; flags them for review); link an earlier Session this one continues with parentSessionId. Times: omit completedAt for work that just finished, because the server records the current time; set it only to backfill earlier work from evidence (for example a commit time), with its UTC offset. Report startedAt only from evidence: the first message of this segment, which the save reminder hook states when it fires, or a transcript timestamp; include the UTC offset and never estimate it (omit it when unknown). Future times are rejected, and implausible ones come back as timestampWarnings; fix them with work_update_session_metadata. Sessions also carry updatedAt, the last change after finalize. This is independent from Git commit. The project must be explicitly tracked; unregistered, paused, and ignored projects are skipped without reading handoff, Git, or source files. The idempotencyKey makes retries safe. If legacy data is missing verification, changedFiles, or workSummary, the response includes a follow-up instruction. " +
      "Optionally pass resolvedOutstandingItemIds only for pending items from this same tracked project that this work directly verified as completed; each valid pending→completed transition is recorded in the Session transaction and audited. No item is inferred complete from nextSteps wording. " +
      "Sensitive values in Session text are masked before storage; the result reports redaction counts by type only and never returns a token fragment. " +
      workRecordContract,
    inputShape: mcpFinalizeSessionInputSchema.shape,
    schema: mcpFinalizeSessionInputSchema,
    validationNotes: [
      "A changedFileChanges entry with status=renamed must include previousPath.",
      "Timestamps with offsets are normalized to UTC; future values are rejected. If startedAt is after completedAt, it is not applied and the result includes a timestamp warning.",
    ],
    annotations: ADDITIVE_IDEMPOTENT,
    invalidMessage: "Invalid finalize payload.",
    sessionResult: true,
    run: (input) => store.finalizeSession(input),
  });

  registerStoreTool("work_get_session", {
    title: "Get one work session",
    description:
      "Return one tracked Session with its five-section workSummary, decision provenance and review state, changed files, verification, events, evidence, and linked Knowledge. Raw handoff snapshot content is omitted (only its length is returned) unless includeRawSnapshots is true. Sessions of non-tracked projects are skipped quietly.",
    inputShape: sessionDetailQuerySchema.shape,
    schema: sessionDetailQuerySchema,
    annotations: READ_ONLY,
    invalidMessage: "Invalid session query.",
    run: (input) => store.getSessionDetailForAgent(input),
  });

  registerStoreTool("work_list_sessions", {
    title: "List work sessions",
    description:
      "List finalized tracked-project Session digests, newest first, with optional keyword (q), inclusive from/to calendar dates in the server's local time zone, a projectRoot or projectId scope, and voided (exclude by default, include, or only). Each digest has a truncated summary, verification status, changed-file count, and up to three nextSteps items currently marked pending; it omits changed-file paths, events, evidence, and full workSummary. Results are paged (pageSize up to 100) and include pageInfo.total. Read one full record with work_get_session. Non-tracked scopes are skipped quietly.",
    inputShape: mcpListSessionsInputSchemaBase.shape,
    schema: mcpListSessionsInputSchema,
    validationNotes: [
      "When both from and to are supplied, to must be on or after from (inclusive YYYY-MM-DD calendar dates in server time zone).",
    ],
    annotations: READ_ONLY,
    invalidMessage: "Invalid session list query.",
    run: (input) => {
      const result = store.listSessionsForAgent(input);
      if (result.outcome !== "sessions") return result;
      const pendingItems = store.pendingOutstandingItemsForSessions(result.items.map((session) => session.id));
      return { ...result, items: toSessionDigests(result.items, pendingItems) };
    },
  });

  registerStoreTool("work_list_outstanding_items", {
    title: "List outstanding work items",
    description:
      "List source-linked nextSteps items from tracked Sessions, newest source Session first. status defaults to pending and may select completed or not_needed; pageSize defaults to 5 and is capped at 5. The serialized response is capped at 30,000 JavaScript characters; display text, title, project name, and timestamps may be shortened and carry a matching Truncated flag, while identifiers remain complete. If an identifier alone cannot fit, responseBudget lists its row on this page and points to the Web UI or project export; pageInfo remains available. A text up to 4,000 characters is returned unchanged when the response fits. This is read-only; update status in the Web UI, and only resolve pending items you verified as completed by passing their ids to work_finalize_session. A projectRoot is policy-gated before reading; untracked projects are skipped quietly.",
    inputShape: mcpOutstandingItemListQuerySchema.shape,
    schema: mcpOutstandingItemListQuerySchema,
    annotations: READ_ONLY,
    invalidMessage: "Invalid outstanding item query.",
    run: (input) => {
      const result = store.listOutstandingItems(input);
      if (result.outcome !== "outstanding_items") return result;
      return budgetOutstandingItemsResponse(result);
    },
  });

  registerStoreTool("work_recall", {
    title: "Recall related work",
    description:
      'Ranked recall across tracked-project Sessions (title, summary, five-section workSummary, changed files, branch, events, and raw handoff sections) and active Knowledge. Use it before starting a task (describe the task in q and pass the files you will change as paths), when an error appears (pass the error message), or when the user asks about past work. Multi-word and Chinese queries are supported; words are matched independently and records containing more of them rank higher. Structured Session fields (title, summary, and workSummary) carry more weight than raw handoff text. Raw section content is normalized and hashed per project; only the earliest Session reference keeps full raw weight and later duplicates are downweighted. This helps completed implementation records rank ahead of repeated old planning excerpts while keeping raw-only answers searchable. paths match changed files and Knowledge references by path suffix (absolute, project-prefixed, or relative). Returns confidence plus ranked hits with id, type, title, the strongest matchedIn field, raw section heading, an excerpt capped at 110 characters, and score; truncated excerpts are marked. confidence is "none" when no hit has meaningful query coverage or a path match, "low" for weak partial matches or matches found only in raw handoff text, and "high" when a hit matches most of the query in its title, summary, workSummary, or Knowledge, or matches a path. When confidence is "none", hits is empty and you must not use the result as evidence; rephrase the query or try a path. Hits keep only their strongest matchedIn field, raw section headings are capped at 24 characters, and related Session links keep their ids and relations without repeating titles. With projectRoot, the repeated top-level project object is omitted. Read full records with work_get_session or work_search_knowledge and cite the sessionId or knowledgeId you rely on. termHits lists words that matched nothing so you can rephrase. When the user names a time ("last week", "in June", "yesterday"), pass from and/or to as calendar dates in the server time zone (get today from work_get_project_status clock); Sessions are dated by completion and Knowledge by its last update. A projectRoot scope is policy-gated first.',
    inputShape: recallQuerySchemaBase.shape,
    schema: recallQuerySchema,
    validationNotes: [
      "At least one of q or a non-empty paths array is required; both may be supplied.",
      "When both from and to are supplied, to must be on or after from (inclusive YYYY-MM-DD calendar dates in server time zone).",
    ],
    annotations: READ_ONLY,
    invalidMessage: "Invalid recall query.",
    run: (input) => {
      const result = store.recall(input);
      if (result.outcome !== "recall") return result;
      const hits = result.hits.map((hit) => ({
        ...hit,
        matchedIn: hit.matchedIn.slice(0, 1),
        ...(hit.section ? { section: truncateText(hit.section, 24) } : {}),
        ...(hit.related ? { related: hit.related.map(({ id, relation }) => ({ id, relation })) } : {}),
      }));
      if (!input.projectRoot) return { ...result, hits };
      return {
        outcome: result.outcome,
        confidence: result.confidence,
        hits,
        ...(result.termHits ? { termHits: result.termHits } : {}),
      };
    },
  });

  registerStoreTool("work_search", {
    title: "Search work history",
    description:
      'Search finalized work sessions with the same ranked engine as work_recall, Sessions only (up to 20 compact hits with id, title, date, matchedIn, optional raw section heading, excerpt capped at 110 characters, and verificationStatus; truncated excerpts are marked). Structured Session fields carry more weight than raw handoff text; repeated raw planning excerpts after the earliest project reference are downweighted. Returns { outcome: "search", confidence, hits, termHits? }. confidence is "none" when no hit has meaningful query coverage, "low" for weak partial matches or matches found only in raw handoff text, and "high" when a hit matches most of the query in its title, summary, or workSummary. When confidence is "none", hits is empty and you must not use the result as evidence; rephrase the query. When title is the strongest match and the Session summary also matches a query term, the excerpt uses the summary to keep answer context. A project-scoped result omits repeated project identifiers. Prefer work_recall, which also returns Knowledge and accepts paths. Read the full record with work_get_session. Pass from and/or to (YYYY-MM-DD, server time zone) when the user names a time such as last week or June. Search is limited to tracked projects, and a projectRoot query is policy-gated before any project-scoped access.',
    inputShape: searchQuerySchemaBase.shape,
    schema: searchQuerySchema,
    validationNotes: [
      "When both from and to are supplied, to must be on or after from (inclusive YYYY-MM-DD calendar dates in server time zone).",
    ],
    annotations: READ_ONLY,
    invalidMessage: "Invalid search query.",
    run: (input) => {
      const result = store.searchForAgent(input.q, input.projectRoot, { from: input.from, to: input.to });
      if (result.outcome !== "search") return result;
      const queryTerms = input.q.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
      const hits = result.hits.map(({ session, matchedIn, section, excerpt }) => {
        const summary = session.summary.toLocaleLowerCase();
        const excerptSource =
          matchedIn === "title" && queryTerms.some((term) => summary.includes(term)) ? session.summary : excerpt;
        const compactExcerpt = compactSearchExcerpt(excerptSource, queryTerms, 110);
        return {
          id: session.id,
          ...(!input.projectRoot
            ? { projectId: session.projectId, ...(session.projectName ? { projectName: session.projectName } : {}) }
            : {}),
          title: session.title,
          date: session.completedAt,
          matchedIn,
          ...(section ? { section: truncateText(section, 80) } : {}),
          excerpt: compactExcerpt.text,
          ...(compactExcerpt.truncated ? { truncated: true } : {}),
          verificationStatus: session.verificationStatus,
        };
      });
      return {
        outcome: result.outcome,
        confidence: result.confidence,
        hits,
        ...(result.termHits ? { termHits: result.termHits } : {}),
      };
    },
  });

  registerStoreTool("work_get_context", {
    title: "Get work context",
    description:
      'Return recent tracked-project digests, metadataFollowUps counts, pending Agent requests, the server clock, and MCP build status. Outstanding nextSteps items exposed by context are pending only. The top-level pendingOutstandingItems list includes each source Session id, title, and completion time, at most 5 items, and text capped at 500 characters; it reports the total, omitted count, and text-truncation count, and marks truncated text. Use read-only work_list_outstanding_items to read the complete paged list, including completed and not_needed items. Pass task and/or paths for task-first relevant Knowledge, decisions, Sessions with open items, hotspots, and matching Knowledge-page sections. If server.restartRequired is true, tell the user to reconnect the MCP before continuing. relevant.confidence is "none" when no result has meaningful query coverage or a path match, "low" for weak partial matches or raw-handoff-only matches, and "high" for strong structured or path matches; when it is "none", relevant.knowledge and relevant.sessions are empty and must not be used as evidence. With a focus, the complete compact JSON response is capped at 10,000 characters; without a focus it is capped at 16,000. Relevant results come before recent activity, and duplicate Session/Knowledge content appears once. Check omitted: per section it gives count, duplicates (already shown elsewhere in this response), up to 5 ids with reasons for budget omissions plus moreIds, full entries for anything flagged possiblyStale or needsReview, and readWith, the tool that reads the full item; truncated excerpts are marked. Pending requests and possiblyStale/needsReview flags are retained. Knowledge page citation ids are bounded to 8 per context with sourceSessionIdsOmittedCount when needed. Knowledge pages include needsReview and bounded reviewSections when a cited Session changed, was voided, or was restored after the page was saved; shown source ids, titles, and reason codes are supplemented with omittedSourceCount and reason summaries when necessary. Use work_get_session, work_search_knowledge, work_get_knowledge_page_context, and work_preview_metadata_backfill to read full records. Pending Agent-autonomous decisions expose only their count; review actions remain in the Web UI. With projectRoot, the project policy gate is checked first and non-tracked projects are quietly skipped.',
    inputShape: contextQuerySchema.shape,
    schema: contextQuerySchema,
    annotations: READ_ONLY,
    invalidMessage: "Invalid context query.",
    includeServerStatus: true,
    run: (input) => store.getContext(input.projectRoot, { task: input.task, paths: input.paths }),
  });

  registerStoreTool("work_update_session_metadata", {
    title: "Update session metadata",
    description:
      "Backfill confirmed verification and changed-files metadata on an existing session without creating a duplicate. The Agent must inspect the worktree/diff first and provide the confirmed changedFiles list; use [] only when the work intentionally changed no files. By default changedFilesMode is replace; use changedFilesMode=merge for a separately verified stage or later commit so paths and provenance are safely unioned and deduplicated. Optionally provide changedFilesProvenance and changedFileChanges. It can also correct startedAt and completedAt from evidence (never estimates): a completedAt correction is kept as a note event on the Session, and a value that would put startedAt after completedAt is not applied and is reported in timestampWarnings. Non-tracked projects are skipped quietly.",
    inputShape: updateSessionMetadataInputSchema.shape,
    schema: updateSessionMetadataInputSchema,
    validationNotes: [
      "A changedFileChanges entry with status=renamed must include previousPath.",
      "Timestamps with offsets are normalized to UTC; future values are rejected. If startedAt is after completedAt, it is not applied and the result includes a timestamp warning.",
    ],
    annotations: OVERWRITE_IDEMPOTENT,
    invalidMessage: "Invalid session metadata payload.",
    sessionResult: true,
    run: (input) => store.updateSessionMetadata(input),
  });

  registerStoreTool("work_update_session_summary", {
    title: "Update a finalized session summary",
    description:
      "Update the primary summary text of an existing finalized Session without creating a new Session. mode=replace replaces the complete summary; mode=append adds a clearly separated follow-up paragraph. changedFiles, verification, events, evidence, handoff snapshots, and the Session id are preserved. It has its own idempotencyKey; retrying the same payload never appends twice. Sensitive values are masked; the result reports counts by type only and never returns a token fragment. Non-tracked projects are skipped quietly.",
    inputShape: updateSessionSummaryInputSchema.shape,
    schema: updateSessionSummaryInputSchema,
    annotations: OVERWRITE_IDEMPOTENT,
    invalidMessage: "Invalid session summary payload.",
    sessionResult: true,
    run: (input) => store.updateSessionSummary(input),
  });

  registerStoreTool("work_update_session_work_summary", {
    title: "Update a finalized session work summary",
    description:
      "Update the structured five-section workSummary of an existing finalized Session. mode=replace needs all five sections; mode=patch merges one or more confirmed sections (a legacy missing workSummary starts from empty arrays). The Session id, idempotencyKey, changedFiles, verification, events, evidence, handoff snapshots, and Git metadata are preserved. It has its own idempotencyKey; retries never repeat a change. Non-tracked projects are skipped quietly. " +
      "Sensitive values are masked before storage; the result reports redaction counts by type only and never returns a token fragment. " +
      workRecordContract,
    inputShape: updateSessionWorkSummaryInputSchemaBase.shape,
    schema: updateSessionWorkSummaryInputSchema,
    validationNotes: [
      "mode=replace requires all five workSummary arrays: outcomes, scope, decisions, verification, and nextSteps.",
      "mode=patch must provide at least one workSummary section.",
    ],
    annotations: OVERWRITE_IDEMPOTENT,
    invalidMessage: "Invalid session workSummary payload.",
    sessionResult: true,
    run: (input) => store.updateSessionWorkSummary(input, "agent"),
  });

  registerStoreTool("work_void_session", {
    title: "Void or restore a work session",
    description:
      "Void a Session that was recorded by mistake or as a test (voided: true, with a reason), or restore it (voided: false). This is a reversible soft-delete: the Session stays readable with work_get_session and every change is audited, but a voided Session leaves Session lists, reports, the graph, context, and recall. Sensitive values in reasons are masked; results report counts by type only. Only void when the user asks or confirms; never void to hide real but unwanted work. Non-tracked projects are skipped quietly.",
    inputShape: setSessionVoidInputSchemaBase.shape,
    schema: setSessionVoidInputSchema,
    validationNotes: ["voided=true requires a non-empty reason; voided=false may omit it."],
    annotations: OVERWRITE_IDEMPOTENT,
    invalidMessage: "Invalid session void payload.",
    run: (input) => store.setSessionVoid(input),
  });

  registerStoreTool("work_link_sessions", {
    title: "Link related work sessions",
    description:
      "Link two tracked Sessions so finding one leads to the other: relation continues means sessionId continues relatedSessionId's work (e.g. the implementation of a planning Session), related is a plain association. A pair has one link; a new relation replaces the old one, and linked: false removes it. Links appear in work_get_session, as related on work_recall hits, and in the graph. When finalizing, you can pass parentSessionId or relatedSessionIds instead. Link only when the relationship is confirmed by the user or the records themselves.",
    inputShape: linkSessionsInputSchema.shape,
    schema: linkSessionsInputSchema,
    annotations: OVERWRITE_IDEMPOTENT,
    invalidMessage: "Invalid session link payload.",
    run: (input) => store.linkSessions(input),
  });

  registerStoreTool("work_void_evidence", {
    title: "Mark evidence as wrong or restore it",
    description:
      "Mark an attached evidence reference as wrong (voided: true, with a reason) or restore it (voided: false). Voided evidence stays in Session detail with its reason but is left out of reports and the graph; every change is audited. Attach corrected evidence separately with work_attach_evidence. Non-tracked projects are skipped quietly.",
    inputShape: setEvidenceVoidInputSchemaBase.shape,
    schema: setEvidenceVoidInputSchema,
    validationNotes: ["voided=true requires a non-empty reason; voided=false may omit it."],
    annotations: OVERWRITE_IDEMPOTENT,
    invalidMessage: "Invalid evidence void payload.",
    run: (input) => store.setEvidenceVoid(input),
  });

  registerStoreTool("work_attach_evidence", {
    title: "Attach session evidence",
    description:
      "Attach an explicit evidence reference to an existing tracked Session, such as a test result, command output, source document, or review link. Only the supplied reference and summary are stored; the referenced source is never read. Sensitive values are masked; the result reports counts by type only and never returns a token fragment. Duplicate session/kind/reference submissions are idempotent, and non-tracked projects are skipped quietly.",
    inputShape: attachEvidenceInputSchema.shape,
    schema: attachEvidenceInputSchema,
    annotations: ADDITIVE_IDEMPOTENT,
    invalidMessage: "Invalid evidence payload.",
    run: (input) => store.attachEvidence(input),
  });

  registerStoreTool("work_attach_diagram", {
    title: "Attach a diagram to a Session",
    description:
      "Attach a Mermaid diagram (flowchart, sequenceDiagram, stateDiagram, erDiagram, …) that explains a tracked Session's work, such as the flow or data path it changed; finalize also accepts up to five diagrams. Use it on your own, without being asked, when the work changed a cross-module flow or data path, a state machine, an architecture, or a multi-step process (at most two per Session); skip small fixes, styling, configuration, and test-only work. Only attach a diagram of what the recorded work actually did. The Web UI renders it in the Session panel and shows the source if it does not render. Sensitive values are masked; the result reports counts by type only. The same idempotencyKey returns the saved diagram; a different diagram under a used key is refused. Diagrams can be voided in the Web UI, never deleted. Non-tracked projects are skipped quietly.",
    inputShape: attachDiagramInputSchema.shape,
    schema: attachDiagramInputSchema,
    annotations: ADDITIVE_IDEMPOTENT,
    invalidMessage: "Invalid diagram payload.",
    run: (input) => store.attachDiagram(input),
  });

  // ── Knowledge ──────────────────────────────────────────────────────────

  registerStoreTool("work_record_knowledge", {
    title: "Record explicit work knowledge",
    description:
      "Store an explicitly confirmed decision, pattern, gotcha, procedure, or skill for a tracked project, optionally linked to a finalized Session. Set appliesTo to the project-relative paths or globs it is about, so it is flagged possiblyStale when a later Session changes them; set supersedesId to archive the older Knowledge it replaces. Knowledge is never extracted from source files or handoffs automatically. Sensitive values are masked; the result reports counts by type only and never returns a token fragment. idempotencyKey retries return the original record, and non-tracked projects are skipped quietly.",
    inputShape: recordKnowledgeInputSchema.shape,
    schema: recordKnowledgeInputSchema,
    annotations: ADDITIVE_IDEMPOTENT,
    invalidMessage: "Invalid knowledge payload.",
    run: (input) => store.recordKnowledge(input),
  });

  registerStoreTool("work_search_knowledge", {
    title: "Search recorded work knowledge",
    description:
      'Search explicitly recorded knowledge by title, body, tags, references, project, or kind, newest first. Each space-separated word (or "quoted phrase") must appear in some field, so several words narrow the list; use work_recall for ranked matching of looser questions. Results are limited to active knowledge from tracked projects by default; a projectRoot or projectId scope is policy-gated before returning data.',
    inputShape: knowledgeQuerySchema.shape,
    schema: knowledgeQuerySchema,
    annotations: READ_ONLY,
    invalidMessage: "Invalid knowledge query.",
    run: (input) => store.searchKnowledge(input),
  });

  registerStoreTool("work_request_knowledge_candidates", {
    title: "Request Knowledge candidates",
    description:
      "Open a request to propose Knowledge from a tracked project's recorded Sessions that no earlier request covered (up to 10, newest first), or return the project's open request. Returns knowledge_candidates_not_needed when every Session was already reviewed. " +
      implementationDetail,
    inputShape: requestKnowledgeCandidatesInputSchema.shape,
    schema: requestKnowledgeCandidatesInputSchema,
    annotations: ADDITIVE_IDEMPOTENT,
    invalidMessage: "Invalid knowledge candidate request.",
    run: (input) => store.requestKnowledgeCandidates(input.projectRoot),
  });

  registerStoreTool("work_get_knowledge_candidate_context", {
    title: "Get Knowledge candidate context",
    description:
      "Start processing a Knowledge candidate request (the newest open one of projectRoot, or requestId) and return its source Sessions — summary, five-section workSummary, and raw handoff text within a 40,000-character budget — plus the project's active Knowledge titles to avoid duplicates. Failed or interrupted requests can be processed again. " +
      implementationDetail,
    inputShape: knowledgeCandidateContextQuerySchemaBase.shape,
    schema: knowledgeCandidateContextQuerySchema,
    validationNotes: ["At least one of requestId or projectRoot is required; both may be supplied."],
    annotations: ADDITIVE_IDEMPOTENT,
    invalidMessage: "Invalid knowledge candidate context query.",
    run: (input) => store.getKnowledgeCandidateContext(input),
  });

  registerStoreTool("work_submit_knowledge_candidates", {
    title: "Submit Knowledge candidates",
    description:
      "Submit proposed Knowledge for a request and complete it. Candidates are stored for the user to accept or reject on the Knowledge page; they are not Knowledge yet. Sensitive values are masked; the result reports counts by type only and never returns a token fragment. " +
      knowledgeCandidateContract,
    inputShape: submitKnowledgeCandidatesInputSchema.shape,
    schema: submitKnowledgeCandidatesInputSchema,
    annotations: ADDITIVE,
    invalidMessage: "Invalid knowledge candidates payload.",
    run: (input) => store.submitKnowledgeCandidates(input),
  });

  registerStoreTool("work_update_knowledge", {
    title: "Update recorded work knowledge",
    description:
      "Update or archive explicitly recorded Knowledge for a tracked project; projectRoot is required so the policy gate runs first. Set status to archived to hide an item from active searches, or active to restore it. Set appliesTo to change the paths it covers, or confirm: true after checking that it still holds (clears possiblyStale and needsReview until files change again). Every change keeps an immutable before/after snapshot. Sensitive values are masked; the result reports counts by type only and never returns a token fragment. Non-tracked projects are skipped quietly.",
    inputShape: updateKnowledgeInputSchemaBase.shape,
    schema: updateKnowledgeInputSchema,
    validationNotes: ["At least one mutable Knowledge field besides knowledgeId and projectRoot must be supplied."],
    annotations: OVERWRITE_IDEMPOTENT,
    invalidMessage: "Invalid knowledge update payload.",
    run: (input) => store.updateKnowledge(input),
  });

  registerStoreTool("work_get_knowledge_history", {
    title: "Get Knowledge audit history",
    description:
      "Return the immutable audit history for one Knowledge item (created, updated, archived, restored snapshots with changed fields). projectRoot is required so the policy gate runs before anything is read. Non-tracked projects are skipped quietly.",
    inputShape: knowledgeHistoryQuerySchema.shape,
    schema: knowledgeHistoryQuerySchema,
    annotations: READ_ONLY,
    invalidMessage: "Invalid knowledge history query.",
    run: (input) => store.getKnowledgeHistory(input),
  });

  registerStoreTool("work_request_knowledge_page_update", {
    title: "Request a Knowledge page update",
    description:
      "Mark a tracked project's standing Knowledge page as needing an update, creating it if needed. Default pages are architecture (架構與慣例), in-progress (進行中的工作與未結項), and pitfalls (常見陷阱); a custom page needs a new slug plus title and question. Returns invalid_page for an unknown slug without a title and question. Then get its context and save it. " +
      implementationDetail,
    inputShape: requestKnowledgePageUpdateInputSchema.shape,
    schema: requestKnowledgePageUpdateInputSchema,
    annotations: ADDITIVE_IDEMPOTENT,
    invalidMessage: "Invalid knowledge page request.",
    run: (input) => store.requestKnowledgePageUpdate(input),
  });

  registerStoreTool("work_get_knowledge_page_context", {
    title: "Get Knowledge page context",
    description:
      "Return one Knowledge page (question, current sections and their sources) plus the Sessions to write it from, each with its summary and five-section workSummary within a 24,000-character budget. mode 'full' (an empty page or an explicit update request) gives up to 60 newest non-voided Sessions for a complete rewrite; mode 'review' (a written page) gives only Sessions finished after the page's coverage (reason 'new', oldest first) and cited sources that changed since it was saved (reason 'source_changed'). The page can include needsReview and reviewSections with affected headings, cited Session ids/titles, and reason codes (source_updated_after_save, source_voided_after_save, source_restored_after_save, source_missing, or source_state_unknown). A restored Session still needs review; saving a new page version clears the warning only after the page has been rechecked. Read-only; returns not_found for a page that was never requested.",
    inputShape: knowledgePageContextQuerySchema.shape,
    schema: knowledgePageContextQuerySchema,
    annotations: READ_ONLY,
    invalidMessage: "Invalid knowledge page context query.",
    run: (input) => store.getKnowledgePageContext(input),
  });

  registerStoreTool("work_save_knowledge_page", {
    title: "Save a Knowledge page",
    description:
      "Save a new version of a Knowledge page; earlier versions are kept for the Web UI history. Returns invalid_sources when a cited Session is missing, voided, or from another project. Sensitive values are masked; the result reports counts by type only and never returns a token fragment. idempotencyKey retries return the saved version. " +
      knowledgePageContract,
    inputShape: saveKnowledgePageInputSchema.shape,
    schema: saveKnowledgePageInputSchema,
    validationNotes: [
      "Each section must cite at least one source Session, unless its content is exactly 資料不足 and sourceSessionIds is empty.",
      "The sum of all section content is limited to 8,000 characters.",
    ],
    annotations: ADDITIVE_IDEMPOTENT,
    invalidMessage: "Invalid knowledge page payload.",
    run: (input) => store.saveKnowledgePage(input),
  });

  registerStoreTool("work_mark_knowledge_page_checked", {
    title: "Mark a Knowledge page checked",
    description:
      "Record that the Agent assessed Sessions through throughSessionId and found no page rewrite necessary. Use a non-voided Session from this project's work_get_knowledge_page_context; the cursor only moves forward. This does not create a page version, change page content, clear an explicit update request, or clear needsReview. The page's 有新資料 count then includes only Sessions after both its saved-through time and this review cursor.",
    inputShape: markKnowledgePageCheckedInputSchema.shape,
    schema: markKnowledgePageCheckedInputSchema,
    annotations: ADDITIVE_IDEMPOTENT,
    invalidMessage: "Invalid Knowledge page review cursor.",
    run: (input) => store.markKnowledgePageChecked(input),
  });

  // ── Graph and reports ──────────────────────────────────────────────────

  registerStoreTool("work_get_graph", {
    title: "Get deterministic work graph",
    description:
      "Build a read-only graph from tracked project metadata: Projects, finalized Sessions, explicit Knowledge, attached Evidence, and changed-file paths. Every edge carries provenance: recorded (stored in a record); set includeDerived to add derived co_changed edges between loaded files that at least coChangeMinSessions (default 3) Sessions changed together, each with a reason. For large graphs, set pageSize (maximum 500) and pass the returned nextCursor back as cursor.",
    inputShape: graphQuerySchema.shape,
    schema: graphQuerySchema,
    annotations: READ_ONLY,
    invalidMessage: "Invalid graph query.",
    run: (input) => store.getGraph(input),
  });

  registerStoreTool("work_get_graph_path", {
    title: "Explain how two graph nodes are related",
    description:
      "Find the shortest chain of relations between two nodes of the tracked-project graph (node ids from work_get_graph, such as a Session and a file) and explain each step in plain language. Only recorded relations are walked unless includeDerived is set, which also allows co_changed steps (files several Sessions changed together). The search covers the first 500 nodes of the scoped graph; found: false comes with a reason. Read-only.",
    inputShape: graphPathQuerySchema.shape,
    schema: graphPathQuerySchema,
    annotations: READ_ONLY,
    invalidMessage: "Invalid graph path query.",
    run: (input) => store.getGraphPath(input),
  });

  registerStoreTool("work_get_report", {
    title: "Get a work report",
    description:
      'Build a deterministic day, week, month, quarter, or year report from finalized tracked-project sessions, or pass from and to (YYYY-MM-DD, up to 366 days) for a custom range such as a sprint (period is then "custom" and the comparison is the same number of days before): period summary, previous-period comparison, completed work, verification, risks, decisions, trends (monthly for quarter/year and custom ranges over 92 days), spanning (work that started before, finished after, or was corrected during the period; not counted in the totals), source evidence, and source Session IDs. Calendar dates use the server\'s local time zone, returned as timezone. A non-tracked project scope is skipped quietly.',
    inputShape: reportQueryObjectSchema.shape,
    schema: reportQuerySchema,
    validationNotes: ["Custom from/to dates must be supplied together, in order, and span no more than 366 days."],
    annotations: READ_ONLY,
    invalidMessage: "Invalid report query.",
    run: (input) => store.getReport(input),
  });

  registerStoreTool("work_export_report", {
    title: "Export a work report",
    description:
      "Export the same deterministic report as work_get_report as Markdown or JSON. A non-tracked project scope is skipped quietly.",
    inputShape: reportExportQueryObjectSchema.shape,
    schema: reportExportQuerySchema,
    validationNotes: ["Custom from/to dates must be supplied together, in order, and span no more than 366 days."],
    annotations: READ_ONLY,
    invalidMessage: "Invalid report export query.",
    run: (input) => store.exportReport(input),
  });

  // ── Report synthesis requests ──────────────────────────────────────────

  registerStoreTool("work_request_report_synthesis", {
    title: "Create a report synthesis request",
    description:
      "Create a pending report synthesis request when the user asks for an AI-organized report and none is pending, exactly like the Reports page button. Scope with projectRoot or projectId (omit both for all tracked projects); date defaults to today in the server's local time zone. For a custom interval, pass period=custom with both from and to (YYYY-MM-DD, up to 366 days). Then get its context and save the summary. " +
      implementationDetail,
    inputShape: mcpCreateReportSynthesisRequestInputObjectSchema.shape,
    schema: mcpCreateReportSynthesisRequestInputSchema,
    validationNotes: [
      "Custom from/to dates must be supplied together, in order, and span no more than 366 days.",
      "period=custom requires both from and to.",
    ],
    annotations: ADDITIVE,
    invalidMessage: "Invalid report synthesis request payload.",
    run: (input) => store.requestReportSynthesis(input),
  });

  registerStoreTool("work_list_report_synthesis_requests", {
    title: "Find report synthesis requests",
    description:
      "Find the newest pending or processing report synthesis request (tracked-project scopes only). " +
      implementationDetail,
    inputShape: reportSynthesisRequestQueryObjectSchema.shape,
    schema: reportSynthesisRequestQuerySchema,
    validationNotes: [
      "If either custom from/to date is supplied, both must be supplied in order and span no more than 366 days.",
    ],
    annotations: READ_ONLY,
    invalidMessage: "Invalid report synthesis request query.",
    run: (input) => store.listReportSynthesisRequests(input),
  });

  registerStoreTool("work_get_report_context", {
    title: "Get a bounded report context",
    description:
      "Obtain the deterministic report, bounded source evidence, tracked sessions, and necessary handoff summaries for a report synthesis request. This advances a pending request to processing. Treat the returned report and Session IDs as the only factual source. " +
      implementationDetail +
      " " +
      reportSynthesisContract,
    inputShape: reportSynthesisContextQuerySchema.shape,
    schema: reportSynthesisContextQuerySchema,
    annotations: ADDITIVE_IDEMPOTENT,
    invalidMessage: "Invalid report synthesis context query.",
    run: (input) => store.getReportSynthesisContext(input),
  });

  registerStoreTool("work_save_report_summary", {
    title: "Save an Agent report summary",
    description:
      "Save a grounded report summary with themes, highlights, verification, supported comparison, risks, decisions, current-state/open-item blocks (legacy nextSteps field), agent/model metadata, prompt version, and sourceSessionIds. Original Sessions, Events, Evidence, Knowledge, and handoff snapshots are never modified; previous summaries stay in history. Retries for the same completed request are idempotent. " +
      implementationDetail +
      " " +
      "Sensitive values in report text are masked; the result reports counts by type only and never returns a token fragment. " +
      reportSynthesisContract,
    inputShape: saveReportSummaryInputSchema.shape,
    schema: saveReportSummaryInputSchema,
    annotations: ADDITIVE_IDEMPOTENT,
    invalidMessage: "Invalid report summary payload.",
    run: (input) => store.saveReportSummary(input),
  });

  registerStoreTool("work_retry_report_synthesis", {
    title: "Retry a failed report synthesis request",
    description:
      "Create a fresh pending attempt for the newest failed or cancelled report synthesis request, keeping the previous attempt as history. A still-processing request must not be duplicated. " +
      implementationDetail,
    inputShape: retryReportSynthesisRequestInputSchema.shape,
    schema: retryReportSynthesisRequestInputSchema,
    annotations: ADDITIVE,
    invalidMessage: "Invalid report synthesis retry payload.",
    run: (input) => store.retryReportSynthesisRequest(input.requestId),
  });

  registerStoreTool("work_cancel_report_synthesis", {
    title: "Cancel a report synthesis request",
    description:
      "Cancel a pending or processing report synthesis request when the user no longer wants a new report. Existing reports, summaries, and history remain unchanged; completed requests cannot be cancelled. " +
      implementationDetail,
    inputShape: cancelReportSynthesisRequestInputSchema.shape,
    schema: cancelReportSynthesisRequestInputSchema,
    annotations: ADDITIVE_IDEMPOTENT,
    invalidMessage: "Invalid report synthesis cancellation payload.",
    run: (input) => store.cancelReportSynthesisRequest(input.requestId),
  });

  // ── Metadata backfill ──────────────────────────────────────────────────

  registerStoreTool("work_preview_metadata_backfill", {
    title: "Preview session metadata backfill",
    description:
      "List tracked Sessions whose verification is missing or not_run, or whose changed-files metadata is empty. Read-only; it never guesses file changes. An optional projectRoot is policy-gated.",
    inputShape: metadataBackfillPreviewQuerySchema.shape,
    schema: metadataBackfillPreviewQuerySchema,
    annotations: READ_ONLY,
    invalidMessage: "Invalid metadata backfill preview query.",
    run: (input) => store.previewMetadataBackfill(input),
  });

  registerStoreTool("work_request_metadata_backfill", {
    title: "Create a metadata backfill request",
    description:
      "Create a pending metadata backfill request covering the current gaps when the user asks to fill metadata and none is pending, exactly like the Projects page button. Scope with projectRoot or projectId (omit both for all tracked projects). Returns metadata_backfill_not_needed when there are no gaps. " +
      implementationDetail,
    inputShape: mcpCreateMetadataBackfillRequestInputSchema.shape,
    schema: mcpCreateMetadataBackfillRequestInputSchema,
    annotations: ADDITIVE,
    invalidMessage: "Invalid metadata backfill request payload.",
    run: (input) => store.requestMetadataBackfill(input),
  });

  registerStoreTool("work_list_metadata_backfill_requests", {
    title: "Find metadata backfill requests",
    description: "Find the newest pending or processing metadata backfill request. " + implementationDetail,
    inputShape: metadataBackfillRequestQuerySchema.shape,
    schema: metadataBackfillRequestQuerySchema,
    annotations: READ_ONLY,
    invalidMessage: "Invalid metadata backfill request query.",
    run: (input) => store.listMetadataBackfillRequests(input),
  });

  registerStoreTool("work_get_metadata_backfill_context", {
    title: "Get metadata backfill context",
    description:
      "Obtain the bounded list of tracked Sessions with current metadata and unresolved gaps for a backfill request, before inspecting their worktree, diff, or handoff evidence. This advances a pending request to processing. Do not infer changed files from the returned counts or text. " +
      implementationDetail +
      " " +
      metadataBackfillContract,
    inputShape: metadataBackfillRequestContextQuerySchema.shape,
    schema: metadataBackfillRequestContextQuerySchema,
    annotations: ADDITIVE_IDEMPOTENT,
    invalidMessage: "Invalid metadata backfill context query.",
    run: (input) => store.getMetadataBackfillContext(input),
  });

  registerStoreTool("work_apply_metadata_backfill", {
    title: "Apply session metadata backfill",
    description:
      "Apply explicit changed-files, verification, and optional Git metadata updates to existing Sessions, using the requestId from the backfill context. The request completes only when all requested gaps are resolved. Every update is policy-gated per Session; no new Session is created, and duplicate sessionIds are returned as failures after the first occurrence is processed. " +
      implementationDetail +
      " " +
      metadataBackfillContract,
    inputShape: metadataBackfillApplyInputSchema.shape,
    schema: metadataBackfillApplyInputSchema,
    validationNotes: [
      "updates must contain 1 to 100 entries. For each sessionId, the handler processes the first update and returns each later duplicate as a failure in the result.",
      "Within each update, a changedFileChanges entry with status=renamed must include previousPath; timestamps with offsets are normalized to UTC, future values are rejected, and an invalid startedAt after completedAt is not applied and produces a warning.",
    ],
    annotations: OVERWRITE_IDEMPOTENT,
    invalidMessage: "Invalid metadata backfill payload.",
    run: (input) => store.applyMetadataBackfill(input),
  });

  registerStoreTool("work_cancel_metadata_backfill", {
    title: "Cancel a metadata backfill request",
    description:
      "Cancel a pending or processing metadata backfill request when there is nothing to correct or the user no longer wants to proceed. Existing Session metadata is unchanged. " +
      implementationDetail,
    inputShape: cancelMetadataBackfillRequestInputSchema.shape,
    schema: cancelMetadataBackfillRequestInputSchema,
    annotations: ADDITIVE_IDEMPOTENT,
    invalidMessage: "Invalid metadata backfill cancellation payload.",
    run: (input) => store.cancelMetadataBackfillRequest(input.requestId),
  });

  // ── Historical handoff import ──────────────────────────────────────────

  registerStoreTool("work_preview_handoff_import", {
    title: "Preview historical handoff import",
    description:
      "Dry-run a tracked project's handoff directory: lists eligible, already imported, excluded, blocked, pending, planning-only, and unreadable handoffs with reasons. Never creates Sessions; non-tracked projects are skipped before any handoff file is read.",
    inputShape: handoffImportOptionsSchema.shape,
    schema: handoffImportOptionsSchema,
    annotations: READ_ONLY,
    invalidMessage: "Invalid handoff import preview payload.",
    run: (input) => store.previewHandoffImport(input),
  });

  registerStoreTool("work_import_handoffs", {
    title: "Import selected historical handoffs",
    description:
      "Import the sourcePaths selected after work_preview_handoff_import. Only eligible completed handoffs are imported, each raw snapshot is preserved, and a stable idempotency key prevents duplicate Sessions. The project policy is checked before every source read.",
    inputShape: handoffImportApplyInputSchema.shape,
    schema: handoffImportApplyInputSchema,
    annotations: ADDITIVE_IDEMPOTENT,
    invalidMessage: "Invalid handoff import payload.",
    run: (input) => store.importHandoffs(input),
  });

  registerToolDispatchers(server, registeredStoreTools);
  registerToolContractsResource(server, [...registeredStoreTools.values()]);

  // ── Prompts: one-step entry points for common natural-language flows ───

  server.registerPrompt(
    "finalize-work",
    {
      title: "Save this work to Work Intelligence",
      description: "Record the work just finished in this workspace as a Work Intelligence Session.",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "請把這次完成的工作記錄到 Work Intelligence：先確認這個 workspace 是「記錄中」；檢查實際的 worktree／diff 與驗證結果，只保存確認過的事實，然後用五段 workSummary 完成 finalize。",
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "synthesize-report",
    {
      title: "Organize a Work Intelligence report",
      description: "Create or pick up a report synthesis request and write the grounded report summary.",
      argsSchema: {
        period: z.enum(["day", "week", "month", "quarter", "year", "custom"]).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
      },
    },
    ({ period, from, to }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              period === "custom"
                ? `請整理 Work Intelligence 的自訂期間報告（${from ?? "起日未提供"} 至 ${to ?? "迄日未提供"}）：建立或取得完全相同區間的報告提煉請求，再讀取 context、依涵蓋長度與工作性質歸納繁體中文摘要，並附上來源 Session 後存回。`
                : `請整理 Work Intelligence 的${period ? { day: "日", week: "週", month: "月", quarter: "季", year: "年" }[period] : "週"}報告：使用最新待處理的報告提煉請求，沒有就建立一筆，取得 context 後寫出有來源 Session 的摘要並存回。`,
          },
        },
      ],
    }),
  );

  return server;
}
