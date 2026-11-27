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

function pageWithSlug(slug: string): KnowledgePageRecord {
  return {
    id: `page-${slug}`,
    projectId: "project-1",
    slug,
    title: slug,
    question: "What is moored where?",
    sections: [{ heading: "Moorings", content: "資料不足", sourceSessionIds: [] }],
    version: 1,
    status: "fresh",
    newSessionCount: 0,
    needsReview: false,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
  } as unknown as KnowledgePageRecord;
}

async function renderPanel(slug: string): Promise<string> {
  openPage.value = pageWithSlug(slug);
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
