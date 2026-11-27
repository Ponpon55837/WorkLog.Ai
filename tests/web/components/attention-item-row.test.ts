import { createSSRApp, defineComponent, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionItem } from "../../../packages/core/src/index.js";
import AttentionItemRow from "../../../apps/web/src/components/domain/AttentionItemRow.vue";
import { useProjectsStore } from "../../../apps/web/src/stores/projects.js";
import { createStoreHarness } from "../helpers/store-harness.js";
import { loadCatalog, locale, t } from "../../../apps/web/src/i18n/index.js";

const RouterLinkStub = defineComponent({
  props: { to: { type: Object, required: true } },
  setup:
    (props, { slots }) =>
    () =>
      h("a", { "data-to": JSON.stringify(props.to) }, slots.default?.()),
});

let harness: ReturnType<typeof createStoreHarness>;

const decision: AttentionItem = {
  id: "decision:d1",
  kind: "decision",
  sourceId: "d1",
  projectId: "p1",
  projectName: "Orchard",
  title: "Use one queue for retries",
  reason: "pending",
  count: 1,
  updatedAt: "2026-11-01T00:00:00Z",
  sourceRevision: "revision",
  preference: { revision: 0, state: "visible" },
  target: { kind: "decision", sourceId: "d1", projectId: "p1" },
};

type RowProps = InstanceType<typeof AttentionItemRow>["$props"];

async function render(props: Partial<RowProps>): Promise<string> {
  const base: RowProps = { item: decision, view: "visible", waiting: false, saving: false, reviewing: false };
  const app = createSSRApp({ render: () => h(AttentionItemRow, { ...base, ...props }) });
  app.component("RouterLink", RouterLinkStub);
  return renderToString(app);
}

beforeAll(async () => {
  await loadCatalog("en-US");
  locale.value = "en-US";
});

beforeEach(async () => {
  harness = createStoreHarness(() => []);
  useProjectsStore();
});

afterEach(async () => {
  await harness.cleanup();
  vi.restoreAllMocks();
});

describe("AttentionItemRow", () => {
  it("offers Confirm and Reject for a pending decision", async () => {
    const html = await render({});
    expect(html).toContain(t("common.confirm"));
    expect(html).toContain(t("knowledge.reject"));
    expect(html).toContain(t("attention.reasons.pending"));
    expect(html).toContain("&quot;decision&quot;:&quot;d1&quot;");
  });

  it("shows Waiting for Agent instead of Pending for a decision inside an Agent request", async () => {
    const html = await render({ waiting: true });
    expect(html).toContain(t("attention.waitingForAgent"));
    expect(html).not.toContain(`>${t("attention.reasons.pending")}<`);
  });

  it("leaves out the decision actions in the suppressed view and for other kinds", async () => {
    expect(await render({ view: "suppressed" })).not.toContain(t("knowledge.reject"));
    const knowledge: AttentionItem = {
      ...decision,
      kind: "knowledge" as const,
      reason: "stale" as const,
      target: { ...decision.target, kind: "knowledge" as const },
    };
    expect(await render({ item: knowledge })).not.toContain(t("knowledge.reject"));
  });

  it("counts a project's open items in the reason label", async () => {
    const open: AttentionItem = {
      ...decision,
      kind: "outstanding" as const,
      reason: "open" as const,
      count: 12,
      title: "",
    };
    expect(await render({ item: open })).toContain("12 open items");
  });
});
