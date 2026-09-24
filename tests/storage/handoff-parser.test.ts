import { describe, expect, it } from "vitest";
import {
  classifyHandoff,
  extractChangedFiles,
  fileTokenFromLine,
  findStatusSignals,
  MAX_HANDOFF_CONTENT_LENGTH,
  MAX_HANDOFF_STATUS_SIGNALS,
  MAX_PARSED_CHANGED_FILES,
  parseHandoffContent,
  parseVerification,
  stripFencedCodeBlocks,
} from "../../packages/storage/src/handoff-parser.js";

describe("handoff parser", () => {
  it("understands mixed English and Traditional Chinese completion signals", () => {
    const content = `# UI 修正\n\n## Status\n已完成 / accepted\n\n## Verification\nVerification: passed`;
    const signals = findStatusSignals(content);

    expect(signals).toContain("已完成 / accepted");
    expect(classifyHandoff("UI 修正", signals)).toMatchObject({ decision: "eligible" });
    expect(parseVerification(content).status).toBe("passed");
  });

  it("stops changed-file sections at the next heading regardless of heading depth", () => {
    const content = `# Closing\n\n## Changed Files\n- src/real.ts\n### Notes\n- docs/should-not-be-read.md\n#### Verification\npassed`;

    expect(extractChangedFiles(content, "C:/work/project")).toEqual(["src/real.ts"]);
  });

  it("does not infer status or changed files from fenced code examples", () => {
    const content = `# Draft\n\n\`\`\`md\n## Status: completed\nchangedFiles: ["src/fake.ts"]\n\`\`\`\n\n## Status\npending\n\n## Changed Files\n- src/real.ts\n\`\`\`text\n- src/fake-2.ts\n\`\`\``;

    expect(findStatusSignals(content)).toEqual(["pending"]);
    expect(extractChangedFiles(content, "C:/work/project")).toEqual(["src/real.ts"]);
    expect(parseHandoffContent(content, "C:/work/project", ".openspec/handoffs/draft.md").classification).toMatchObject(
      {
        decision: "excluded",
        reason: "pending",
      },
    );
  });

  it("removes unclosed fences and bounds parser input", () => {
    const content = `## Status: completed\n\`\`\`md\nStatus: pending\n${"x".repeat(MAX_HANDOFF_CONTENT_LENGTH)}\nStatus: pending`;

    expect(stripFencedCodeBlocks(content)).toBe("## Status: completed");
    expect(findStatusSignals(content)).toEqual(["completed"]);
  });

  it("accepts bounded relative file paths and rejects outside or non-file tokens", () => {
    expect(fileTokenFromLine("- src/components/Button.vue")).toBe("src/components/Button.vue");
    expect(fileTokenFromLine("- WorkLog.Ai/src/components/Button.vue")).toBe("WorkLog.Ai/src/components/Button.vue");
    expect(fileTokenFromLine("- ../outside.ts")).toBeUndefined();
    expect(fileTokenFromLine("- C:/outside.ts")).toBeUndefined();
    expect(extractChangedFiles("## Changed Files\n- ../outside.ts\n- src/inside.ts", "C:/work/project")).toEqual([
      "src/inside.ts",
    ]);
  });

  it("normalizes inline changedFiles and removes duplicates case-insensitively", () => {
    const content = `changedFiles: ["src/App.vue", "src/app.vue"]`;
    expect(extractChangedFiles(content, "C:/work/project")).toEqual(["src/App.vue"]);
  });

  it("caps parser output to the public metadata limits", () => {
    const changedFiles = Array.from(
      { length: MAX_PARSED_CHANGED_FILES + 20 },
      (_, index) => `- src/file-${index}.ts`,
    ).join("\n");
    const statusSignals = Array.from(
      { length: MAX_HANDOFF_STATUS_SIGNALS + 20 },
      (_, index) => `Status: completed-${index}`,
    ).join("\n");

    expect(extractChangedFiles(`## Changed Files\n${changedFiles}`, "C:/work/project")).toHaveLength(
      MAX_PARSED_CHANGED_FILES,
    );
    expect(findStatusSignals(statusSignals)).toHaveLength(MAX_HANDOFF_STATUS_SIGNALS);
  });
});
