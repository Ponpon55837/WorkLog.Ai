import { createSSRApp, h, reactive, ref } from "vue";
import { renderToString } from "vue/server-renderer";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentReviewedKnowledge, ProjectRecord } from "@work-intelligence/core";
import AgentKnowledgeReviewBox from "../../../apps/web/src/components/domain/AgentKnowledgeReviewBox.vue";
import { loadCatalog, locale, t } from "../../../apps/web/src/i18n/index.js";

// Fictional fixtures only.
const reviewedKnowledge = ref<AgentReviewedKnowledge[]>([]);
const reviewedKnowledgeError = ref("");
const overturn = vi.fn();

vi.mock("../../../apps/web/src/stores/agent-review", () => ({
  useAgentReviewStore: () => reactive({ reviewedKnowledge, reviewedKnowledgeError }),
}));
// SSR cannot click, so the verdict stub hands its overturn emitters to the test.
const overturnEmitters = vi.hoisted(() => [] as Array<() => void>);

vi.mock("../../../apps/web/src/components/domain/AgentReviewVerdict.vue", async () => {
  const { defineComponent, h: render } = await import("vue");
  return {
    default: defineComponent({
      props: { verdict: { type: String, default: "" }, reason: { type: String, default: "" } },
      emits: ["overturn"],
      setup(props, { emit }) {
        overturnEmitters.push(() => emit("overturn"));
        return () => render("div", { class: "verdict-stub" }, `${props.verdict}|${props.reason}`);
      },
    }),
  };
});
vi.mock("../../../apps/web/src/composables/useAgentReviewActions", () => ({
  useAgentReviewActions: () => ({ overturn }),
}));

const project = { id: "project-1", name: "Orchard", rootPath: "/work/orchard" } as ProjectRecord;

function reviewed(overrides: Partial<AgentReviewedKnowledge> & { id: string; title: string }): AgentReviewedKnowledge {
  const { id, title, ...rest } = overrides;
  return {
    knowledge: { id, title, kind: "decision", projectId: "project-1", status: "active" },
    verdict: "confirm",
    reason: "Still matches the <b>latest</b> mooring layout.",
    reviewedAt: "2030-01-02T00:00:00.000Z",
    requestId: "review-1",
    ...rest,
  } as unknown as AgentReviewedKnowledge;
}

async function render(projectRoot?: string): Promise<string> {
  return renderToString(
    createSSRApp({ render: () => h(AgentKnowledgeReviewBox, { projects: [project], projectRoot }) }),
  );
}

beforeAll(async () => {
  await loadCatalog("en-US");
  locale.value = "en-US";
});

beforeEach(() => {
  reviewedKnowledge.value = [];
  reviewedKnowledgeError.value = "";
  overturn.mockReset();
  overturnEmitters.length = 0;
});

describe("AgentKnowledgeReviewBox", () => {
  it("stays hidden while the Agent has processed no Knowledge", async () => {
    expect(await render()).not.toContain("agent-knowledge-review");
  });

  it("shows the verdict, the reason as plain text, and the successor of a replaced Knowledge", async () => {
    reviewedKnowledge.value = [
      reviewed({ id: "k1", title: "Pier lights" }),
      reviewed({
        id: "k2",
        title: "Dock schedule",
        verdict: "supersede",
        successor: { id: "k3", title: "Dock schedule 2031", status: "active" },
      }),
    ];
    const html = await render();
    expect(html).toContain("Pier lights");
    expect(html).toContain("confirm|Still matches the &lt;b&gt;latest&lt;/b&gt; mooring layout.");
    expect(html).toContain("supersede|");
    expect(html).toContain(t("knowledge.replacedBy", { title: "Dock schedule 2031" }));
  });

  it("overturns the Knowledge with its verdict, resolving the project root from the project list", async () => {
    reviewedKnowledge.value = [reviewed({ id: "k1", title: "Pier lights", verdict: "archive" })];
    await render();
    overturnEmitters[0]?.();
    expect(overturn).toHaveBeenCalledWith("knowledge", "k1", "/work/orchard", "archive");

    overturn.mockClear();
    overturnEmitters.length = 0;
    await render("/work/selected");
    overturnEmitters[0]?.();
    expect(overturn).toHaveBeenCalledWith("knowledge", "k1", "/work/selected", "archive");
  });

  it("shows a load error even without items", async () => {
    reviewedKnowledgeError.value = "Could not load it.";
    expect(await render()).toContain("Could not load it.");
  });
});
