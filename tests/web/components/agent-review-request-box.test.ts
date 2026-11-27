import { createSSRApp, h, reactive, ref } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { renderToString } from "vue/server-renderer";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentReviewPendingProject,
  AgentReviewRequest,
  AgentReviewRequestPage,
  ProjectRecord,
} from "@work-intelligence/core";
import AgentReviewRequestBox from "../../../apps/web/src/components/domain/AgentReviewRequestBox.vue";
import { loadCatalog, locale, t } from "../../../apps/web/src/i18n/index.js";

const latestRequest = ref<AgentReviewRequest | undefined>();
const latestCompletedRequest = ref<AgentReviewRequest | undefined>();
const hasOpenRequest = ref(false);
const pages = ref<Array<{ id: string; projectId: string; slug: string }>>([]);
const openRequests = ref<AgentReviewRequest[]>([]);
const pendingProjects = ref<AgentReviewPendingProject[]>([]);
const pendingLoaded = ref(true);
const openRequestsLoaded = ref(true);
const openRequestsError = ref("");
const pendingError = ref("");
const requestLoaded = ref(true);
const skipped = ref(false);
const requestReview = vi.fn();
const cancelRequest = vi.fn();

vi.mock("../../../apps/web/src/stores/agent-review", () => ({
  useAgentReviewStore: () =>
    reactive({
      latestRequest,
      latestCompletedRequest,
      hasOpenRequest,
      openRequests,
      pendingProjects,
      pendingLoaded,
      openRequestsLoaded,
      openRequestsError,
      pendingError,
      reloadOverview: vi.fn(),
      requestLoaded,
      requestError: ref(""),
      skipped,
    }),
}));
vi.mock("../../../apps/web/src/stores/knowledge-pages", () => ({
  useKnowledgePagesStore: () => reactive({ pages }),
}));
vi.mock("../../../apps/web/src/components/domain/ProjectFilterMenu.vue", () => ({ default: { render: () => null } }));
vi.mock("../../../apps/web/src/composables/useAgentReviewActions", () => ({
  useAgentReviewActions: () => ({ requestReview, cancelRequest }),
}));

const project = { id: "project-1", name: "Orchard", rootPath: "/work/orchard" } as ProjectRecord;
const harbor = { id: "project-2", name: "Harbor", rootPath: "/work/harbor" } as ProjectRecord;

function pending(projectId: string, projectName: string, decisionCount: number): AgentReviewPendingProject {
  return { projectId, projectName, decisionCount, candidateCount: 1, knowledgeCount: 0 };
}

function completed(knowledgePages?: AgentReviewRequestPage[]): AgentReviewRequest {
  return {
    id: "request-1",
    projectId: "project-1",
    status: "completed",
    requestedAt: "2030-01-01T00:00:00.000Z",
    completedAt: "2030-01-01T01:00:00.000Z",
    itemCount: 2,
    omittedCount: 0,
    decisionCount: 2,
    candidateCount: 0,
    knowledgeCount: 0,
    appliedCount: 2,
    skippedCount: 0,
    openCount: 0,
    ...(knowledgePages ? { knowledgePages } : {}),
  };
}

function page(slug: string, state: AgentReviewRequestPage["state"]): AgentReviewRequestPage {
  return { slug, title: `Page ${slug}`, reasons: ["queued_for_update"], state };
}

async function render(projectId = "project-1", projects = [project, harbor]): Promise<string> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/knowledge/:tab?", name: "knowledge", component: { render: () => null } }],
  });
  await router.push("/knowledge");
  const app = createSSRApp({
    render: () => h(AgentReviewRequestBox, { projects, projectId }),
  });
  app.use(router);
  return renderToString(app);
}

beforeAll(async () => {
  await loadCatalog("en-US");
  locale.value = "en-US";
});

beforeEach(() => {
  latestRequest.value = undefined;
  latestCompletedRequest.value = undefined;
  hasOpenRequest.value = false;
  pages.value = [];
  openRequests.value = [];
  pendingProjects.value = [];
  pendingLoaded.value = true;
  openRequestsLoaded.value = true;
  openRequestsError.value = "";
  pendingError.value = "";
  requestLoaded.value = true;
  skipped.value = false;
});

describe("AgentReviewRequestBox Knowledge pages step", () => {
  it("lists each page with its state, the count line and a link into the Knowledge pages tab", async () => {
    latestCompletedRequest.value = completed([
      page("architecture", "updated"),
      page("operations", "pending"),
      page("testing", "checked"),
      page("pitfalls", "unchanged"),
    ]);
    latestRequest.value = latestCompletedRequest.value;
    pages.value = [
      { id: "page-architecture", projectId: "project-1", slug: "architecture" },
      { id: "page-other", projectId: "project-2", slug: "operations" },
    ];

    const html = await render();

    expect(html).toContain('data-testid="agent-review-pages"');
    expect(html).toContain(t("knowledge.agentReviewPagesTitle"));
    expect(html).toContain(t("knowledge.agentReviewPagesProgress", { done: 2, total: 4 }));
    for (const slug of ["architecture", "operations", "testing", "pitfalls"]) expect(html).toContain(`Page ${slug}`);
    for (const state of ["Updated", "Still pending", "Checked", "Unchanged"]) expect(html).toContain(state);
    expect(html.match(/data-testid="agent-review-page"/g)).toHaveLength(4);
    expect(html).toContain("/knowledge/pages?project=project-1&amp;knowledgePage=page-architecture");
    expect(html.match(new RegExp(t("knowledge.agentReviewPageOpen"), "g"))).toHaveLength(1);
  });

  it("says so when a completed request affected no page", async () => {
    latestCompletedRequest.value = completed([]);
    latestRequest.value = latestCompletedRequest.value;

    const html = await render();

    expect(html).toContain(t("knowledge.agentReviewPagesNone"));
    expect(html).not.toContain(t("knowledge.agentReviewPagesProgress", { done: 0, total: 0 }));
  });

  it("shows no step without a completed request or without its pages", async () => {
    latestRequest.value = { ...completed(), status: "pending" };
    expect(await render()).not.toContain("agent-review-pages");

    latestCompletedRequest.value = completed();
    expect(await render()).not.toContain("agent-review-pages");
  });

  it("hides the earlier request's pages while a new request is open", async () => {
    latestCompletedRequest.value = completed([page("architecture", "pending")]);
    latestRequest.value = { ...completed(), id: "request-2", status: "processing" };
    hasOpenRequest.value = true;

    expect(await render()).not.toContain("agent-review-pages");
  });
});

describe("AgentReviewRequestBox handoff", () => {
  it("lists every project with pending items and a button, so no project has to be chosen first", async () => {
    pendingProjects.value = [pending("project-1", "Orchard", 3), pending("project-2", "Harbor", 1)];

    const html = await render("");

    expect(html.match(/data-testid="agent-review-project"/g)).toHaveLength(2);
    expect(html).toContain(t("knowledge.agentReviewAskProjectLabel", { project: "Orchard" }));
    expect(html).toContain(
      t("knowledge.agentReviewPendingCounts", { decisionCount: 3, candidateCount: 1, knowledgeCount: 0 }),
    );
  });

  it("shows the only project with items directly, with its count on the button", async () => {
    pendingProjects.value = [pending("project-2", "Harbor", 1)];

    const html = await render("");

    expect(html).not.toContain("agent-review-project");
    expect(html).toContain(t("knowledge.agentReviewAskProject", { project: "Harbor", count: 2 }));
  });

  it("uses the page's project filter for the button and explains why it is disabled", async () => {
    pendingProjects.value = [pending("project-1", "Orchard", 3)];
    const enabled = await render("project-1");
    expect(enabled).toContain(t("knowledge.agentReviewAskProject", { project: "Orchard", count: 4 }));
    expect(enabled).not.toContain("disabled");

    const nothing = await render("project-2");
    expect(nothing).toContain(t("knowledge.agentReviewNothingInProject", { project: "Harbor" }));
    expect(nothing).toContain("disabled");

    skipped.value = true;
    expect(await render("project-1")).toContain(t("outstanding.trackingIsNotEnabledFor"));
  });

  it("lists no project before the open requests are known, so none flashes that already has one", async () => {
    pendingProjects.value = [pending("project-1", "Orchard", 3), pending("project-2", "Harbor", 1)];
    openRequestsLoaded.value = false;

    const html = await render("");

    expect(html).not.toContain("agent-review-project");
    expect(html).not.toContain(t("knowledge.agentReviewAskProjectLabel", { project: "Orchard" }));
  });

  it("shows the failure with a retry instead of loading forever", async () => {
    pendingLoaded.value = false;
    pendingError.value = "The list is unavailable.";

    const html = await render("");

    expect(html).toContain("The list is unavailable.");
    expect(html).toContain(t("common.retry"));
    expect(html).not.toContain('aria-label="Loading"');
  });

  it("says no other project needs the Agent while a request is open, not that nothing is pending", async () => {
    openRequests.value = [{ ...completed(), id: "request-a", status: "pending", projectName: "Orchard" }];
    pendingProjects.value = [pending("project-1", "Orchard", 3)];

    const html = await render("");

    expect(html).toContain(t("knowledge.agentReviewNothingElse"));
    expect(html).not.toContain(t("knowledge.agentReviewNothingPending"));
  });

  it("lists every open request with the command and a cancel button while no project is chosen", async () => {
    pendingProjects.value = [pending("project-1", "Orchard", 3)];
    openRequests.value = [
      { ...completed(), id: "request-a", status: "pending", projectName: "Orchard" },
      {
        ...completed(),
        id: "request-b",
        projectId: "project-2",
        status: "failed",
        projectName: "Harbor",
        failureReason: "stopped",
      },
    ];

    const html = await render("");

    expect(html.match(/data-testid="agent-review-open-request"/g)).toHaveLength(2);
    expect(html).toContain(t("knowledge.agentReviewCommand"));
    expect(html).toContain(t("knowledge.agentReviewManyOpenMessage"));
    expect(html).toContain(t("knowledge.agentReviewCancelLabel", { project: "Harbor" }));
    expect(html).toContain(t("knowledge.agentReviewFailed", { reason: "stopped" }));
    expect(html).not.toContain(t("knowledge.agentReviewAskProject", { project: "Orchard", count: 4 }));
  });

  it("shows the chosen project's open request with its command and cancel, and no command once it is done", async () => {
    latestRequest.value = { ...completed(), status: "processing" };
    hasOpenRequest.value = true;
    const open = await render("project-1");
    expect(open).toContain(t("knowledge.agentReviewCommand"));
    expect(open).toContain(t("knowledge.agentReviewCancelConfirm"));
    expect(open).toContain(t("knowledge.agentReviewOpenMessage"));

    latestRequest.value = completed();
    hasOpenRequest.value = false;
    const done = await render("project-1");
    expect(done).not.toContain(t("knowledge.agentReviewCommand"));
    expect(done).toContain(t("knowledge.agentReviewDoneMessage"));
  });
});
