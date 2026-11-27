import { createSSRApp, h, reactive, ref } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { renderToString } from "vue/server-renderer";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentReviewRequest, AgentReviewRequestPage, ProjectRecord } from "@work-intelligence/core";
import AgentReviewRequestBox from "../../../apps/web/src/components/domain/AgentReviewRequestBox.vue";
import { loadCatalog, locale, t } from "../../../apps/web/src/i18n/index.js";

// Fictional fixtures only.
const latestRequest = ref<AgentReviewRequest | undefined>();
const latestCompletedRequest = ref<AgentReviewRequest | undefined>();
const pages = ref<Array<{ id: string; projectId: string; slug: string }>>([]);

vi.mock("../../../apps/web/src/stores/agent-review", () => ({
  useAgentReviewStore: () =>
    reactive({
      latestRequest,
      latestCompletedRequest,
      hasOpenRequest: ref(false),
      requestLoaded: ref(true),
      requestError: ref(""),
      skipped: ref(false),
    }),
}));
vi.mock("../../../apps/web/src/stores/knowledge-pages", () => ({
  useKnowledgePagesStore: () => reactive({ pages }),
}));
vi.mock("../../../apps/web/src/composables/useAgentReviewActions", () => ({
  useAgentReviewActions: () => ({ requestReview: vi.fn(), cancelRequest: vi.fn() }),
}));

const project = { id: "project-1", name: "Orchard", rootPath: "/work/orchard" } as ProjectRecord;

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

async function render(): Promise<string> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/knowledge/:tab?", name: "knowledge", component: { render: () => null } }],
  });
  await router.push("/knowledge");
  const app = createSSRApp({
    render: () => h(AgentReviewRequestBox, { projects: [project], projectId: "project-1" }),
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
  pages.value = [];
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
});
