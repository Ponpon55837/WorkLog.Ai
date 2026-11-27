import { createSSRApp, defineComponent, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { KnowledgeRecord } from "../../../packages/core/src/index.js";
import type { SelectOption } from "../../../apps/web/src/components/ui/types.js";
import KnowledgeRow from "../../../apps/web/src/components/domain/KnowledgeRow.vue";
import { loadCatalog, locale, t } from "../../../apps/web/src/i18n/index.js";

vi.mock("../../../apps/web/src/components/ui/UiActionMenu.vue", () => ({
  default: defineComponent({
    props: { items: { type: Array, required: true } },
    setup: (props) => () =>
      h(
        "ul",
        (props.items as SelectOption[]).map((item) =>
          h("li", { "data-value": item.value, "data-disabled": String(Boolean(item.disabled)) }, [
            item.label,
            item.description ? ` | ${item.description}` : "",
          ]),
        ),
      ),
  }),
}));

function item(overrides: Partial<KnowledgeRecord> = {}): KnowledgeRecord {
  return {
    id: "k1",
    projectId: "p1",
    idempotencyKey: "key",
    kind: "pattern",
    title: "Pack saffron in glass",
    body: "Always pack saffron in glass jars.",
    tags: [],
    references: [],
    status: "active",
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
    appliesTo: [],
    ...overrides,
  };
}

async function render(props: {
  item: KnowledgeRecord;
  conventionFull?: boolean;
  conventionCount?: number;
}): Promise<string> {
  return renderToString(createSSRApp({ render: () => h(KnowledgeRow, props) }));
}

beforeAll(async () => {
  await loadCatalog("en-US");
  locale.value = "en-US";
});

describe("KnowledgeRow project convention", () => {
  it("offers to mark an active item and shows no badge", async () => {
    const html = await render({ item: item(), conventionCount: 2 });
    expect(html).toContain(`data-value="convention" data-disabled="false">${t("knowledge.conventionSet")}`);
    expect(html).not.toContain("convention-withdrawn");
  });

  it("offers to remove a marked item and shows the badge", async () => {
    const html = await render({ item: item({ conventionConfirmedAt: "2030-01-02T00:00:00.000Z" }) });
    expect(html).toContain(t("knowledge.conventionUnset"));
    expect(html).toContain(t("knowledge.convention"));
  });

  it("disables marking at the limit and says why, but still allows removing", async () => {
    const full = await render({ item: item(), conventionFull: true, conventionCount: 5 });
    expect(full).toContain('data-disabled="true"');
    expect(full).toContain(t("knowledge.conventionLimitHint", { count: 5, limit: 5 }));
    const marked = await render({
      item: item({ conventionConfirmedAt: "2030-01-02T00:00:00.000Z" }),
      conventionFull: true,
      conventionCount: 5,
    });
    expect(marked).toContain(`data-disabled="false">${t("knowledge.conventionUnset")}`);
  });

  it("does not offer marking for archived or needs-review items", async () => {
    expect(await render({ item: item({ status: "archived" }) })).not.toContain('data-value="convention"');
    const doubted = item({ review: { reason: "contradicted", at: "2030-01-03T00:00:00.000Z" } });
    expect(await render({ item: doubted })).not.toContain('data-value="convention"');
  });

  it("explains a withdrawal by an Agent edit with a re-confirm button, and stays quiet after the user unmarked", async () => {
    const withdrawn = await render({
      item: item({ conventionWithdrawal: { at: "2030-01-03T00:00:00.000Z", by: "agent", reason: "agent_edit" } }),
    });
    expect(withdrawn).toContain("convention-withdrawn");
    expect(withdrawn).toContain(t("knowledge.conventionReasonAgentEdit"));
    expect(withdrawn).toContain(t("knowledge.conventionReconfirm"));

    const unmarked = await render({
      item: item({ conventionWithdrawal: { at: "2030-01-03T00:00:00.000Z", by: "user", reason: "unmarked" } }),
    });
    expect(unmarked).not.toContain("convention-withdrawn");
  });
});
