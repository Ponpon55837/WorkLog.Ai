import { describe, expect, it } from "vitest";
import {
  reportQuerySchema,
  reportExportQuerySchema,
  finalizeSessionInputSchema,
  graphQuerySchema,
  insightAvailabilitySchema,
  insightEvaluationSchema,
  insightProviderDescriptorSchema,
  insightQuestionSchema,
  mcpCreateMetadataBackfillRequestInputSchema,
  mcpCreateReportSynthesisRequestInputSchema,
  mcpFinalizeSessionInputSchema,
  mcpListSessionsInputSchema,
  metadataBackfillApplyInputSchema,
  projectStatusQuerySchema,
  contextQuerySchema,
  decideKnowledgeCandidateInputSchema,
  knowledgeCandidateContextQuerySchema,
  submitKnowledgeCandidatesInputSchema,
  recallQuerySchema,
  setEvidenceVoidInputSchema,
  setSessionVoidInputSchema,
  sessionDetailQuerySchema,
  sessionsQuerySchema,
  updateKnowledgeInputSchema,
  updateSessionMetadataInputSchema,
  updateSessionWorkSummaryInputSchema,
} from "./index.js";

const validFinalizeInput = {
  projectRoot: "C:/tracked/project",
  idempotencyKey: "session-1",
  title: "完成工作",
  summary: "完成一項工作",
  changedFiles: [],
  verification: { status: "not_run" as const },
};

const validStructuredWorkSummary = {
  outcomes: ["完成明確授權的工作紀錄流程。"],
  scope: ["更新 MCP contract 與 SQLite session schema。"],
  decisions: ["保留 Git commit 與工作完成狀態解耦。"],
  verification: ["已執行 schema 與 storage tests。"],
  nextSteps: ["由 Claude 進行複檢。"],
};

describe("schema input boundaries", () => {
  it("mirrors the frozen InsightProvider contracts", () => {
    expect(
      insightProviderDescriptorSchema.safeParse({
        id: "jev",
        execution: "external",
        model: "jev-default",
      }).success,
    ).toBe(true);
    expect(insightAvailabilitySchema.safeParse("policy_denied").success).toBe(true);
    expect(insightAvailabilitySchema.safeParse("denied").success).toBe(false);
    expect(
      insightQuestionSchema.safeParse({
        type: "noul",
        instructions: "Is this meaningful?",
      }).success,
    ).toBe(true);
    expect(
      insightQuestionSchema.safeParse({
        type: "null",
        instructions: "Is this meaningful?",
      }).success,
    ).toBe(false);
    expect(
      insightEvaluationSchema.safeParse({
        provider: "jev",
        model: "jev-default",
        results: { impact: { value: 0.8, confidence: 0.9 } },
        latencyMs: 120,
        evaluatedAt: "2026-09-22T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("requires stable work summary sections at the MCP boundary", () => {
    expect(mcpFinalizeSessionInputSchema.safeParse(validFinalizeInput).success).toBe(false);
    expect(
      mcpFinalizeSessionInputSchema.safeParse({
        ...validFinalizeInput,
        workSummary: validStructuredWorkSummary,
      }).success,
    ).toBe(true);
  });

  it("validates finalized workSummary replace and patch semantics", () => {
    const replace = updateSessionWorkSummaryInputSchema.safeParse({
      sessionId: "session-1",
      idempotencyKey: "work-summary-update-1",
      mode: "replace",
      workSummary: validStructuredWorkSummary,
    });
    expect(replace.success).toBe(true);

    const patch = updateSessionWorkSummaryInputSchema.safeParse({
      sessionId: "session-1",
      idempotencyKey: "work-summary-update-2",
      mode: "patch",
      workSummary: { nextSteps: [] },
    });
    expect(patch.success).toBe(true);
    expect(
      updateSessionWorkSummaryInputSchema.safeParse({
        sessionId: "session-1",
        idempotencyKey: "work-summary-update-3",
        mode: "replace",
        workSummary: { nextSteps: [] },
      }).success,
    ).toBe(false);
    expect(
      updateSessionWorkSummaryInputSchema.safeParse({
        sessionId: "session-1",
        idempotencyKey: "work-summary-update-4",
        mode: "patch",
        workSummary: {},
      }).success,
    ).toBe(false);
  });

  it("keeps the REST/store schema backward compatible for legacy finalize callers", () => {
    expect(finalizeSessionInputSchema.safeParse(validFinalizeInput).success).toBe(true);
  });

  it("rejects more than 200 changed files in finalize", () => {
    const result = finalizeSessionInputSchema.safeParse({
      ...validFinalizeInput,
      changedFiles: Array.from({ length: 201 }, (_, index) => `src/file-${index}.ts`),
    });

    expect(result.success).toBe(false);
  });

  it("rejects more than 200 changed files in metadata updates", () => {
    const result = updateSessionMetadataInputSchema.safeParse({
      sessionId: "session-1",
      changedFiles: Array.from({ length: 201 }, (_, index) => `src/file-${index}.ts`),
    });

    expect(result.success).toBe(false);
  });

  it("rejects more than 200 changed-file provenance entries in finalize", () => {
    const result = finalizeSessionInputSchema.safeParse({
      ...validFinalizeInput,
      changedFilesProvenance: Array.from({ length: 201 }, (_, index) => ({
        path: `src/file-${index}.ts`,
        sources: ["agent"],
      })),
    });

    expect(result.success).toBe(false);
  });

  it("rejects more than 200 changed-file lifecycle entries in finalize", () => {
    const result = finalizeSessionInputSchema.safeParse({
      ...validFinalizeInput,
      changedFileChanges: Array.from({ length: 201 }, (_, index) => ({
        path: `src/file-${index}.ts`,
        status: "modified",
      })),
    });

    expect(result.success).toBe(false);
  });

  it("rejects more than 200 changed-file provenance entries in metadata updates", () => {
    const result = updateSessionMetadataInputSchema.safeParse({
      sessionId: "session-1",
      changedFiles: [],
      changedFilesProvenance: Array.from({ length: 201 }, (_, index) => ({
        path: `src/file-${index}.ts`,
        sources: ["agent"],
      })),
    });

    expect(result.success).toBe(false);
  });

  it("rejects more than 200 changed-file lifecycle entries in metadata updates", () => {
    const result = updateSessionMetadataInputSchema.safeParse({
      sessionId: "session-1",
      changedFiles: [],
      changedFileChanges: Array.from({ length: 201 }, (_, index) => ({
        path: `src/file-${index}.ts`,
        status: "modified",
      })),
    });

    expect(result.success).toBe(false);
  });

  it("rejects more than 100 metadata backfill updates", () => {
    const result = metadataBackfillApplyInputSchema.safeParse({
      updates: Array.from({ length: 101 }, (_, index) => ({
        sessionId: `session-${index}`,
        changedFiles: [],
      })),
    });

    expect(result.success).toBe(false);
  });

  it("requires previousPath when a changed file is renamed", () => {
    expect(
      finalizeSessionInputSchema.safeParse({
        ...validFinalizeInput,
        changedFileChanges: [{ path: "src/new.ts", status: "renamed" }],
      }).success,
    ).toBe(false);
    expect(
      finalizeSessionInputSchema.safeParse({
        ...validFinalizeInput,
        changedFileChanges: [{ path: "src/new.ts", status: "renamed", previousPath: "src/old.ts" }],
      }).success,
    ).toBe(true);
  });

  it("rejects reversed session date ranges", () => {
    expect(sessionsQuerySchema.safeParse({ from: "2026-09-22", to: "2026-09-21" }).success).toBe(false);
    expect(sessionsQuerySchema.safeParse({ from: "2026-09-21", to: "2026-09-22" }).success).toBe(true);
  });

  it("accepts bounded graph cursor pages and rejects oversized pages", () => {
    expect(graphQuerySchema.safeParse({ pageSize: 500, cursor: "cursor-1" }).success).toBe(true);
    expect(graphQuerySchema.safeParse({ pageSize: 501 }).success).toBe(false);
  });

  it("requires at least one Knowledge field when updating", () => {
    expect(
      updateKnowledgeInputSchema.safeParse({
        projectRoot: "C:/tracked/project",
        knowledgeId: "knowledge-1",
      }).success,
    ).toBe(false);
    expect(
      updateKnowledgeInputSchema.safeParse({
        projectRoot: "C:/tracked/project",
        knowledgeId: "knowledge-1",
        title: "Updated title",
      }).success,
    ).toBe(true);
  });
});

describe("MCP-only input schemas", () => {
  it("requires a projectRoot for project status and defaults raw snapshots off", () => {
    expect(projectStatusQuerySchema.safeParse({}).success).toBe(false);
    expect(projectStatusQuerySchema.safeParse({ projectRoot: "C:/tracked/project" }).success).toBe(true);
    expect(sessionDetailQuerySchema.parse({ sessionId: "session-1" })).toEqual({
      sessionId: "session-1",
      includeRawSnapshots: false,
    });
  });

  it("bounds the MCP session list and rejects reversed date ranges", () => {
    expect(mcpListSessionsInputSchema.parse({})).toMatchObject({ page: 1, pageSize: 20 });
    expect(mcpListSessionsInputSchema.safeParse({ pageSize: 0 }).success).toBe(false);
    expect(mcpListSessionsInputSchema.safeParse({ pageSize: 101 }).success).toBe(false);
    expect(mcpListSessionsInputSchema.safeParse({ from: "2026-09-01", to: "2026-09-30" }).success).toBe(true);
    const reversed = mcpListSessionsInputSchema.safeParse({ from: "2026-09-30", to: "2026-09-01" });
    expect(reversed.success).toBe(false);
    expect(reversed.error?.issues[0]?.path).toEqual(["to"]);
  });

  it("accepts a projectRoot scope for Agent-created requests", () => {
    expect(
      mcpCreateReportSynthesisRequestInputSchema.parse({ projectRoot: "C:/tracked/project", period: "month" }),
    ).toMatchObject({ projectRoot: "C:/tracked/project", period: "month" });
    expect(mcpCreateReportSynthesisRequestInputSchema.parse({})).toMatchObject({ period: "week" });
    expect(mcpCreateMetadataBackfillRequestInputSchema.safeParse({ projectRoot: "" }).success).toBe(false);
    expect(mcpCreateMetadataBackfillRequestInputSchema.safeParse({ projectId: "project-1" }).success).toBe(true);
  });

  it("requires q or paths for recall and bounds context focus", () => {
    expect(recallQuerySchema.safeParse({ q: "cache" }).success).toBe(true);
    expect(recallQuerySchema.safeParse({ paths: ["src/a.ts"] }).success).toBe(true);
    expect(recallQuerySchema.safeParse({ projectRoot: "/tmp/p" }).success).toBe(false);
    expect(recallQuerySchema.safeParse({ q: "x", limit: 31 }).success).toBe(false);
    expect(contextQuerySchema.safeParse({ task: "fix", paths: ["src/a.ts"] }).success).toBe(true);
    expect(contextQuerySchema.safeParse({ paths: Array.from({ length: 21 }, () => "a.ts") }).success).toBe(false);
  });

  it("requires a reason to void but not to restore", () => {
    expect(setSessionVoidInputSchema.safeParse({ sessionId: "s1" }).success).toBe(false);
    expect(setSessionVoidInputSchema.parse({ sessionId: "s1", reason: "test" })).toMatchObject({ voided: true });
    expect(setSessionVoidInputSchema.safeParse({ sessionId: "s1", voided: false }).success).toBe(true);
    expect(setEvidenceVoidInputSchema.safeParse({ evidenceId: "e1", voided: true }).success).toBe(false);
    expect(setEvidenceVoidInputSchema.safeParse({ evidenceId: "e1", voided: false }).success).toBe(true);
    expect(sessionsQuerySchema.parse({}).voided).toBe("exclude");
    expect(sessionsQuerySchema.safeParse({ voided: "all" }).success).toBe(false);
  });

  it("validates Knowledge candidate requests, submissions, and decisions", () => {
    expect(knowledgeCandidateContextQuerySchema.safeParse({}).success).toBe(false);
    expect(knowledgeCandidateContextQuerySchema.safeParse({ projectRoot: "/tmp/p" }).success).toBe(true);
    const candidate = { sourceSessionId: "s1", kind: "gotcha", title: "T", body: "B", rationale: "R" };
    expect(submitKnowledgeCandidatesInputSchema.safeParse({ requestId: "r1", candidates: [candidate] }).success).toBe(
      true,
    );
    expect(
      submitKnowledgeCandidatesInputSchema.safeParse({ requestId: "r1", candidates: [{ ...candidate, rationale: "" }] })
        .success,
    ).toBe(false);
    expect(decideKnowledgeCandidateInputSchema.safeParse({ candidateId: "c1", decision: "maybe" }).success).toBe(false);
  });
});

describe("custom report ranges", () => {
  it("accepts an ordered from/to pair of up to 366 days", () => {
    expect(reportQuerySchema.safeParse({ from: "2030-01-01", to: "2030-01-14" }).success).toBe(true);
    expect(reportQuerySchema.safeParse({ from: "2030-01-01", to: "2031-01-01" }).success).toBe(true);
    expect(reportExportQuerySchema.safeParse({ from: "2030-01-01", to: "2030-01-01", format: "json" }).success).toBe(
      true,
    );
  });

  it("rejects a lone bound, a reversed range, and a range longer than 366 days", () => {
    expect(reportQuerySchema.safeParse({ from: "2030-01-01" }).success).toBe(false);
    expect(reportQuerySchema.safeParse({ from: "2030-01-14", to: "2030-01-01" }).success).toBe(false);
    expect(reportQuerySchema.safeParse({ from: "2030-01-01", to: "2031-01-02" }).success).toBe(false);
    expect(reportExportQuerySchema.safeParse({ to: "2030-01-01" }).success).toBe(false);
  });
});
