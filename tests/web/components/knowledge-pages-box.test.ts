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

function page(slug: string, updateRequestedAt?: string, projectId = "project-1"): KnowledgePageRecord {
  return {
    id: `page-${projectId}-${slug}`,
    projectId,
    slug,
    title: `Page ${slug}`,
    question: `What is ${slug}?`,
    status: "fresh",
    version: 1,
    newSessionCount: 0,
    ...(updateRequestedAt ? { updateRequestedAt } : {}),
  } as KnowledgePageRecord;
}

function render(projects = [project], projectId = "project-1"): Promise<string> {
  return renderToString(createSSRApp({ render: () => h(KnowledgePagesBox, { projects, projectId }) }));
}

function customButton(html: string): string {
  return html.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${t("knowledge.customKnowledgePage")}`))?.[0] ?? "";
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

  it("keeps the custom page button clickable without a project filter", async () => {
    const other = { ...project, id: "project-2", name: "Harbor" } as ProjectRecord;

    expect(customButton(await render([project], ""))).not.toContain("disabled");
    expect(customButton(await render([project, other], ""))).not.toContain("disabled");
  });

  it("disables the custom page button only when no project is tracked", async () => {
    const button = customButton(await render([], ""));

    expect(button).toContain("disabled");
    expect(button).toContain(`title="${t("projects.noTrackedProjects")}"`);
  });

  it("groups same-named pages under one label per project when no project is filtered", async () => {
    const other = { ...project, id: "project-2", name: "Harbor" } as ProjectRecord;
    pages.value = [page("testing", undefined, "project-1"), page("testing", undefined, "project-2")];

    const html = await render([project, other], "");

    expect(html.indexOf("Harbor")).toBeGreaterThan(-1);
    expect(html.indexOf("Harbor")).toBeLessThan(html.indexOf("Orchard"));
    expect(html.match(/class="ui-group-label"/g)).toHaveLength(2);
    expect(html).toContain(t("knowledge.pageCount", { count: 1 }));
    expect(html.match(/data-testid="knowledge-page-row"/g)).toHaveLength(2);
  });

  it("shows no group label for a single project's pages", async () => {
    pages.value = [page("testing")];

    expect(await render([project], "")).not.toContain('class="ui-group-label"');
  });

  it("tells projects with the same name apart by their folder", async () => {
    const other = { ...project, id: "project-2", rootPath: "/other/orchard" } as ProjectRecord;
    pages.value = [page("testing", undefined, "project-1"), page("testing", undefined, "project-2")];

    const html = await render([project, other], "");

    expect(html).toContain("Orchard · work/orchard");
    expect(html).toContain("Orchard · other/orchard");
  });

  it("shows no project groups once a project is filtered", async () => {
    pages.value = [page("testing")];

    expect(await render()).not.toContain("ui-group-label");
  });

  it("makes the title of a written page open it and leaves an unwritten page's title plain", async () => {
    pages.value = [
      { ...page("written"), version: 1 },
      { ...page("blank"), version: 0 },
    ];

    const html = await render();

    expect(html).toContain('class="ui-box-row__link"');
    expect(html.match(/class="ui-box-row__link"/g)).toHaveLength(1);
  });

  it("separates meta details with a styled separator instead of text dots", async () => {
    pages.value = [{ ...page("written"), sourcedThrough: "2030-01-01T00:00:00.000Z" } as KnowledgePageRecord];

    const html = await render();

    expect(html).toContain("knowledge-pages__meta-item");
    expect(html).not.toContain("·");
  });
});
