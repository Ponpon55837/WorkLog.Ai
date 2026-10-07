import { describe, expect, it } from "vitest";
import type { SessionDetail, WorkSessionRecord } from "../../../packages/core/src/index.js";
import { t } from "../../../apps/web/src/i18n/index.js";
import { formatDate } from "../../../apps/web/src/utils/format.js";
import { sessionMarkdown } from "../../../apps/web/src/utils/session-markdown.js";

const COMPLETED_AT = "2026-03-04T09:30:00.000Z";

function detail(overrides: Partial<WorkSessionRecord> = {}): SessionDetail {
  const session = {
    id: "session-0001",
    title: "Add the sample widget",
    summary: "Built the sample widget.\nIt renders a list.",
    completedAt: COMPLETED_AT,
    changedFiles: [],
    ...overrides,
  } as WorkSessionRecord;
  return { session, project: { name: "Sample Project" } } as SessionDetail;
}

describe("sessionMarkdown", () => {
  it("renders a full Session with every section in order", () => {
    const markdown = sessionMarkdown(
      detail({
        verification: { status: "passed", summary: "Unit tests green" },
        gitBranch: "feat/widget",
        commitSha: "abcdef1234567890",
        workSummary: {
          outcomes: ["Widget shipped"],
          scope: ["Widget only"],
          decisions: ["Keep it simple"],
          verification: ["Ran unit tests"],
          nextSteps: ["Add docs"],
        },
        changedFiles: ["src/widget.ts", "src/widget.test.ts"],
      }),
    );

    expect(markdown).toBe(
      [
        "# Add the sample widget",
        [
          `- ${t("common.project")}: Sample Project`,
          `- ${t("common.completed")}: ${formatDate(COMPLETED_AT)}`,
          `- ${t("common.verification")}: ${t("common.passed")} — Unit tests green`,
          `- ${t("labels.git")}: feat/widget @ abcdef1`,
        ].join("\n"),
        "Built the sample widget.\nIt renders a list.",
        `## ${t("labels.outcomes")}\n- Widget shipped`,
        `## ${t("labels.scope")}\n- Widget only`,
        `## ${t("common.decisions")}\n- Keep it simple`,
        `## ${t("common.verification")}\n- Ran unit tests`,
        `## ${t("common.statusOpenItems")}\n- Add docs`,
        `## ${t("labels.changedFiles")}\n_${t("common.notTheSameAsGit")}_\n\n- \`src/widget.ts\`\n- \`src/widget.test.ts\``,
      ].join("\n\n") + "\n",
    );
    expect(markdown).not.toContain("session-0001");
  });

  it("labels a missing verification as not reported, never not run, and omits empty parts", () => {
    const markdown = sessionMarkdown(detail({ summary: "  " }));

    expect(markdown).toContain(`- ${t("common.verification")}: ${t("common.notReported")}`);
    expect(markdown).not.toContain(t("common.notRun"));
    expect(markdown).not.toContain("## ");
    expect(markdown).not.toContain(`${t("labels.git")}:`);
    expect(markdown).not.toContain(t("session.voidedLabel"));
  });

  it("marks a voided Session", () => {
    const markdown = sessionMarkdown(detail({ voided: { at: COMPLETED_AT, reason: "Recorded twice." } }));

    expect(markdown).toContain(`- ${t("session.voidedLabel")}`);
  });

  it("omits empty workSummary sections", () => {
    const markdown = sessionMarkdown(
      detail({ workSummary: { outcomes: ["Done"], scope: [], decisions: [], verification: [], nextSteps: [] } }),
    );

    expect(markdown).toContain(`## ${t("labels.outcomes")}`);
    expect(markdown).not.toContain(`## ${t("labels.scope")}`);
    expect(markdown).not.toContain(`## ${t("common.statusOpenItems")}`);
  });

  it("lists at most 20 changed files and counts the rest", () => {
    const changedFiles = Array.from({ length: 23 }, (_, index) => `src/file-${index + 1}.ts`);
    const markdown = sessionMarkdown(detail({ changedFiles }));

    expect(markdown).toContain("- `src/file-20.ts`");
    expect(markdown).not.toContain("src/file-21.ts");
    expect(markdown).toContain(`- ${t("session.markdownMoreFiles", { count: 3 })}`);
  });
});
