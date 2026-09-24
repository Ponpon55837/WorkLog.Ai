import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import {
  attachEvidenceInputSchema,
  cancelMetadataBackfillRequestInputSchema,
  cancelReportSynthesisRequestInputSchema,
  contextQuerySchema,
  graphQuerySchema,
  handoffImportApplyInputSchema,
  handoffImportOptionsSchema,
  knowledgeHistoryQuerySchema,
  knowledgeQuerySchema,
  mcpCreateMetadataBackfillRequestInputSchema,
  mcpCreateReportSynthesisRequestInputSchema,
  mcpFinalizeSessionInputSchema,
  mcpListSessionsInputSchema,
  mcpListSessionsInputSchemaBase,
  metadataBackfillApplyInputSchema,
  metadataBackfillPreviewQuerySchema,
  metadataBackfillRequestContextQuerySchema,
  metadataBackfillRequestQuerySchema,
  projectStatusQuerySchema,
  recordKnowledgeInputSchema,
  reportExportQuerySchema,
  reportQuerySchema,
  reportSynthesisContextQuerySchema,
  reportSynthesisRequestQuerySchema,
  retryReportSynthesisRequestInputSchema,
  saveReportSummaryInputSchema,
  searchQuerySchema,
  sessionDetailQuerySchema,
  updateKnowledgeInputSchema,
  updateKnowledgeInputSchemaBase,
  updateSessionMetadataInputSchema,
  updateSessionSummaryInputSchema,
  updateSessionWorkSummaryInputSchema,
  updateSessionWorkSummaryInputSchemaBase,
} from "@work-intelligence/schema";
import type { WorkIntelligenceStore } from "@work-intelligence/storage";
import { z } from "zod";
import {
  implementationDetail,
  metadataBackfillContract,
  reportSynthesisContract,
  serverInstructions,
  workRecordContract,
} from "./contracts.js";
import { parseMcpInput } from "./input.js";
import { sessionTextResult, textResult } from "./result.js";

/** Reads only the central SQLite; nothing outside the tracked-project registry is touched. */
const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
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

interface StoreToolDefinition<S extends z.ZodTypeAny> {
  title: string;
  description: string;
  /** Advertised input shape; may be the unrefined base object of `schema`. */
  inputShape: z.ZodRawShape;
  /** Full validation schema, including cross-field refinements. */
  schema: S;
  annotations: ToolAnnotations;
  invalidMessage: string;
  /** Session-shaped results also expose sessionId/verification as structuredContent. */
  sessionResult?: boolean;
  run: (input: z.infer<S>) => unknown;
}

export function createWorkIntelligenceMcpServer(store: WorkIntelligenceStore, version: string): McpServer {
  const server = new McpServer({ name: "work-intelligence", version }, { instructions: serverInstructions });

  function registerStoreTool<S extends z.ZodTypeAny>(name: string, definition: StoreToolDefinition<S>): void {
    server.registerTool(
      name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputShape,
        annotations: { title: definition.title, ...definition.annotations },
      },
      async (input: unknown) => {
        const parsed = parseMcpInput(definition.schema, input);
        if (!parsed.success) {
          return {
            isError: true,
            ...textResult({ error: definition.invalidMessage, details: parsed.error.flatten() }),
          };
        }
        const result = definition.run(parsed.data);
        return definition.sessionResult ? sessionTextResult(result) : textResult(result);
      },
    );
  }

  // ── Project and Session ────────────────────────────────────────────────

  registerStoreTool("work_get_project_status", {
    title: "Get project recording status",
    description:
      "Return whether a workspace root is tracked, paused, ignored, or unregistered in Work Intelligence. Call this before preparing a finalize payload: only tracked projects are recorded. This is read-only and cannot change the recording status; only the user can do that in the Web UI.",
    inputShape: projectStatusQuerySchema.shape,
    schema: projectStatusQuerySchema,
    annotations: READ_ONLY,
    invalidMessage: "Invalid project status query.",
    run: (input) => store.getProjectStatus(input.projectRoot),
  });

  registerStoreTool("work_finalize_session", {
    title: "Finalize a work session",
    description:
      "Finalize a completed planning/execution/verification/closing session. Provide summary plus the required five-section workSummary; inspect the worktree and provide changedFiles (use [] only when no files were intentionally changed) plus an explicit verification status: passed, failed, or not_run. Optionally provide changedFilesProvenance with Agent, handoff, Git, or worktree evidence references and changedFileChanges with added, modified, deleted, or renamed semantics (renamed requires previousPath). This is independent from Git commit. The project must be explicitly tracked; unregistered, paused, and ignored projects are skipped without reading handoff, Git, or source files. The idempotencyKey makes retries safe. If legacy data is missing verification, changedFiles, or workSummary, the response includes a follow-up instruction. " +
      workRecordContract,
    inputShape: mcpFinalizeSessionInputSchema.shape,
    schema: mcpFinalizeSessionInputSchema,
    annotations: ADDITIVE_IDEMPOTENT,
    invalidMessage: "Invalid finalize payload.",
    sessionResult: true,
    run: (input) => store.finalizeSession(input),
  });

  registerStoreTool("work_get_session", {
    title: "Get one work session",
    description:
      "Return one tracked Session with its five-section workSummary, changed files, verification, events, evidence, and linked Knowledge. Raw handoff snapshot content is omitted (only its length is returned) unless includeRawSnapshots is true. Sessions of non-tracked projects are skipped quietly.",
    inputShape: sessionDetailQuerySchema.shape,
    schema: sessionDetailQuerySchema,
    annotations: READ_ONLY,
    invalidMessage: "Invalid session query.",
    run: (input) => store.getSessionDetailForAgent(input),
  });

  registerStoreTool("work_list_sessions", {
    title: "List work sessions",
    description:
      "List finalized tracked-project Sessions, newest first, with optional keyword (q), inclusive from/to calendar dates in the server's local time zone, and a projectRoot or projectId scope. Results are paged (pageSize up to 100) and include pageInfo.total. Non-tracked scopes are skipped quietly.",
    inputShape: mcpListSessionsInputSchemaBase.shape,
    schema: mcpListSessionsInputSchema,
    annotations: READ_ONLY,
    invalidMessage: "Invalid session list query.",
    run: (input) => store.listSessionsForAgent(input),
  });

  registerStoreTool("work_search", {
    title: "Search work history",
    description:
      "Search finalized work sessions by title, summary, or event text (up to 50 matches with the matched excerpt). Search is limited to tracked projects, and a projectRoot query is policy-gated before any project-scoped access.",
    inputShape: searchQuerySchema.shape,
    schema: searchQuerySchema,
    annotations: READ_ONLY,
    invalidMessage: "Invalid search query.",
    run: (input) => store.search(input.q, input.projectRoot),
  });

  registerStoreTool("work_get_context", {
    title: "Get work context",
    description:
      "Return recent tracked-project sessions, recorded decisions, explicit recentKnowledge, metadataFollowUps, and pendingRequests (pending or processing report synthesis and metadata backfill requests waiting for an Agent). metadataFollowUps lists completed Sessions whose verification is missing or not_run, or whose changed-files metadata is empty. With projectRoot, the project policy gate is checked first and non-tracked projects are quietly skipped.",
    inputShape: contextQuerySchema.shape,
    schema: contextQuerySchema,
    annotations: READ_ONLY,
    invalidMessage: "Invalid context query.",
    run: (input) => store.getContext(input.projectRoot),
  });

  registerStoreTool("work_update_session_metadata", {
    title: "Update session metadata",
    description:
      "Backfill confirmed verification and changed-files metadata on an existing session without creating a duplicate. The Agent must inspect the worktree/diff first and provide the confirmed changedFiles list; use [] only when the work intentionally changed no files. By default changedFilesMode is replace; use changedFilesMode=merge for a separately verified stage or later commit so paths and provenance are safely unioned and deduplicated. Optionally provide changedFilesProvenance and changedFileChanges. Non-tracked projects are skipped quietly.",
    inputShape: updateSessionMetadataInputSchema.shape,
    schema: updateSessionMetadataInputSchema,
    annotations: OVERWRITE_IDEMPOTENT,
    invalidMessage: "Invalid session metadata payload.",
    sessionResult: true,
    run: (input) => store.updateSessionMetadata(input),
  });

  registerStoreTool("work_update_session_summary", {
    title: "Update a finalized session summary",
    description:
      "Update the primary summary text of an existing finalized Session without creating a new Session. mode=replace replaces the complete summary; mode=append adds a clearly separated follow-up paragraph. changedFiles, verification, events, evidence, handoff snapshots, and the Session id are preserved. It has its own idempotencyKey; retrying the same payload never appends twice. Non-tracked projects are skipped quietly.",
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
      workRecordContract,
    inputShape: updateSessionWorkSummaryInputSchemaBase.shape,
    schema: updateSessionWorkSummaryInputSchema,
    annotations: OVERWRITE_IDEMPOTENT,
    invalidMessage: "Invalid session workSummary payload.",
    sessionResult: true,
    run: (input) => store.updateSessionWorkSummary(input),
  });

  registerStoreTool("work_attach_evidence", {
    title: "Attach session evidence",
    description:
      "Attach an explicit evidence reference to an existing tracked Session, such as a test result, command output, source document, or review link. Only the supplied reference and summary are stored; the referenced source is never read. Duplicate session/kind/reference submissions are idempotent, and non-tracked projects are skipped quietly.",
    inputShape: attachEvidenceInputSchema.shape,
    schema: attachEvidenceInputSchema,
    annotations: ADDITIVE_IDEMPOTENT,
    invalidMessage: "Invalid evidence payload.",
    run: (input) => store.attachEvidence(input),
  });

  // ── Knowledge ──────────────────────────────────────────────────────────

  registerStoreTool("work_record_knowledge", {
    title: "Record explicit work knowledge",
    description:
      "Store an explicitly confirmed decision, pattern, gotcha, procedure, or skill for a tracked project, optionally linked to a finalized Session. Knowledge is never extracted from source files or handoffs automatically. idempotencyKey retries return the original record, and non-tracked projects are skipped quietly.",
    inputShape: recordKnowledgeInputSchema.shape,
    schema: recordKnowledgeInputSchema,
    annotations: ADDITIVE_IDEMPOTENT,
    invalidMessage: "Invalid knowledge payload.",
    run: (input) => store.recordKnowledge(input),
  });

  registerStoreTool("work_search_knowledge", {
    title: "Search recorded work knowledge",
    description:
      "Search explicitly recorded knowledge by title, body, tags, references, project, or kind. Results are limited to active knowledge from tracked projects by default; a projectRoot or projectId scope is policy-gated before returning data.",
    inputShape: knowledgeQuerySchema.shape,
    schema: knowledgeQuerySchema,
    annotations: READ_ONLY,
    invalidMessage: "Invalid knowledge query.",
    run: (input) => store.searchKnowledge(input),
  });

  registerStoreTool("work_update_knowledge", {
    title: "Update recorded work knowledge",
    description:
      "Update or archive explicitly recorded Knowledge for a tracked project; projectRoot is required so the policy gate runs first. Set status to archived to hide an item from active searches, or active to restore it. Every change keeps an immutable before/after snapshot. Non-tracked projects are skipped quietly.",
    inputShape: updateKnowledgeInputSchemaBase.shape,
    schema: updateKnowledgeInputSchema,
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

  // ── Graph and reports ──────────────────────────────────────────────────

  registerStoreTool("work_get_graph", {
    title: "Get deterministic work graph",
    description:
      "Build a read-only graph from tracked project metadata: Projects, finalized Sessions, explicit Knowledge, attached Evidence, and changed-file paths. No semantic relationships are inferred. For large graphs, set pageSize (maximum 500) and pass the returned nextCursor back as cursor.",
    inputShape: graphQuerySchema.shape,
    schema: graphQuerySchema,
    annotations: READ_ONLY,
    invalidMessage: "Invalid graph query.",
    run: (input) => store.getGraph(input),
  });

  registerStoreTool("work_get_report", {
    title: "Get a work report",
    description:
      "Build a deterministic day, week, month, quarter, or year report from finalized tracked-project sessions: period summary, previous-period comparison, completed work, verification, risks, decisions, trends (monthly for quarter/year), source evidence, and source Session IDs. Calendar dates use the server's local time zone, returned as timezone. A non-tracked project scope is skipped quietly.",
    inputShape: reportQuerySchema.shape,
    schema: reportQuerySchema,
    annotations: READ_ONLY,
    invalidMessage: "Invalid report query.",
    run: (input) => store.getReport(input),
  });

  registerStoreTool("work_export_report", {
    title: "Export a work report",
    description:
      "Export the same deterministic report as work_get_report as Markdown or JSON. A non-tracked project scope is skipped quietly.",
    inputShape: reportExportQuerySchema.shape,
    schema: reportExportQuerySchema,
    annotations: READ_ONLY,
    invalidMessage: "Invalid report export query.",
    run: (input) => store.exportReport(input),
  });

  // ── Report synthesis requests ──────────────────────────────────────────

  registerStoreTool("work_request_report_synthesis", {
    title: "Create a report synthesis request",
    description:
      "Create a pending report synthesis request when the user asks for an AI-organized report and none is pending, exactly like the Reports page button. Scope with projectRoot or projectId (omit both for all tracked projects); date defaults to today in the server's local time zone. Then get its context and save the summary. " +
      implementationDetail,
    inputShape: mcpCreateReportSynthesisRequestInputSchema.shape,
    schema: mcpCreateReportSynthesisRequestInputSchema,
    annotations: ADDITIVE,
    invalidMessage: "Invalid report synthesis request payload.",
    run: (input) => store.requestReportSynthesis(input),
  });

  registerStoreTool("work_list_report_synthesis_requests", {
    title: "Find report synthesis requests",
    description:
      "Find the newest pending or processing report synthesis request (tracked-project scopes only). " +
      implementationDetail,
    inputShape: reportSynthesisRequestQuerySchema.shape,
    schema: reportSynthesisRequestQuerySchema,
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
      "Apply explicit changed-files, verification, and optional Git metadata updates to existing Sessions, using the requestId from the backfill context. The request completes only when all requested gaps are resolved. Every update is policy-gated per Session; no new Session is created and duplicate sessionIds in one batch are rejected. " +
      implementationDetail +
      " " +
      metadataBackfillContract,
    inputShape: metadataBackfillApplyInputSchema.shape,
    schema: metadataBackfillApplyInputSchema,
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
      argsSchema: { period: z.enum(["day", "week", "month", "quarter", "year"]).optional() },
    },
    ({ period }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `請整理 Work Intelligence 的${period ? { day: "日", week: "週", month: "月", quarter: "季", year: "年" }[period] : "週"}報告：使用最新待處理的報告提煉請求，沒有就建立一筆，取得 context 後寫出有來源 Session 的摘要並存回。`,
          },
        },
      ],
    }),
  );

  return server;
}
