import { createSSRApp, h, reactive, ref } from "vue";
import { renderToString } from "vue/server-renderer";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgePageRecord, ProjectRecord } from "@work-intelligence/core";
import KnowledgePagesBox from "../../../apps/web/src/components/domain/KnowledgePagesBox.vue";
import { loadCatalog, locale, t } from "../../../apps/web/src/i18n/index.js";

const pages = ref<KnowledgePageRecord[]>([]);

vi.mock("../../../apps/web/src/stores/knowledge-pages", () => ({
  useKnowledgePagesStore: () =>
    reactive({ pages, pagesLoading: false, pagesError: "", showPage: vi.fn(), requestUpdate: vi.fn() }),
}));
vi.mock("../../../apps/web/src/composables/useToast", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../../apps/web/src/composables/useProjectChip", () => ({ useProjectChip: () => ref(undefined) }));
vi.mock("../../../apps/web/src/components/domain/ProjectFilterMenu.vue", () => ({ default: { render: () => null } }));
vi.mock("../../../apps/web/src/components/domain/KnowledgePageRequestDialog.vue", () => ({
  default: { render: () => null },
}));
vi.mock("../../../apps/web/src/components/VirtualList.vue", () => ({
  default: {
    props: ["items"],
    setup(props: { items: unknown[] }, { slots }: { slots: { default?: (scope: { item: unknown }) => unknown } }) {
      return () => props.items.map((item) => slots.default?.({ item }));
    },
  },
}));

const project = { id: "project-1", name: "Orchard", rootPath: "/work/orchard" } as ProjectRecord;

function page(slug: string, updateRequestedAt?: string): KnowledgePageRecord {
  return {
    id: `page-${slug}`,
    projectId: "project-1",
    slug,
    title: `Page ${slug}`,
    question: `What is ${slug}?`,
    status: "fresh",
    version: 1,
    newSessionCount: 0,
    ...(updateRequestedAt ? { updateRequestedAt } : {}),
  } as KnowledgePageRecord;
}

function render(): Promise<string> {
  return renderToString(
    createSSRApp({ render: () => h(KnowledgePagesBox, { projects: [project], projectId: "project-1" }) }),
  );
}

beforeAll(async () => {
  await loadCatalog("en-US");
  locale.value = "en-US";
});

beforeEach(() => {
  pages.value = [];
});

describe("KnowledgePagesBox handoff", () => {
  it("shows the command and the waiting count once an update was requested", async () => {
    pages.value = [page("architecture", "2030-01-01T00:00:00.000Z"), page("testing")];

    const html = await render();

    expect(html).toContain('data-testid="knowledge-pages-handoff"');
    expect(html).toContain(t("knowledge.pagesCommand"));
    expect(html).toContain(t("knowledge.knowledgePagesAreWaitingFor", { waitingCount: 1 }));
  });

  it("shows no handoff block while nothing is requested", async () => {
    pages.value = [page("architecture")];

    expect(await render()).not.toContain("knowledge-pages-handoff");
  });

  it("turns a requested page's button into a disabled Requested state with its reason", async () => {
    pages.value = [page("architecture", "2030-01-01T00:00:00.000Z"), page("testing")];

    const html = await render();
    const requested = html.match(
      new RegExp(`<button[^>]*disabled[^>]*>(?:(?!</button>).)*${t("knowledge.pageRequested")}`),
    );

    expect(requested?.[0]).toContain(`title="${t("knowledge.pageRequestedReason")}"`);
    expect(html.match(new RegExp(`>${t("knowledge.requestUpdate")}<`, "g"))).toHaveLength(1);
  });
});
