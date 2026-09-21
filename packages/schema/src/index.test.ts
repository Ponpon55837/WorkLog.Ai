import { describe, expect, it } from "vitest";
import {
  finalizeSessionInputSchema,
  mcpFinalizeSessionInputSchema,
  metadataBackfillApplyInputSchema,
  updateSessionMetadataInputSchema
} from "./index.js";

const validFinalizeInput = {
  projectRoot: "C:/tracked/project",
  idempotencyKey: "session-1",
  title: "完成工作",
  summary: "完成一項工作",
  changedFiles: [],
  verification: { status: "not_run" as const }
};

const validStructuredWorkSummary = {
  outcomes: ["完成明確授權的工作紀錄流程。"],
  scope: ["更新 MCP contract 與 SQLite session schema。"],
  decisions: ["保留 Git commit 與工作完成狀態解耦。"],
  verification: ["已執行 schema 與 storage tests。"],
  nextSteps: ["由 Claude 進行複檢。"]
};

describe("schema input boundaries", () => {
  it("requires stable work summary sections at the MCP boundary", () => {
    expect(mcpFinalizeSessionInputSchema.safeParse(validFinalizeInput).success).toBe(false);
    expect(mcpFinalizeSessionInputSchema.safeParse({
      ...validFinalizeInput,
      workSummary: validStructuredWorkSummary
    }).success).toBe(true);
  });

  it("keeps the REST/store schema backward compatible for legacy finalize callers", () => {
    expect(finalizeSessionInputSchema.safeParse(validFinalizeInput).success).toBe(true);
  });

  it("rejects more than 200 changed files in finalize", () => {
    const result = finalizeSessionInputSchema.safeParse({
      ...validFinalizeInput,
      changedFiles: Array.from({ length: 201 }, (_, index) => `src/file-${index}.ts`)
    });

    expect(result.success).toBe(false);
  });

  it("rejects more than 200 changed files in metadata updates", () => {
    const result = updateSessionMetadataInputSchema.safeParse({
      sessionId: "session-1",
      changedFiles: Array.from({ length: 201 }, (_, index) => `src/file-${index}.ts`)
    });

    expect(result.success).toBe(false);
  });

  it("rejects more than 200 changed-file provenance entries in finalize", () => {
    const result = finalizeSessionInputSchema.safeParse({
      ...validFinalizeInput,
      changedFilesProvenance: Array.from({ length: 201 }, (_, index) => ({
        path: `src/file-${index}.ts`,
        sources: ["agent"]
      }))
    });

    expect(result.success).toBe(false);
  });

  it("rejects more than 200 changed-file lifecycle entries in finalize", () => {
    const result = finalizeSessionInputSchema.safeParse({
      ...validFinalizeInput,
      changedFileChanges: Array.from({ length: 201 }, (_, index) => ({
        path: `src/file-${index}.ts`,
        status: "modified"
      }))
    });

    expect(result.success).toBe(false);
  });

  it("rejects more than 200 changed-file provenance entries in metadata updates", () => {
    const result = updateSessionMetadataInputSchema.safeParse({
      sessionId: "session-1",
      changedFiles: [],
      changedFilesProvenance: Array.from({ length: 201 }, (_, index) => ({
        path: `src/file-${index}.ts`,
        sources: ["agent"]
      }))
    });

    expect(result.success).toBe(false);
  });

  it("rejects more than 200 changed-file lifecycle entries in metadata updates", () => {
    const result = updateSessionMetadataInputSchema.safeParse({
      sessionId: "session-1",
      changedFiles: [],
      changedFileChanges: Array.from({ length: 201 }, (_, index) => ({
        path: `src/file-${index}.ts`,
        status: "modified"
      }))
    });

    expect(result.success).toBe(false);
  });

  it("rejects more than 100 metadata backfill updates", () => {
    const result = metadataBackfillApplyInputSchema.safeParse({
      updates: Array.from({ length: 101 }, (_, index) => ({
        sessionId: `session-${index}`,
        changedFiles: []
      }))
    });

    expect(result.success).toBe(false);
  });
});
