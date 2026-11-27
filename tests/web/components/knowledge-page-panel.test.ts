import { createSSRApp, h, reactive, ref } from "vue";
import { renderToString } from "vue/server-renderer";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { KnowledgePageRecord } from "@work-intelligence/core";
import KnowledgePagePanel from "../../../apps/web/src/components/domain/KnowledgePagePanel.vue";
import { loadCatalog, locale, t } from "../../../apps/web/src/i18n/index.js";

const openPage = ref<KnowledgePageRecord | null>(null);

// The side panel shell traps focus through `document`; a plain wrapper renders its slots on the server.
vi.mock("../../../apps/web/src/components/ui/UiSidePanel.vue", async () => {
  const { defineComponent, h: render } = await import("vue");
  return {
    default: defineComponent({
      setup:
        (_, { slots }) =>
        () =>
          render("div", [slots.header?.(), slots.default?.()]),
    }),
  };
});
vi.mock("../../../apps/web/src/stores/knowledge-pages", () => ({
  useKnowledgePagesStore: () =>
    reactive({
      openPage,
      versions: ref([]),
      versionsLoading: ref(false),
      versionsError: ref(""),
      sources: ref([]),
      deleteOpenPage: vi.fn(),
    }),
}));
vi.mock("../../../apps/web/src/stores/sessions", () => ({ useSessionsStore: () => ({}) }));
vi.mock("../../../apps/web/src/composables/useToast", () => ({ useToast: () => ({ showToast: () => undefined }) }));

function pageWithSlug(slug: string, sections?: KnowledgePageRecord["sections"]): KnowledgePageRecord {
  return {
    id: `page-${slug}`,
    projectId: "project-1",
    slug,
    title: slug,
    question: "What is moored where?",
    sections: sections ?? [{ heading: "Moorings", content: "資料不足", sourceSessionIds: [] }],
    version: 1,
    status: "fresh",
    newSessionCount: 0,
    needsReview: false,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
  } as unknown as KnowledgePageRecord;
}

async function renderPanel(slug: string, sections?: KnowledgePageRecord["sections"]): Promise<string> {
  openPage.value = pageWithSlug(slug, sections);
  return renderToString(createSSRApp({ render: () => h(KnowledgePagePanel, { projects: [] }) }));
}

beforeAll(async () => {
  await loadCatalog("zh-TW");
  locale.value = "zh-TW";
});

describe("KnowledgePagePanel deletion", () => {
  it("offers deletion on a custom page", async () => {
    expect(await renderPanel("harbour-moorings")).toContain(t("knowledge.deleteKnowledgePage"));
  });

  it.each(["architecture", "in-progress", "pitfalls"])("never offers deletion on the default %s page", async (slug) => {
    const html = await renderPanel(slug);
    expect(html).toContain(t("knowledge.askAgentToUpdate"));
    expect(html).not.toContain(t("knowledge.deleteKnowledgePage"));
  });
});

describe("KnowledgePagePanel reading", () => {
  it("splits line breaks into paragraphs and lists as plain text", async () => {
    const html = await renderPanel("harbour-moorings", [
      {
        heading: "Moorings",
        content: "First line\n\nSecond <b>line</b>\n- one\n- two\n1. alpha",
        sourceSessionIds: [],
      },
    ]);

    const text = html.slice(html.indexOf("page-panel__text"), html.indexOf("page-panel__history"));
    expect(text.match(/<p[ >]/g)).toHaveLength(2);
    expect(text.match(/<ul[ >]/g)).toHaveLength(1);
    expect(text.match(/<ol[ >]/g)).toHaveLength(1);
    expect(html).toContain("Second &lt;b&gt;line&lt;/b&gt;");
  });

  it("lists sources under a count heading and previews only the first three", async () => {
    const ids = ["s1", "s2", "s3", "s4", "s5"];
    const html = await renderPanel("harbour-moorings", [
      { heading: "Moorings", content: "Text", sourceSessionIds: ids },
    ]);

    expect(html).toContain(t("knowledge.sourcesCount", { count: 5 }));
    expect(html).toContain(t("knowledge.showAllSources", { count: 5 }));
    expect(html.match(/Session s\d/g)).toHaveLength(3);
  });

  it("offers no sources block for a section without sources", async () => {
    expect(await renderPanel("harbour-moorings")).not.toContain(t("knowledge.sourcesCount", { count: 0 }));
  });
});
