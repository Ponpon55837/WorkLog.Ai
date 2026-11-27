import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { beforeAll, describe, expect, it } from "vitest";
import UiActionMenu from "../../../apps/web/src/components/ui/UiActionMenu.vue";
import UiDateRangeMenu from "../../../apps/web/src/components/ui/UiDateRangeMenu.vue";
import UiFilterChips from "../../../apps/web/src/components/ui/UiFilterChips.vue";
import UiStatCard from "../../../apps/web/src/components/ui/UiStatCard.vue";
import { loadCatalog, locale, t } from "../../../apps/web/src/i18n/index.js";

const items = [
  { value: "", label: "All projects" },
  { value: "a", label: "Orchard" },
];

async function render(component: object, props: Record<string, unknown>): Promise<string> {
  return renderToString(createSSRApp({ render: () => h(component, props) }));
}

beforeAll(async () => {
  await loadCatalog("en-US");
  locale.value = "en-US";
});

describe("UiActionMenu applied state", () => {
  it("names the chosen value on the trigger and in its tooltip", async () => {
    const html = await render(UiActionMenu, { label: "Project", items, modelValue: "a", defaultValue: "" });
    expect(html).toContain("Project: Orchard");
    expect(html).toContain('title="Project: Orchard"');
    expect(html).toContain("is-applied");
  });

  it("keeps the plain label while the default is chosen", async () => {
    const html = await render(UiActionMenu, { label: "Project", items, modelValue: "", defaultValue: "" });
    expect(html).toContain(">Project<");
    expect(html).not.toContain("Orchard");
    expect(html).not.toContain("is-applied");
  });

  it("adds the phone dot only to a trigger that hides its label there", async () => {
    const props = { label: "Project", items, modelValue: "a", defaultValue: "" };
    expect(await render(UiActionMenu, { ...props, hideLabelOnMobile: true })).toContain("ui-action-menu__dot");
    expect(await render(UiActionMenu, props)).not.toContain("ui-action-menu__dot");
  });
});

describe("UiDateRangeMenu applied state", () => {
  it("highlights a chosen range and carries it as the tooltip", async () => {
    const html = await render(UiDateRangeMenu, { modelValue: { from: "2026-11-01", to: "2026-11-05" } });
    expect(html).toContain("is-highlighted");
    expect(html).toContain('title="2026/11/01 – 2026/11/05"');
  });

  it("does not highlight an empty range or a single-date picker", async () => {
    expect(await render(UiDateRangeMenu, { modelValue: { from: "", to: "" } })).not.toContain("is-highlighted");
    const single = await render(UiDateRangeMenu, {
      modelValue: { from: "2026-11-05", to: "2026-11-05" },
      selectionMode: "single",
    });
    expect(single).not.toContain("is-highlighted");
  });
});

describe("UiFilterChips", () => {
  const chips = [
    { key: "project", label: "Project: Orchard" },
    { key: "agent", label: "Agent: Codex" },
  ];

  it("renders one removable chip per filter, named by what it removes", async () => {
    const html = await render(UiFilterChips, { chips });
    expect(html).toContain(t("ui.appliedFilters"));
    expect(html).toContain(`aria-label="${t("ui.removeFilter", { filter: "Project: Orchard" })}"`);
    expect(html).toContain(`aria-label="${t("ui.removeFilter", { filter: "Agent: Codex" })}"`);
    expect(html).not.toContain(t("common.clearFilters"));
  });

  it("offers clear-all only when asked", async () => {
    expect(await render(UiFilterChips, { chips, clearable: true })).toContain(t("common.clearFilters"));
  });

  it("renders nothing without filters", async () => {
    expect(await render(UiFilterChips, { chips: [], clearable: true })).not.toContain("ui-filter-chips");
  });
});

describe("UiStatCard action", () => {
  it("becomes one button named by its label when it has an action title", async () => {
    const html = await render(UiStatCard, { label: "Pending", value: 3, actionTitle: "Go to Needs attention" });
    expect(html).toContain('<button type="button" class="ui-stat__action"');
    expect(html).toContain('title="Go to Needs attention"');
    expect(html).toContain("Pending");
  });

  it("stays plain text without one", async () => {
    expect(await render(UiStatCard, { label: "Pending", value: 3 })).not.toContain("<button");
  });
});
