import { createSSRApp, defineComponent, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SelectOption } from "../../../apps/web/src/components/ui/types.js";
import ProjectFilterMenu from "../../../apps/web/src/components/domain/ProjectFilterMenu.vue";
import { useProjectsStore } from "../../../apps/web/src/stores/projects.js";
import { createStoreHarness } from "../helpers/store-harness.js";
import { loadCatalog, locale, t } from "../../../apps/web/src/i18n/index.js";

vi.mock("../../../apps/web/src/components/ui/UiActionMenu.vue", () => ({
  default: defineComponent({
    props: { items: { type: Array, required: true }, modelValue: String, defaultValue: String },
    setup: (props) => () =>
      h(
        "ul",
        { "data-default": props.defaultValue ?? "none", "data-model": props.modelValue ?? "none" },
        (props.items as SelectOption[]).map((item) => h("li", { "data-value": item.value }, item.label)),
      ),
  }),
}));

let harness: ReturnType<typeof createStoreHarness>;

function project(id: string, name: string, status: string): Record<string, unknown> {
  return { id, name, status, rootPath: `/work/${name.toLowerCase()}` };
}

async function render(props: Record<string, unknown>): Promise<string> {
  const app = createSSRApp({ render: () => h(ProjectFilterMenu, props) });
  return renderToString(app);
}

function values(html: string): string[] {
  return [...html.matchAll(/<li data-value(?:="([^"]*)")?>/g)].map((match) => match[1] ?? "");
}

beforeAll(async () => {
  await loadCatalog("en-US");
  locale.value = "en-US";
});

beforeEach(async () => {
  harness = createStoreHarness(({ url }) =>
    url.pathname === "/api/projects"
      ? [project("a", "Orchard", "tracked"), project("b", "Harbor", "tracked"), project("c", "Attic", "paused")]
      : {},
  );
  const store = useProjectsStore();
  await store.loadProjects();
  await vi.waitFor(() => expect(store.projectsLoaded).toBe(true));
});

afterEach(async () => {
  await harness.cleanup();
});

describe("ProjectFilterMenu", () => {
  it("lists every tracked project whichever one is selected", async () => {
    for (const modelValue of ["", "a", "b"]) {
      const html = await render({ modelValue });
      expect(values(html)).toEqual(["", "a", "b"]);
      expect(html).toContain(t("common.allTrackedProjects"));
    }
  });

  it("omits All projects and the default value when includeAll is false", async () => {
    const html = await render({ includeAll: false });
    expect(values(html)).toEqual(["a", "b"]);
    expect(html).toContain('data-default="none"');
  });

  it("lists every project of any status for scope all and takes a custom All label", async () => {
    const html = await render({ scope: "all", allLabel: "Everything" });
    expect(values(html)).toEqual(["", "a", "b", "c"]);
    expect(html).toContain("Everything");
  });
});
