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

describe("KnowledgeRow collapsed layout", () => {
  it("hides tags, references and applies-to paths until the row is expanded", async () => {
    const html = await render({
      item: item({ tags: ["jars"], references: ["docs/pantry.md"], appliesTo: ["src/pantry/**"] }),
    });

    expect(html).not.toContain("#jars");
    expect(html).not.toContain("docs/pantry.md");
    expect(html).not.toContain("src/pantry/**");
  });

  it("offers a collapsed details toggle when tags or paths exist", async () => {
    const html = await render({ item: item({ tags: ["jars"] }) });

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(t("knowledge.showDetails"));
  });

  it("always offers the toggle for a short body, since the clamp depends on the width", async () => {
    const html = await render({ item: item({ body: "短摘要" }) });

    expect(html).toContain('aria-expanded="false"');
  });

  it("points the toggle at one element that wraps the body and everything it reveals", async () => {
    const html = await render({ item: item() });
    const id = html.match(/aria-controls="([^"]+)"/)?.[1];

    expect(id).toBeTruthy();
    expect(html).toContain(`id="${id}"`);
  });

  it("keeps the broad-change note visible while collapsed", async () => {
    const html = await render({ item: item({ broadChangesSince: 3 }) });

    expect(html).toContain(t("knowledge.broadChangesSince", { count: 3 }));
  });

  it("keeps the title, kind and summary in the collapsed row", async () => {
    const html = await render({ item: item() });

    expect(html).toContain("Pack saffron in glass");
    expect(html).toContain("Always pack saffron in glass jars.");
    expect(html).toContain("knowledge-row__body");
  });
});
