import { createSSRApp, h } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { renderToString } from "vue/server-renderer";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { OutstandingItem, OutstandingItemStatus } from "@work-intelligence/core";
import OutstandingItemsBox from "../../../apps/web/src/components/domain/OutstandingItemsBox.vue";
import { loadCatalog, locale, t } from "../../../apps/web/src/i18n/index.js";

vi.mock("../../../apps/web/src/stores/outstanding-items", () => ({
  useOutstandingItemsStore: () => ({
    updateStatus: vi.fn(),
    batchUpdateStatusInChunks: vi.fn(),
    listAllPendingIds: vi.fn(),
  }),
}));
vi.mock("../../../apps/web/src/composables/useToast", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../../apps/web/src/composables/useProjectChip", () => ({ useProjectChip: () => ({ value: undefined }) }));
vi.mock("../../../apps/web/src/components/domain/ProjectFilterMenu.vue", () => ({ default: { render: () => null } }));
vi.mock("../../../apps/web/src/components/domain/OutstandingCleanupPanel.vue", () => ({
  default: { render: () => null },
}));

const pageInfo = {
  page: 1,
  pageSize: 10,
  total: 50,
  totalPages: 5,
  from: 1,
  to: 2,
  hasPrevious: false,
  hasNext: true,
  truncated: false,
};

function item(id: string, status: OutstandingItemStatus, overrides: Partial<OutstandingItem> = {}): OutstandingItem {
  return {
    id,
    sourceSessionId: "session-1",
    projectId: "project-1",
    projectName: "Orchard",
    sourceSessionTitle: "Harvest planning",
    sourceSessionCompletedAt: "2030-01-01T00:00:00.000Z",
    position: 0,
    text: `Follow up ${id}`,
    status,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
    ...overrides,
  };
}

async function render(
  items: OutstandingItem[],
  status: OutstandingItemStatus = "pending",
  loaded = true,
): Promise<string> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: { render: () => null } }],
  });
  await router.push("/");
  const app = createSSRApp({
    render: () =>
      h(OutstandingItemsBox, {
        items,
        pageInfo,
        loading: false,
        loaded,
        error: "",
        projectId: "",
        status,
        page: 1,
        pageSize: 10,
        from: "",
        to: "",
        closedFilter: "all",
      }),
  });
  app.use(router);
  return renderToString(app);
}

beforeAll(async () => {
  await loadCatalog("en-US");
  locale.value = "en-US";
});

describe("OutstandingItemsBox", () => {
  it("renders a pending row as content and meta with icon actions, without a status label", async () => {
    const html = await render([item("a", "pending")]);

    expect(html).toContain("Follow up a");
    expect(html).toContain("Orchard");
    expect(html).toContain(t("outstanding.openSourceSession", { sourceSessionTitle: "Harvest planning" }));
    expect(html).toContain(`title="${t("outstanding.markDoneAction")}"`);
    expect(html).toContain(`title="${t("outstanding.markNotNeededAction")}"`);
    expect(html).not.toContain(`>${t("common.pending")}<`);
  });

  it("shows the status label and a reopen action only when the filter is not pending", async () => {
    const html = await render([item("b", "completed", { closedBy: "later_session" })], "completed");

    expect(html).toContain(`>${t("common.completedStatus")}<`);
    expect(html).toContain(t("outstanding.closedByLaterSession"));
    expect(html).toContain(`title="${t("outstanding.reopen")}"`);
    expect(html).not.toContain(t("outstanding.markDoneAction"));
    expect(html).not.toContain(t("outstanding.selectAllOpenItemsOn"));
  });

  it("keeps the batch toolbar out of the page until something is selected", async () => {
    const html = await render([item("a", "pending"), item("c", "pending")]);

    expect(html).toContain(t("outstanding.selectAllOpenItemsOn"));
    expect(html).toContain(t("outstanding.selectPage"));
    expect(html).not.toContain("outstanding-batch-toolbar");
    expect(html).not.toContain(t("outstanding.selectedCount", { count: 0 }));
  });

  it("hides the count until the first answer arrives", async () => {
    expect(await render([], "pending", false)).not.toContain("ui-box-title__count");
    expect(await render([item("a", "pending")])).toMatch(/ui-box-title__count[^>]*>50</);
  });
});
