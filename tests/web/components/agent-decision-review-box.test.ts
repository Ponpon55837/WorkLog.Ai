import { createSSRApp, h, reactive, ref } from "vue";
import { renderToString } from "vue/server-renderer";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectRecord, SessionDecisionRecord } from "@work-intelligence/core";
import AgentDecisionReviewBox from "../../../apps/web/src/components/domain/AgentDecisionReviewBox.vue";
import { loadCatalog, locale, t } from "../../../apps/web/src/i18n/index.js";

const decisions = ref<SessionDecisionRecord[]>([]);
const decisionsLoaded = ref(true);
const filter = ref("pending");

vi.mock("../../../apps/web/src/stores/session-decisions", () => ({
  useSessionDecisionsStore: () =>
    reactive({
      decisions,
      pendingCount: 2,
      decisionsLoading: false,
      decisionsLoaded,
      decisionsError: "",
    }),
}));
vi.mock("../../../apps/web/src/stores/agent-review", () => ({ useAgentReviewStore: () => reactive({ filter }) }));
vi.mock("../../../apps/web/src/stores/projects", () => ({
  useProjectsStore: () => ({
    projects: [{ id: "project-1", name: "Orchard", rootPath: "/work/orchard" }] as ProjectRecord[],
  }),
}));
vi.mock("../../../apps/web/src/stores/sessions", () => ({ useSessionsStore: () => ({ openSessionDetail: vi.fn() }) }));
vi.mock("../../../apps/web/src/composables/useToast", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../../apps/web/src/composables/useKnowledge", () => ({
  useKnowledgeActions: () => ({ openAgentDecisionEditor: vi.fn() }),
}));
vi.mock("../../../apps/web/src/composables/useAgentReviewActions", () => ({
  useAgentReviewActions: () => ({ overturn: vi.fn() }),
}));
vi.mock("../../../apps/web/src/components/domain/AgentReviewFilter.vue", () => ({ default: { render: () => null } }));
vi.mock("../../../apps/web/src/components/domain/AgentReviewVerdict.vue", () => ({ default: { render: () => null } }));
// SSR has no layout to measure, so the virtual list renders every row.
vi.mock("../../../apps/web/src/components/VirtualList.vue", async () => {
  const { defineComponent, h: render } = await import("vue");
  return {
    default: defineComponent({
      props: { items: { type: Array, default: () => [] } },
      setup(props, { slots }) {
        return () =>
          render(
            "div",
            props.items.map((item) => slots.default?.({ item })),
          );
      },
    }),
  };
});

function decision(id: string, text: string): SessionDecisionRecord {
  return {
    id,
    sessionId: "session-1",
    projectId: "project-1",
    position: 0,
    text,
    origin: "agent_autonomous",
    reviewStatus: "pending",
  };
}

async function render(): Promise<string> {
  return renderToString(createSSRApp({ render: () => h(AgentDecisionReviewBox, {}) }));
}

function buttonsOf(html: string): Array<{ label: string; classes: string }> {
  return [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/g)].map(([, attributes, inner]) => ({
    label: inner!.replace(/<[^>]+>/g, "").trim(),
    classes: attributes!.match(/class="([^"]*)"/)?.[1] ?? "",
  }));
}

beforeAll(async () => {
  await loadCatalog("en-US");
  locale.value = "en-US";
});

beforeEach(() => {
  decisions.value = [decision("d1", "Use the registry"), decision("d2", "Keep SQLite")];
  decisionsLoaded.value = true;
  filter.value = "pending";
});

describe("AgentDecisionReviewBox", () => {
  it("makes Confirm the only primary row action and Reject a default button", async () => {
    const row = (await render()).split('data-testid="agent-decision-item"')[1]!;
    const buttons = buttonsOf(row);

    const confirm = buttons.find((button) => button.label === t("common.confirm"));
    const reject = buttons.find((button) => button.label === t("knowledge.reject"));
    expect(confirm?.classes).toContain("primary");
    expect(reject?.classes).not.toContain("primary");
    expect(buttons.filter((button) => button.classes.includes("primary"))).toHaveLength(1);
  });

  it("moves Turn into Knowledge behind a More menu", async () => {
    const html = await render();

    expect(html).not.toContain(t("knowledge.turnIntoKnowledge"));
    expect(buttonsOf(html).filter((button) => button.label === t("knowledge.more"))).toHaveLength(2);
  });

  it("offers a checkbox per decision and hides the batch toolbar until something is selected", async () => {
    const html = await render();

    expect(html).toContain(t("knowledge.selectDecision", { text: "Use the registry" }));
    expect(html).toContain(t("knowledge.selectAllDecisionsInList"));
    expect(html).toContain(t("knowledge.selectList"));
    expect(html).not.toContain("decision-batch-toolbar");
    expect(html).not.toContain(t("knowledge.confirmSelected"));
  });

  it("has no selection or review actions on the Agent-processed list", async () => {
    filter.value = "agent";

    const html = await render();

    expect(html).not.toContain(t("knowledge.selectAllDecisionsInList"));
    expect(html).not.toContain(t("common.confirm"));
  });
});
