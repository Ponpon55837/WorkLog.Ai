import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { describe, expect, it } from "vitest";
import UiSelectionBar from "../../../apps/web/src/components/ui/UiSelectionBar.vue";

function render(count: number): Promise<string> {
  return renderToString(
    createSSRApp({
      render: () =>
        h(
          UiSelectionBar,
          {
            modelValue: false,
            label: "Select all",
            selectText: "Select this list",
            groupLabel: "Bulk actions",
            summary: `${count} selected`,
            count,
          },
          { default: () => h("button", "Act") },
        ),
    }),
  );
}

describe("UiSelectionBar", () => {
  it("keeps the live region mounted but empty until something is selected", async () => {
    const html = await render(0);

    expect(html).toMatch(/<span class="sr-only" role="status"[^>]*><\/span>/);
    expect(html).toContain("Select this list");
    expect(html).not.toContain("Bulk actions");
    expect(html).not.toContain("Act");
  });

  it("announces the selection and shows the actions once something is selected", async () => {
    const html = await render(2);

    expect(html).toMatch(/<span class="sr-only" role="status"[^>]*>2 selected<\/span>/);
    expect(html).toContain('aria-label="Bulk actions"');
    expect(html).toContain("Act");
    expect(html).not.toContain("Select this list");
  });
});
