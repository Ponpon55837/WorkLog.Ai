import { createSSRApp, h, reactive, ref } from "vue";
import { renderToString } from "vue/server-renderer";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  KnowledgeCandidate,
  KnowledgeCandidateBacklog,
  KnowledgeCandidateRequest,
  ProjectRecord,
} from "@work-intelligence/core";
import KnowledgeCandidatesBox from "../../../apps/web/src/components/domain/KnowledgeCandidatesBox.vue";
import { loadCatalog, locale, t } from "../../../apps/web/src/i18n/index.js";

const candidates = ref<KnowledgeCandidate[]>([]);
const openCandidateRequests = ref<KnowledgeCandidateRequest[]>([]);
const candidateBacklog = ref<KnowledgeCandidateBacklog[]>([]);
const candidatesLoaded = ref(true);
const filter = ref("all");
const candidateRequesting = ref(false);

vi.mock("../../../apps/web/src/stores/knowledge", () => ({
  useKnowledgeStore: () => reactive({ candidatesLoaded, candidateBacklog }),
}));
vi.mock("../../../apps/web/src/stores/agent-review", () => ({
  useAgentReviewStore: () =>
    reactive({
      filter,
      reviewedCandidates: [],
      reviewedCandidatesLoaded: true,
      reviewedCandidatesError: "",
    }),
}));
vi.mock("../../../apps/web/src/stores/sessions", () => ({
  useSessionsStore: () => ({ openSessionDetail: vi.fn() }),
}));
vi.mock("../../../apps/web/src/composables/useToast", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../../apps/web/src/composables/useKnowledgeCandidates", () => ({
  useKnowledgeCandidates: () => ({
    candidates,
    openCandidateRequests,
    candidatesError: ref(""),
    candidateRequesting,
    refreshCandidates: vi.fn(),
    requestCandidates: vi.fn(),
    cancelCandidateRequest: vi.fn(),
    wasStoppedByUser: vi.fn(() => false),
    acceptCandidate: vi.fn(),
    rejectCandidate: vi.fn(),
    openCandidateEditor: vi.fn(),
  }),
}));
vi.mock("../../../apps/web/src/composables/useActiveRequestWatch", () => ({ useActiveRequestWatch: vi.fn() }));
vi.mock("../../../apps/web/src/composables/useAgentReviewActions", () => ({
  useAgentReviewActions: () => ({ overturn: vi.fn() }),
}));
vi.mock("../../../apps/web/src/components/ui/UiActionMenu.vue", () => ({
  default: {
    props: ["label", "header", "items"],
    setup(props: { header?: string; items?: unknown[] }) {
      return () =>
        h("div", {
          "data-testid": "organize-menu",
          "data-header": props.header,
          "data-items": JSON.stringify(props.items),
        });
    },
  },
}));

const projects = [
  { id: "orchard", name: "Orchard", rootPath: "/work/orchard" },
  { id: "harbor", name: "Harbor", rootPath: "/work/harbor" },
] as ProjectRecord[];

function openRequest(projectId: string, status: "pending" | "failed", sessions: number): KnowledgeCandidateRequest {
  return {
    id: `request-${projectId}`,
    projectId,
    projectName: projects.find((project) => project.id === projectId)!.name,
    status,
    requestedAt: "2030-01-01T00:00:00.000Z",
    sourceSessionIds: Array.from({ length: sessions }, (_, index) => `session-${index}`),
    candidateCount: 0,
  };
}

function menuItems(html: string): Array<Record<string, unknown>> {
  const raw = /data-items="([^"]*)"/.exec(html)?.[1] ?? "[]";
  return JSON.parse(raw.replaceAll("&quot;", '"')) as Array<Record<string, unknown>>;
}

async function render(): Promise<string> {
  return renderToString(createSSRApp({ render: () => h(KnowledgeCandidatesBox, { projects }) }));
}

beforeAll(async () => {
  await loadCatalog("en-US");
  locale.value = "en-US";
});

beforeEach(() => {
  candidates.value = [];
  openCandidateRequests.value = [];
  candidateBacklog.value = [];
  candidatesLoaded.value = true;
  filter.value = "all";
  candidateRequesting.value = false;
});

describe("KnowledgeCandidatesBox backlog", () => {
  it("shows one row per project with high-value Sessions and an organize button each", async () => {
    candidateBacklog.value = [
      { projectId: "orchard", uncoveredSessions: 40, highValueSessions: 12 },
      { projectId: "harbor", uncoveredSessions: 3, highValueSessions: 1 },
    ];
    const html = await render();
    expect(html).toContain(t("knowledge.candidateBacklogTitle"));
    expect(html).toContain(t("knowledge.candidateBacklogHint"));
    expect(html).toContain(t("knowledge.candidateBacklogExplainer"));
    expect(html.match(/data-testid="knowledge-candidates-backlog-row"/g)).toHaveLength(2);
    expect(html).toContain("Orchard");
    expect(html).toContain(t("knowledge.candidateBacklogCount", { n: 12 }));
    expect(html).toContain(t("knowledge.candidateBacklogCount", { n: 1 }));
    expect(html).not.toContain("40");
    expect(html).toContain(t("knowledge.organizeProjectLabel", { project: "Harbor" }));
  });

  it("replaces the button with the waiting count when the project has an open request", async () => {
    candidateBacklog.value = [{ projectId: "orchard", uncoveredSessions: 15, highValueSessions: 5 }];
    openCandidateRequests.value = [openRequest("orchard", "pending", 10)];
    const html = await render();
    expect(html).toContain(t("knowledge.candidateBacklogOpen", { project: "Orchard", length: 10, n: 5 }));
    expect(html).not.toContain(t("knowledge.organizeProjectLabel", { project: "Orchard" }));
    expect(html).toContain(t("knowledge.candidateRequestCommand"));
    expect(html).toContain(t("knowledge.candidateRequestMessage"));
  });

  it("keeps the request notice of a project that has no row", async () => {
    openCandidateRequests.value = [openRequest("harbor", "failed", 4)];
    const html = await render();
    expect(html).toContain("Harbor");
    expect(html).toContain(t("knowledge.candidateRequestWaiting", { project: "Harbor", length: 4 }));
    expect(html).toContain(t("knowledge.interruptedLastTimeCanBe"));
    expect(html).toContain(t("knowledge.candidateRequestCommand"));
    expect(html).toContain(t("knowledge.candidateRequestStopLabel", { project: "Harbor" }));
    expect(html).not.toContain("knowledge-candidates-backlog");
  });

  it("shows nothing when no project has high-value Sessions or while loading", async () => {
    expect(await render()).not.toContain("knowledge-candidates-backlog");
    candidateBacklog.value = [{ projectId: "orchard", uncoveredSessions: 3, highValueSessions: 1 }];
    candidatesLoaded.value = false;
    expect(await render()).not.toContain("knowledge-candidates-backlog");
  });

  it("disables the row buttons while a request is in flight", async () => {
    candidateBacklog.value = [{ projectId: "orchard", uncoveredSessions: 3, highValueSessions: 1 }];
    const label = t("knowledge.organizeProjectLabel", { project: "Orchard" });
    const idle = await render();
    expect(idle).not.toMatch(new RegExp(`disabled[^>]*aria-label="${label}"|aria-label="${label}"[^>]*disabled`));
    candidateRequesting.value = true;
    const busy = await render();
    expect(busy).toMatch(new RegExp(`disabled[^>]*aria-label="${label}"|aria-label="${label}"[^>]*disabled`));
  });

  it("titles the organize menu and shows the Session count of each project that has a backlog", async () => {
    candidateBacklog.value = [
      { projectId: "orchard", uncoveredSessions: 40, highValueSessions: 12 },
      { projectId: "harbor", uncoveredSessions: 3, highValueSessions: 1 },
    ];
    openCandidateRequests.value = [openRequest("harbor", "pending", 1)];

    const html = await render();

    expect(html).toContain(`data-header="${t("knowledge.chooseAProjectToSynthesize")}"`);
    expect(menuItems(html)).toEqual([
      { value: "orchard", label: "Orchard", count: t("knowledge.candidateBacklogCount", { n: 12 }) },
      {
        value: "harbor",
        label: "Harbor",
        count: t("knowledge.candidateBacklogCount", { n: 1 }),
        disabled: true,
        description: t("knowledge.candidateMenuOpen"),
      },
    ]);
  });

  it("keeps a project without a backlog selectable, because a manual request still organizes its other Sessions", async () => {
    candidateBacklog.value = [{ projectId: "orchard", uncoveredSessions: 40, highValueSessions: 12 }];

    expect(menuItems(await render())[1]).toEqual({ value: "harbor", label: "Harbor" });
  });
});
