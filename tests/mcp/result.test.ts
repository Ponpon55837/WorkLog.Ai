import { describe, expect, it } from "vitest";
import {
  sessionTextResult,
  textResult,
  toSessionStructuredContent,
  toStructuredContent,
} from "../../apps/mcp/src/result.js";

describe("MCP result contract", () => {
  it("exposes stable structured session metadata alongside text content", () => {
    const value = {
      outcome: "finalized",
      duplicate: false,
      session: {
        id: "session-1",
        executionStatus: "completed",
        changedFiles: ["src/index.ts", "README.md"],
        verification: { status: "passed" },
      },
    };

    expect(toStructuredContent(value)).toEqual({
      ...value,
      outcome: "finalized",
      sessionId: "session-1",
      executionStatus: "completed",
      changedFilesCount: 2,
      verification: { status: "passed" },
    });

    const result = textResult(value);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain('"session-1"');
    expect(result.structuredContent).toMatchObject({ sessionId: "session-1", changedFilesCount: 2 });
  });

  it("keeps the legacy helper conservative for non-session results", () => {
    expect(toStructuredContent({ outcome: "skipped", projectStatus: "paused" })).toBeUndefined();
    expect(toStructuredContent(null)).toBeUndefined();
    expect(textResult({ outcome: "skipped" })).not.toHaveProperty("structuredContent");
  });

  it("answers a projected Session read in text only", () => {
    const projected = {
      outcome: "session_detail",
      projection: { version: 1, view: "handoff", includedFields: ["session.summary"], unavailableFields: [] },
      session: { id: "session-1", status: "finalized", executionStatus: "completed", summary: "Fictional summary" },
    };
    const result = textResult(projected);
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual(projected);
    expect(result).not.toHaveProperty("structuredContent");
  });

  it("passes non-session results through without Session defaults", () => {
    // Claude Code and Codex hand the model structuredContent alone, so it must not claim a completed save.
    const skipped = { outcome: "skipped", projectStatus: "unregistered", reason: "Project is not registered." };
    expect(toSessionStructuredContent(skipped)).toEqual(skipped);

    const conflict = { outcome: "idempotency_conflict", reason: "The key was used with different content." };
    const conflictResult = sessionTextResult(conflict);
    expect(conflictResult.structuredContent).toEqual(conflict);
    expect(conflictResult.structuredContent).toEqual(JSON.parse(conflictResult.content[0]?.text ?? ""));

    const missing = { outcome: "not_found", sessionId: "missing-session" };
    expect(sessionTextResult(missing).structuredContent).toEqual(missing);
  });

  it("keeps everything the text says in a session_unchanged result", () => {
    const unchanged = {
      outcome: "session_unchanged",
      session: { id: "session-1", revision: "rev-1", title: "Fictional title", projectId: "project-1" },
    };
    const result = textResult(unchanged);
    expect(result.structuredContent).toEqual({ ...unchanged, sessionId: "session-1", revision: "rev-1" });
    expect(result.structuredContent).toMatchObject(JSON.parse(result.content[0]?.text ?? ""));
  });
});
