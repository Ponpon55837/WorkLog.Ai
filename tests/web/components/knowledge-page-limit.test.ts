import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { KnowledgePageRecord } from "@work-intelligence/core";
import KnowledgePageEditorDialog from "../../../apps/web/src/components/domain/KnowledgePageEditorDialog.vue";
import KnowledgePageLimitNotice from "../../../apps/web/src/components/domain/KnowledgePageLimitNotice.vue";
import { loadCatalog, locale, t } from "../../../apps/web/src/i18n/index.js";

// The dialog shell traps focus through `document`; it is replaced by a plain wrapper so the form renders on the server.
vi.mock("../../../apps/web/src/components/ui/UiDialog.vue", async () => {
  const { defineComponent, h: render } = await import("vue");
  return {
    default: defineComponent({
      setup:
        (_, { slots }) =>
        () =>
          render("div", [slots.default?.()]),
    }),
  };
});
vi.mock("../../../apps/web/src/stores/knowledge-pages", () => ({ useKnowledgePagesStore: () => ({}) }));
vi.mock("../../../apps/web/src/composables/useToast", () => ({ useToast: () => ({ showToast: () => undefined }) }));

type Section = { heading: string; content: string };

function sectionsOf(count: number, chars: number): Section[] {
  return Array.from({ length: count }, (_, index) => ({ heading: `Section ${index + 1}`, content: "x".repeat(chars) }));
}

async function renderNotice(sections: Section[]): Promise<string> {
  return renderToString(createSSRApp({ render: () => h(KnowledgePageLimitNotice, { sections }) }));
}

async function renderEditor(sections: Section[]): Promise<string> {
  const page = {
    id: "page-1",
    title: "Page",
    version: 1,
    sections: sections.map((section) => ({ ...section, sourceSessionIds: ["session-1"] })),
  } as unknown as KnowledgePageRecord;
  return renderToString(createSSRApp({ render: () => h(KnowledgePageEditorDialog, { open: true, page }) }));
}

beforeAll(async () => {
  await loadCatalog("zh-TW");
  locale.value = "zh-TW";
});

describe("KnowledgePageLimitNotice", () => {
  it("shows nothing below the thresholds", async () => {
    expect(await renderNotice(sectionsOf(10, 700))).not.toContain("knowledge-page-limit");
  });

  it("shows usage and the largest headings when the content is near the limit", async () => {
    const html = await renderNotice([
      { heading: "Small", content: "x".repeat(100) },
      { heading: "Big", content: "x".repeat(4_000) },
      { heading: "Medium", content: "x".repeat(3_200) },
    ]);
    expect(html).toContain("knowledge-page-limit");
    expect(html).toContain(t("knowledge.pageLimitUsage", { chars: "7,300", maxChars: "8,000", count: "3", max: "12" }));
    expect(html).toContain(t("knowledge.pageLimitMoveSections", { headings: "「Big」、「Medium」" }));
    expect(html).toContain(t("knowledge.pageLimitNearTitle"));
    expect(html).not.toContain(t("knowledge.pageLimitOverSave"));
  });

  it("shows the notice when the section count is near the limit", async () => {
    const html = await renderNotice(sectionsOf(11, 10));
    expect(html).toContain(t("knowledge.pageLimitUsage", { chars: "110", maxChars: "8,000", count: "11", max: "12" }));
    expect(html).toContain(
      t("knowledge.pageLimitMoveSections", { headings: "「Section 1」、「Section 2」、「Section 3」" }),
    );
  });

  it("falls back to a generic suggestion when no section has a heading yet", async () => {
    const html = await renderNotice(sectionsOf(11, 10).map((section) => ({ ...section, heading: " " })));
    expect(html).toContain(t("knowledge.pageLimitMoveLargest"));
  });
});

describe("KnowledgePageEditorDialog limit notice", () => {
  it("renders no notice while the draft is below the thresholds", async () => {
    expect(await renderEditor(sectionsOf(3, 100))).not.toContain("knowledge-page-limit");
  });

  it("warns near the limit without announcing a refused save", async () => {
    const html = await renderEditor(sectionsOf(12, 600));
    expect(html).toContain(t("knowledge.pageLimitNearTitle"));
    expect(html).toContain(
      t("knowledge.pageLimitUsage", { chars: "7,200", maxChars: "8,000", count: "12", max: "12" }),
    );
    expect(html).not.toContain(t("knowledge.pageLimitOverSave"));
  });

  it("says the save will be refused when the draft is over the limit", async () => {
    const html = await renderEditor(sectionsOf(12, 700));
    expect(html).toContain(t("knowledge.pageLimitOverTitle"));
    expect(html).toContain(t("knowledge.pageLimitOverSave"));
  });
});
