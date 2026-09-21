import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  attachEvidenceInputSchema,
  cancelMetadataBackfillRequestInputSchema,
  cancelReportSynthesisRequestInputSchema,
  contextQuerySchema,
  reportSynthesisContextQuerySchema,
  reportSynthesisRequestQuerySchema,
  retryReportSynthesisRequestInputSchema,
  finalizeSessionInputSchema,
  graphQuerySchema,
  handoffImportApplyInputSchema,
  handoffImportOptionsSchema,
  knowledgeHistoryQuerySchema,
  knowledgeQuerySchema,
  metadataBackfillApplyInputSchema,
  metadataBackfillRequestContextQuerySchema,
  metadataBackfillRequestQuerySchema,
  metadataBackfillPreviewQuerySchema,
  reportExportQuerySchema,
  reportQuerySchema,
  recordKnowledgeInputSchema,
  saveReportSummaryInputSchema,
  searchQuerySchema,
  updateKnowledgeInputSchema,
  updateKnowledgeInputSchemaBase,
  updateSessionMetadataInputSchema,
  updateSessionSummaryInputSchema
} from "@work-intelligence/schema";
import { WorkIntelligenceStore } from "@work-intelligence/storage";
import { z } from "zod";
import { parseMcpInput } from "./input.js";
import { sessionTextResult, textResult } from "./result.js";

const repoDataPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../data", "work-intelligence.sqlite");
const databasePath = process.env.WORK_INTELLIGENCE_DB ?? repoDataPath;
const store = new WorkIntelligenceStore(databasePath);
const reportSynthesisContract =
  "Report synthesis contract: write Traditional Chinese by default and make the result skimmable and outcome-focused. Start with the reporting period, scope, and a one-sentence executive summary that describes what changed or was delivered, not merely that work happened. Include themes/workstreams, major completed outcomes, verification status with passed/failed/not_run/not_supplied kept distinct, comparison with the previous period, risks or needs for input, technical decisions with reasons, and concrete next steps. Group related Sessions instead of repeating titles. Every material block must include sourceSessionIds from the supplied context; if a conclusion has no evidence, write 資料不足 and do not infer. Changed files are evidence of work, not proof of a Git commit. Keep the report concise, specific, and action-oriented. Use promptVersion report-synthesis-v2.";
const metadataBackfillContract =
  "Metadata backfill contract: when the user asks to補齊、更新、檢查或處理 Work Intelligence metadata 缺口, automatically find the newest pending or processing metadata backfill request, obtain its bounded context, inspect the tracked project's actual worktree/diff and available handoff evidence, then apply only confirmed changedFiles, verification, changed-file provenance/changes, or Git metadata. Never infer files from a title, summary, commit, or the existence of a Session. If no files were intentionally changed, explicitly submit changedFiles: [] with changedFilesMode: replace; when updating verification only and preserving existing files, use changedFilesMode=merge with an empty changedFiles array. Keep paused, ignored, unregistered, and missing projects quietly skipped; projectId-scoped skip responses preserve the registry projectId rather than mislabeling it as a projectRoot. Report what was updated, what remains unresolved, and why.";

const server = new McpServer({
  name: "work-intelligence",
  version: "0.1.0"
}, {
  instructions:
    "Work Intelligence is a local-first, explicit-opt-in work record system. When the user asks to整理、提煉、產生或完成 Work Intelligence 工作報告, automatically find the newest pending report synthesis request, obtain its matching deterministic context, write a grounded summary, and save it back. If the newest report request is failed because it timed out or was interrupted, retry it through the implementation-detail retry operation before obtaining context. When the user asks to補齊、更新、檢查或處理 Work Intelligence metadata 缺口, automatically find the newest pending or processing metadata backfill request, obtain its bounded context, inspect the tracked project's actual worktree/diff or handoff evidence, and apply only confirmed metadata updates. When the user asks to修正已完成 Session 的主摘要, use work_update_session_summary with the existing sessionId; choose replace to replace the full summary or append to add a clearly separated follow-up. Never use evidence as a substitute for a summary update. If work_finalize_session finds the same idempotencyKey with a different summary, treat it as an idempotency conflict and use work_update_session_summary rather than assuming the summary changed. The user should only need natural language and must never be asked for MCP tool names, request IDs, JSON, or a tool-call order. Use request/context/retry/apply/cancel tools as implementation details; do not tell the user to call them manually. Keep deterministic reports separate from Agent-derived summaries. Never expose or read untracked, paused, ignored, or unregistered project source, handoff, Git, or evidence. If no matching request exists, explain that the relevant Work Intelligence page must first create one. If context is insufficient, say 資料不足 instead of guessing. " + reportSynthesisContract + " " + metadataBackfillContract
});

server.registerTool(
  "work_finalize_session",
  {
    title: "Finalize a work session",
    description:
      "Finalize a completed planning/execution/verification/closing session. Before calling, the Agent must inspect the worktree and provide changedFiles (use [] only when no files were intentionally changed) plus an explicit verification status: passed, failed, or not_run. Optionally provide changedFilesProvenance with Agent, handoff, Git, or worktree evidence references and changedFileChanges with added, modified, deleted, or renamed semantics (renamed requires previousPath). This is independent from Git commit. The project must be explicitly tracked; unregistered, paused, and ignored projects are skipped without reading handoff, Git, or source files. The idempotencyKey makes retries safe. If legacy data is missing verification or changedFiles, the response includes a follow-up instruction.",
    inputSchema: finalizeSessionInputSchema.shape
  },
  async (input) => {
    const parsed = parseMcpInput(finalizeSessionInputSchema, input);
    if (!parsed.success) {
      return {
        isError: true,
        ...textResult({ error: "Invalid finalize payload.", details: parsed.error.flatten() })
      };
    }
    return sessionTextResult(store.finalizeSession(parsed.data));
  }
);

server.registerTool(
  "work_preview_handoff_import",
  {
    title: "Preview historical handoff import",
    description:
      "Read a tracked project's handoff directory and return a dry-run preview. The preview lists eligible, already imported, excluded, blocked, pending, planning-only, and unreadable handoffs with reasons. This operation never creates Sessions; unregistered, paused, and ignored projects are skipped before reading any handoff file.",
    inputSchema: handoffImportOptionsSchema.shape
  },
  async (input) => {
    const parsed = parseMcpInput(handoffImportOptionsSchema, input);
    if (!parsed.success) {
      return {
        isError: true,
        ...textResult({ error: "Invalid handoff import preview payload.", details: parsed.error.flatten() })
      };
    }
    return textResult(store.previewHandoffImport(parsed.data));
  }
);

server.registerTool(
  "work_import_handoffs",
  {
    title: "Import selected historical handoffs",
    description:
      "Apply a handoff import only after reviewing work_preview_handoff_import. Pass the selected sourcePaths explicitly; the operation imports only eligible completed handoffs, preserves each raw handoff snapshot, and uses a stable idempotency key so retries never create duplicate Sessions. The project policy is checked before every source read.",
    inputSchema: handoffImportApplyInputSchema.shape
  },
  async (input) => {
    const parsed = parseMcpInput(handoffImportApplyInputSchema, input);
    if (!parsed.success) {
      return {
        isError: true,
        ...textResult({ error: "Invalid handoff import payload.", details: parsed.error.flatten() })
      };
    }
    return textResult(store.importHandoffs(parsed.data));
  }
);

server.registerTool(
  "work_update_session_metadata",
  {
    title: "Update session metadata",
    description:
      "Backfill confirmed verification and changed-files metadata on an existing session without creating a duplicate. The Agent must inspect the worktree/diff first and provide the confirmed changedFiles list; use [] only when the work intentionally changed no files. By default changedFilesMode is replace; use changedFilesMode=merge for a separately verified stage or later commit so paths and provenance are safely unioned and deduplicated without fabricating sources for legacy files. Optionally provide changedFilesProvenance to record the evidence source for each path and changedFileChanges to preserve added, modified, deleted, or renamed history. The session's project policy is checked before the update, and unregistered, paused, or ignored projects are skipped quietly.",
    inputSchema: updateSessionMetadataInputSchema.shape
  },
  async (input) => {
    const parsed = parseMcpInput(updateSessionMetadataInputSchema, input);
    if (!parsed.success) {
      return {
        isError: true,
        ...textResult({ error: "Invalid session metadata payload.", details: parsed.error.flatten() })
      };
    }
    return sessionTextResult(store.updateSessionMetadata(parsed.data));
  }
);

server.registerTool(
  "work_update_session_summary",
  {
    title: "Update a finalized session summary",
    description:
      "Update the primary summary text of an existing finalized Session without creating a new Session. Use mode=replace to replace the complete summary, or mode=append to add a clearly separated follow-up paragraph. This tool preserves changedFiles, verification, events, evidence, handoff snapshots, and the original Session id. It has its own idempotencyKey; retrying the same operation with the same payload is safe and never appends twice. The existing Session project must be tracked; unregistered, paused, and ignored projects are skipped quietly. Never use work_attach_evidence as a substitute when the primary summary itself is stale.",
    inputSchema: updateSessionSummaryInputSchema.shape
  },
  async (input) => {
    const parsed = parseMcpInput(updateSessionSummaryInputSchema, input);
    if (!parsed.success) {
      return {
        isError: true,
        ...textResult({ error: "Invalid session summary payload.", details: parsed.error.flatten() })
      };
    }
    return sessionTextResult(store.updateSessionSummary(parsed.data));
  }
);

server.registerTool(
  "work_attach_evidence",
  {
    title: "Attach session evidence",
    description:
      "Attach an explicit evidence reference to an existing tracked Session, such as a test result, command output, source document, or review link. This operation stores only the supplied reference and summary; it never reads the referenced source. The Session project policy is checked before writing, duplicate session/kind/reference submissions are idempotent, and unregistered, paused, or ignored projects are skipped quietly.",
    inputSchema: attachEvidenceInputSchema.shape
  },
  async (input) => {
    const parsed = parseMcpInput(attachEvidenceInputSchema, input);
    if (!parsed.success) {
      return {
        isError: true,
        ...textResult({ error: "Invalid evidence payload.", details: parsed.error.flatten() })
      };
    }
    return textResult(store.attachEvidence(parsed.data));
  }
);

server.registerTool(
  "work_record_knowledge",
  {
    title: "Record explicit work knowledge",
    description:
      "Store an explicitly confirmed decision, pattern, gotcha, procedure, or skill for a tracked project. The Agent must provide the knowledge body and may link a finalized Session; this tool never extracts knowledge from source files or handoff automatically. The project policy is checked before writing, idempotencyKey retries return the original record, and unregistered, paused, or ignored projects are skipped quietly.",
    inputSchema: recordKnowledgeInputSchema.shape
  },
  async (input) => {
    const parsed = parseMcpInput(recordKnowledgeInputSchema, input);
    if (!parsed.success) {
      return {
        isError: true,
        ...textResult({ error: "Invalid knowledge payload.", details: parsed.error.flatten() })
      };
    }
    return textResult(store.recordKnowledge(parsed.data));
  }
);

server.registerTool(
  "work_search_knowledge",
  {
    title: "Search recorded work knowledge",
    description:
      "Search explicitly recorded knowledge by title, body, tags, references, project, or kind. Results are limited to active knowledge from tracked projects by default; a projectRoot or projectId scope is policy-gated before returning data. No source files are read during search.",
    inputSchema: knowledgeQuerySchema.shape
  },
  async (input) => {
    const parsed = parseMcpInput(knowledgeQuerySchema, input);
    if (!parsed.success) {
      return {
        isError: true,
        ...textResult({ error: "Invalid knowledge query.", details: parsed.error.flatten() })
      };
    }
    return textResult(store.searchKnowledge(parsed.data));
  }
);

server.registerTool(
  "work_update_knowledge",
  {
    title: "Update recorded work knowledge",
    description:
      "Update or archive explicitly recorded Knowledge for a tracked project. The Agent must supply projectRoot so the policy gate runs before the Knowledge record is read; this tool never reads source, handoff, or Git files. Set status to archived to hide an item from active searches, or active to restore it. Unregistered, paused, and ignored projects are skipped quietly.",
    inputSchema: updateKnowledgeInputSchemaBase.shape
  },
  async (input) => {
    const parsed = parseMcpInput(updateKnowledgeInputSchema, input);
    if (!parsed.success) {
      return {
        isError: true,
        ...textResult({ error: "Invalid knowledge update payload.", details: parsed.error.flatten() })
      };
    }
    return textResult(store.updateKnowledge(parsed.data));
  }
);

server.registerTool(
  "work_get_knowledge_history",
  {
    title: "Get Knowledge audit history",
    description:
      "Return the immutable audit history for one explicitly recorded Knowledge item, including created, updated, archived, and restored snapshots with changed fields. The projectRoot is required so the tracked-project policy gate runs before the Knowledge record or audit history is read. Unregistered, paused, and ignored projects are skipped quietly; this tool never reads source, handoff, or Git files.",
    inputSchema: knowledgeHistoryQuerySchema.shape
  },
  async (input) => {
    const parsed = parseMcpInput(knowledgeHistoryQuerySchema, input);
    if (!parsed.success) {
      return {
        isError: true,
        ...textResult({ error: "Invalid knowledge history query.", details: parsed.error.flatten() })
      };
    }
    return textResult(store.getKnowledgeHistory(parsed.data));
  }
);

server.registerTool(
  "work_get_graph",
  {
    title: "Get deterministic work graph",
    description:
      "Build a read-only graph from tracked project metadata: Projects, finalized Sessions, explicit Knowledge, attached Evidence, and changed-file paths. This tool does not read source, handoff, or Git files and does not infer semantic relationships; projectRoot/projectId scopes are policy-gated and non-tracked projects are skipped quietly.",
    inputSchema: graphQuerySchema.shape
  },
  async (input) => {
    const parsed = parseMcpInput(graphQuerySchema, input);
    if (!parsed.success) {
      return {
        isError: true,
        ...textResult({ error: "Invalid graph query.", details: parsed.error.flatten() })
      };
    }
    return textResult(store.getGraph(parsed.data));
  }
);

server.registerTool(
  "work_list_metadata_backfill_requests",
  {
    title: "Find metadata backfill requests",
    description:
      "Implementation detail for natural-language Work Intelligence metadata follow-ups. When the user asks to補齊、更新、檢查或處理 metadata 缺口, automatically use this to find the newest pending or processing request without asking the user for a requestId. The user must not be exposed to this tool name or call order. " + metadataBackfillContract,
    inputSchema: metadataBackfillRequestQuerySchema.shape
  },
  async (input) => {
    const parsed = parseMcpInput(metadataBackfillRequestQuerySchema, input);
    if (!parsed.success) {
      return {
        isError: true,
        ...textResult({ error: "Invalid metadata backfill request query.", details: parsed.error.flatten() })
      };
    }
    return textResult(store.listMetadataBackfillRequests(parsed.data));
  }
);

server.registerTool(
  "work_get_metadata_backfill_context",
  {
    title: "Get metadata backfill context",
    description:
      "Implementation detail for completing a metadata backfill request. Obtain the bounded list of tracked Sessions with current metadata and unresolved gaps before inspecting their worktree, diff, or handoff evidence. This advances a pending request to processing and policy-gates project access. Do not infer changed files from the returned counts or text. " + metadataBackfillContract,
    inputSchema: metadataBackfillRequestContextQuerySchema.shape
  },
  async (input) => {
    const parsed = parseMcpInput(metadataBackfillRequestContextQuerySchema, input);
    if (!parsed.success) {
      return {
        isError: true,
        ...textResult({ error: "Invalid metadata backfill context query.", details: parsed.error.flatten() })
      };
    }
    return textResult(store.getMetadataBackfillContext(parsed.data));
  }
);

server.registerTool(
  "work_cancel_metadata_backfill",
  {
    title: "Cancel a metadata backfill request",
    description:
      "Cancel a pending or processing metadata backfill request when the user has no data to correct or no longer wants to proceed. Cancellation never changes the existing Session metadata; subsequent context/apply attempts are rejected until a new request is created. The project policy is checked first and unregistered, paused, or ignored projects are skipped quietly. This is an implementation detail; do not ask the user for the tool name or request ID. " + metadataBackfillContract,
    inputSchema: cancelMetadataBackfillRequestInputSchema.shape
  },
  async (input) => {
    const parsed = parseMcpInput(cancelMetadataBackfillRequestInputSchema, input);
    if (!parsed.success) {
      return {
        isError: true,
        ...textResult({ error: "Invalid metadata backfill cancellation payload.", details: parsed.error.flatten() })
      };
    }
    return textResult(store.cancelMetadataBackfillRequest(parsed.data.requestId));
  }
);

server.registerTool(
  "work_preview_metadata_backfill",
  {
    title: "Preview session metadata backfill",
    description:
      "List tracked Sessions whose verification is missing or marked not_run, or whose changed-files metadata is empty. This is a read-only preview and never guesses file changes. The Agent should inspect the relevant worktree or handoff evidence, then pass only confirmed values to work_apply_metadata_backfill. An optional projectRoot is policy-gated before project-scoped access. If the user asks for a complete follow-up, prefer the pending metadata backfill request created by the Projects / Tracking page. " + metadataBackfillContract,
    inputSchema: metadataBackfillPreviewQuerySchema.shape
  },
  async (input) => {
    const parsed = parseMcpInput(metadataBackfillPreviewQuerySchema, input);
    if (!parsed.success) {
      return {
        isError: true,
        ...textResult({ error: "Invalid metadata backfill preview query.", details: parsed.error.flatten() })
      };
    }
    return textResult(store.previewMetadataBackfill(parsed.data));
  }
);

server.registerTool(
  "work_apply_metadata_backfill",
  {
    title: "Apply session metadata backfill",
    description:
      "Apply explicit changed-files, verification, and optional Git metadata updates to existing Sessions. Use the requestId returned by work_get_metadata_backfill_context when processing a pending request; the request becomes completed only when all requested gaps are resolved, otherwise it remains active with remaining items. Every update is policy-gated per Session; no new Session is created, idempotencyKey/summary/events are preserved, duplicate sessionIds in one batch are rejected, and paused, ignored, or unregistered projects are skipped quietly. Use the bounded request context first and provide only Agent-confirmed evidence. " + metadataBackfillContract,
    inputSchema: metadataBackfillApplyInputSchema.shape
  },
  async (input) => {
    const parsed = parseMcpInput(metadataBackfillApplyInputSchema, input);
    if (!parsed.success) {
      return {
        isError: true,
        ...textResult({ error: "Invalid metadata backfill payload.", details: parsed.error.flatten() })
      };
    }
    return textResult(store.applyMetadataBackfill(parsed.data));
  }
);

server.registerTool(
  "work_get_context",
  {
    title: "Get work context",
    description:
      "Return recent tracked-project sessions, recorded decisions, explicit recentKnowledge, and metadataFollowUps for Agent context. metadataFollowUps lists completed Sessions whose verification is missing or not_run, or whose changed-files metadata is empty; inspect the worktree/diff or handoff and use the metadata backfill tools when confirmed. With projectRoot, the explicit project policy gate is checked first; non-tracked projects are quietly skipped.",
    inputSchema: contextQuerySchema.shape
  },
  async (input) => {
    const parsed = parseMcpInput(contextQuerySchema, input);
    if (!parsed.success) {
      return {
        isError: true,
        ...textResult({ error: "Invalid context query.", details: parsed.error.flatten() })
      };
    }
    return textResult(store.getContext(parsed.data.projectRoot));
  }
);

server.registerTool(
  "work_search",
  {
    title: "Search work history",
    description:
      "Search finalized work sessions by title, summary, or event. Search is limited to tracked projects, and a projectRoot query is policy-gated before any project-scoped access.",
    inputSchema: {
      q: z.string().trim().min(1).max(500),
      projectRoot: z.string().trim().min(1).max(1_000).optional()
    }
  },
  async (input) => {
    const parsed = parseMcpInput(searchQuerySchema, input);
    if (!parsed.success) {
      return {
        isError: true,
        ...textResult({ error: "Invalid search query.", details: parsed.error.flatten() })
      };
    }
    return textResult(store.search(parsed.data.q, parsed.data.projectRoot));
  }
);

server.registerTool(
  "work_get_report",
  {
    title: "Get a work report",
    description:
      "Build a deterministic day, week, month, quarter, or year report from finalized sessions. Quarter and year trends are aggregated by calendar month. The report includes a period summary, previous-period comparison, completed work, verification status, risks, decisions, activity trends, source evidence, and source session IDs. Reports use UTC calendar dates and aggregate tracked projects only. A project scope that is unregistered, paused, or ignored is skipped quietly.",
    inputSchema: reportQuerySchema.shape
  },
  async (input) => {
    const parsed = parseMcpInput(reportQuerySchema, input);
    if (!parsed.success) {
      return {
        isError: true,
        ...textResult({ error: "Invalid report query.", details: parsed.error.flatten() })
      };
    }
    return textResult(store.getReport(parsed.data));
  }
);

server.registerTool(
  "work_export_report",
  {
    title: "Export a work report",
    description:
      "Export the same deterministic tracked-only day, week, month, quarter, or year report as Markdown or JSON. Quarter and year trends are aggregated by calendar month. The export includes the period summary, previous-period comparison, completed work, verification, risks, decisions, trends, source evidence, and source Session IDs. A project scope that is unregistered, paused, or ignored is skipped quietly.",
    inputSchema: reportExportQuerySchema.shape
  },
  async (input) => {
    const parsed = parseMcpInput(reportExportQuerySchema, input);
    if (!parsed.success) {
      return {
        isError: true,
        ...textResult({ error: "Invalid report export query.", details: parsed.error.flatten() })
      };
    }
    return textResult(store.exportReport(parsed.data));
  }
);

server.registerTool(
  "work_list_report_synthesis_requests",
  {
    title: "Find report synthesis requests",
    description:
      "Implementation detail for natural-language Work Intelligence report requests. When the user asks to整理、提煉或產生工作報告, automatically use this to find the newest pending or processing request without asking the user for a requestId. Then obtain context and save the result. Results contain only tracked-project report scopes; unregistered, paused, and ignored projects are quietly omitted. The user must not be exposed to this tool name or call order. " + reportSynthesisContract,
    inputSchema: reportSynthesisRequestQuerySchema.shape
  },
  async (input) => {
    const parsed = parseMcpInput(reportSynthesisRequestQuerySchema, input);
    if (!parsed.success) {
      return {
        isError: true,
        ...textResult({ error: "Invalid report synthesis request query.", details: parsed.error.flatten() })
      };
    }
    return textResult(store.listReportSynthesisRequests(parsed.data));
  }
);

server.registerTool(
  "work_cancel_report_synthesis",
  {
    title: "Cancel a report synthesis request",
    description:
      "Cancel a pending or processing Work Intelligence report synthesis request when the user no longer wants a new report. Existing deterministic reports, summaries, and history remain unchanged; a cancelled request can be retried later. A request that is already completed cannot be cancelled. The user must not be asked for this tool name or request ID. " + reportSynthesisContract,
    inputSchema: cancelReportSynthesisRequestInputSchema.shape
  },
  async (input) => {
    const parsed = parseMcpInput(cancelReportSynthesisRequestInputSchema, input);
    if (!parsed.success) {
      return {
        isError: true,
        ...textResult({ error: "Invalid report synthesis cancellation payload.", details: parsed.error.flatten() })
      };
    }
    return textResult(store.cancelReportSynthesisRequest(parsed.data.requestId));
  }
);

server.registerTool(
  "work_retry_report_synthesis",
  {
    title: "Retry a failed report synthesis request",
    description:
      "Implementation detail for recovering an interrupted Work Intelligence report request. Use this only when the newest request is failed or cancelled; a still-processing request must not be duplicated. The operation creates a fresh pending attempt, keeps the previous attempt as history, and preserves the original source Session IDs. The user must not be asked for this tool name or request ID. " + reportSynthesisContract,
    inputSchema: retryReportSynthesisRequestInputSchema.shape
  },
  async (input) => {
    const parsed = parseMcpInput(retryReportSynthesisRequestInputSchema, input);
    if (!parsed.success) {
      return {
        isError: true,
        ...textResult({ error: "Invalid report synthesis retry payload.", details: parsed.error.flatten() })
      };
    }
    return textResult(store.retryReportSynthesisRequest(parsed.data.requestId));
  }
);

server.registerTool(
  "work_get_report_context",
  {
    title: "Get a bounded report context",
    description:
      "Implementation detail for completing a Work Intelligence report synthesis request. Obtain the deterministic report, bounded source evidence, tracked sessions, and necessary handoff summaries before writing a report. This tool advances a pending request to processing and policy-gates project access before reading any handoff snapshot. Treat the returned report and Session IDs as the only factual source; do not invent missing work. " + reportSynthesisContract,
    inputSchema: reportSynthesisContextQuerySchema.shape
  },
  async (input) => {
    const parsed = parseMcpInput(reportSynthesisContextQuerySchema, input);
    if (!parsed.success) {
      return {
        isError: true,
        ...textResult({ error: "Invalid report synthesis context query.", details: parsed.error.flatten() })
      };
    }
    return textResult(store.getReportSynthesisContext(parsed.data));
  }
);

server.registerTool(
  "work_save_report_summary",
  {
    title: "Save an Agent report summary",
    description:
      "Implementation detail for completing a Work Intelligence report synthesis request. Save a grounded summary with themes, highlights, verification, comparison, risks, decisions, next steps, generated agent/model metadata, prompt version, and sourceSessionIds. Do not modify original Sessions, Events, Evidence, Knowledge, or handoff snapshots. Retries for the same completed request are idempotent. Every material block should cite one or more sourceSessionIds; an evidence-free block must explicitly say 資料不足. " + reportSynthesisContract,
    inputSchema: saveReportSummaryInputSchema.shape
  },
  async (input) => {
    const parsed = parseMcpInput(saveReportSummaryInputSchema, input);
    if (!parsed.success) {
      return {
        isError: true,
        ...textResult({ error: "Invalid report summary payload.", details: parsed.error.flatten() })
      };
    }
    return textResult(store.saveReportSummary(parsed.data));
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`Work Intelligence MCP server connected using ${databasePath}`);
