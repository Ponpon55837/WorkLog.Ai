import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { describe, expect, it } from "vitest";
import type { WorkSessionRecord } from "../../../packages/core/src/index.js";
import SessionRow from "../../../apps/web/src/components/domain/SessionRow.vue";
import { loadCatalog, locale, t } from "../../../apps/web/src/i18n/index.js";

type RowProps = InstanceType<typeof SessionRow>["$props"];

const session = {
  id: "s1",
  projectId: "p1",
  projectName: "Orchard",
  title: "Fix the parser <b>crash</b>",
  summary: "Handled empty input in the tokenizer.",
  completedAt: "2026-11-01T10:00:00Z",
  updatedAt: "2026-11-01T10:00:00Z",
  changedFiles: [],
} as unknown as WorkSessionRecord;

function render(props: Partial<RowProps>): Promise<string> {
  return renderToString(createSSRApp({ render: () => h(SessionRow, { session, timeline: true, ...props }) }));
}

describe("SessionRow search highlighting", () => {
  it("wraps matched words in <mark> and escapes the Session text", async () => {
    const html = await render({ highlight: "parser tokenizer" });

    expect(html).toMatch(/<mark[^>]*>parser<\/mark>/);
    expect(html).toMatch(/<mark[^>]*>tokenizer<\/mark>/);
    expect(html).toContain("&lt;b&gt;crash&lt;/b&gt;");
    expect(html).not.toContain("<b>crash</b>");
  });

  it("shows no mark and no hint without a search", async () => {
    await loadCatalog(locale.value);
    const html = await render({});

    expect(html).not.toContain("<mark");
    expect(html).toContain("Orchard");
    expect(html).not.toContain(t("sessions.matchedInEvents"));
  });

  it("shows the matched excerpt with its field when the match is not in the visible text", async () => {
    await loadCatalog(locale.value);
    const shown = {
      ...session,
      workSummary: { outcomes: ["Shipped"], scope: [], decisions: [], verification: [], nextSteps: [] },
    };
    const html = await render({ highlight: "tokenizer", session: shown });

    expect(html).toContain(t("sessions.matchedField", { field: t("session.summary") }));
    expect(html).toMatch(/<mark[^>]*>tokenizer<\/mark>/);
  });

  it("reports a match in the events when no field the list carries has it", async () => {
    await loadCatalog(locale.value);
    const html = await render({ highlight: "stacktrace" });

    expect(html).not.toContain("<mark");
    expect(html).toContain(t("sessions.matchedInEvents"));
  });

  it("does not count the project name as a match", async () => {
    await loadCatalog(locale.value);
    const html = await render({ highlight: "orchard" });

    expect(html).not.toContain("<mark");
    expect(html).toContain(t("sessions.matchedInEvents"));
  });
});
