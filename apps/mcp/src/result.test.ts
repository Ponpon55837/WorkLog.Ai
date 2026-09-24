import { describe, expect, it } from "vitest";
import { sessionTextResult, textResult, toSessionStructuredContent, toStructuredContent } from "./result.js";

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

  it("keeps skipped and not-found session responses machine-readable", () => {
    expect(
      toSessionStructuredContent({
        outcome: "skipped",
        projectStatus: "unregistered",
        reason: "Project is not registered.",
      }),
    ).toMatchObject({
      outcome: "skipped",
      sessionId: null,
      changedFilesCount: 0,
      verification: null,
    });

    const result = sessionTextResult({ outcome: "not_found", sessionId: "missing-session" });
    expect(result.content[0]?.type).toBe("text");
    expect(result.structuredContent).toMatchObject({
      outcome: "not_found",
      sessionId: "missing-session",
      changedFilesCount: 0,
      verification: null,
    });
  });
});
