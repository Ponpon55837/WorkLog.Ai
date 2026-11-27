import { createSSRApp, h, ref } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { renderToString } from "vue/server-renderer";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutstandingCleanupProposal, OutstandingCleanupRequest } from "@work-intelligence/core";
import OutstandingCleanupPanel from "../../../apps/web/src/components/domain/OutstandingCleanupPanel.vue";
import { loadCatalog, locale, t } from "../../../apps/web/src/i18n/index.js";

const proposals = ref<OutstandingCleanupProposal[]>([]);
const activeRequest = ref<OutstandingCleanupRequest | undefined>();
const skipped = ref(false);
const projectId = ref("project-1");
const pendingProjects = ref<Array<{ projectId: string; projectName: string; pendingCount: number }>>([]);
const pendingProjectsLoaded = ref(true);
const pendingProjectsError = ref("");
const chooseProject = vi.fn();
const request: OutstandingCleanupRequest = {
  id: "cleanup-1",
  projectId: "project-1",
  projectName: "Orchard",
  status: "completed",
  requestedAt: "2030-01-01T00:00:00.000Z",
  itemCount: 3,
  examinedCount: 3,
  proposalCount: 3,
};
const pageInfo = {
  page: 1,
  pageSize: 10,
  total: 3,
  totalPages: 1,
  from: 1,
  to: 3,
  hasPrevious: false,
  hasNext: false,
  truncated: false,
};

vi.mock("../../../apps/web/src/stores/outstanding-cleanup", () => ({
  useOutstandingCleanupStore: () => ({
    projectId,
    pendingProjects,
    pendingProjectsLoaded,
    pendingProjectsError,
    chooseProject,
    reloadPendingProjects: vi.fn(),
    requestId: ref("cleanup-1"),
    requestPage: ref(1),
    requestPageSize: ref(10),
    proposalPage: ref(1),
    proposalPageSize: ref(10),
    requestsLoaded: ref(true),
    requests: ref([request]),
    requestPageInfo: ref(pageInfo),
    proposals,
    proposalPageInfo: ref(pageInfo),
    selectedRequest: ref(request),
    activeRequest,
    loading: ref(false),
    proposalsLoading: ref(false),
    error: ref(""),
    proposalError: ref(""),
    skipped,
    setActive: vi.fn(),
    reopen: vi.fn(),
  }),
}));

vi.mock("../../../apps/web/src/stores/projects", () => ({
  useProjectsStore: () => ({ projects: ref([{ id: "project-1", name: "Orchard" }]) }),
}));
vi.mock("../../../apps/web/src/components/ui/UiSidePanel.vue", () => ({
  default: {
    setup:
      (_props: object, { slots }: { slots: { default?: () => never } }) =>
      () =>
        h("div", slots.default?.()),
  },
}));
vi.mock("../../../apps/web/src/composables/useToast", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../../apps/web/src/composables/useRouteQuery", () => ({
  stringQuery: () => undefined,
  pageQuery: () => undefined,
  enumQuery: () => undefined,
  useRouteQuery: (key: string, target: { value: string }) => {
    if (key === "cleanup") target.value = "review";
  },
}));

function proposal(overrides: Partial<OutstandingCleanupProposal>): OutstandingCleanupProposal {
  return {
    id: "proposal-1",
    requestId: "cleanup-1",
    projectId: "project-1",
    itemId: "item-1",
    itemText: "Check the backup job",
    sourceSessionId: "session-source",
    status: "completed",
    kind: "resolution",
    itemStatus: "completed",
    reason: "A later Session verified the job.",
    evidenceSessionIds: ["session-evidence"],
    reviewStatus: "accepted",
    createdAt: "2030-01-02T00:00:00.000Z",
    ...overrides,
  } as OutstandingCleanupProposal;
}

async function render(): Promise<string> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/work/:tab?", component: { render: () => null } }],
  });
  await router.push("/work?cleanup=review&itemProject=project-1");
  const app = createSSRApp({ render: () => h(OutstandingCleanupPanel) });
  app.use(router);
  return renderToString(app);
}

beforeAll(async () => {
  await loadCatalog("en-US");
  locale.value = "en-US";
});

beforeEach(() => {
  proposals.value = [];
  activeRequest.value = undefined;
  skipped.value = false;
  projectId.value = "project-1";
  pendingProjects.value = [];
  pendingProjectsLoaded.value = true;
  pendingProjectsError.value = "";
  chooseProject.mockClear();
});

describe("OutstandingCleanupPanel", () => {
  it("lists Agent verdicts with reason, evidence, kind and reopen controls, and no accept or reject step", async () => {
    proposals.value = [
      proposal({}),
      proposal({
        id: "proposal-2",
        itemId: "item-2",
        itemText: "Windows packaging",
        status: "not_needed",
        kind: "acknowledged",
        itemStatus: "not_needed",
        reason: "Known limitation.",
        evidenceSessionIds: [],
      }),
      proposal({ id: "proposal-3", itemId: "item-3", itemText: "Reopened item", itemStatus: "pending" }),
    ];

    const html = await render();

    expect(html).toContain(t("outstanding.closedByAgent"));
    expect(html).toContain("A later Session verified the job.");
    expect(html).toContain("Known limitation.");
    expect(html).toContain(t("status.acknowledgedLimitation"));
    expect(html).toContain(t("outstanding.reopenSelected"));
    expect(html.match(new RegExp(`>${t("outstanding.reopen")}<`, "g"))).toHaveLength(2);
    expect(html.match(new RegExp(t("outstanding.evidence", { value: 1 }), "g"))).toHaveLength(2);
    expect(html).not.toContain("Accept selected");
    expect(html).not.toContain("Reject selected");
  });

  it("shows the empty state while no verdict has been applied", async () => {
    const html = await render();

    expect(html).toContain(t("outstanding.noClosedItemsYet"));
    expect(html).not.toContain(t("outstanding.reopenSelected"));
  });

  it("offers the create button first and the handoff block only while a request waits for the Agent", async () => {
    const idle = await render();
    expect(idle).toContain(t("outstanding.createRequest"));
    expect(idle).not.toContain(t("outstanding.cleanupCommand"));

    activeRequest.value = { ...request, status: "pending" };
    const waiting = await render();
    expect(waiting).toContain(t("outstanding.cleanupCommand").replace("'", "&#39;"));
    expect(waiting).toContain(t("outstanding.cleanupHandoffMessage"));
    expect(waiting).toContain(t("outstanding.cancelRequest"));
    expect(waiting).not.toContain(t("outstanding.createRequest"));
  });

  it("names why the create button is disabled", async () => {
    skipped.value = true;

    const html = await render();

    expect(html).toContain(`title="${t("outstanding.trackingIsNotEnabledFor")}"`);
  });

  it("opens without a project and lists each project with its pending count", async () => {
    projectId.value = "";
    pendingProjects.value = [
      { projectId: "project-1", projectName: "Orchard", pendingCount: 4 },
      { projectId: "project-2", projectName: "Barn", pendingCount: 1 },
    ];

    const html = await render();

    expect(html).toContain(t("outstanding.cleanupChooseProject"));
    expect(html.match(/data-testid="outstanding-cleanup-project"/g)).toHaveLength(2);
    expect(html).toContain("Orchard");
    expect(html).toContain(t("outstanding.cleanupPendingCount", { count: 4 }));
    expect(html).toContain(t("outstanding.cleanupChooseLabel", { project: "Barn" }));
    expect(html).not.toContain(t("outstanding.createRequest"));
  });

  it("shows the only project with pending items directly", async () => {
    projectId.value = "";
    pendingProjects.value = [{ projectId: "project-1", projectName: "Orchard", pendingCount: 3 }];

    const html = await render();

    expect(html).toContain(t("outstanding.cleanupOnlyProject", { project: "Orchard", count: 3 }));
    expect(html).not.toContain(`data-testid="outstanding-cleanup-project"`);
  });

  it("says so when no project has pending items, and waits for the counts before saying it", async () => {
    projectId.value = "";
    expect(await render()).toContain(t("outstanding.cleanupNothingPending"));

    pendingProjectsLoaded.value = false;
    const loading = await render();
    expect(loading).not.toContain(t("outstanding.cleanupNothingPending"));
    expect(loading).toContain(t("common.loading"));
  });

  it("names the chosen project and offers to choose another", async () => {
    const html = await render();

    expect(html).toContain("Orchard");
    expect(html).toContain(t("outstanding.cleanupChangeProject"));
    expect(html).not.toContain("outstanding-cleanup-projects");
  });
});
