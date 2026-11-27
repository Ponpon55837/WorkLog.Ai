import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { describe, expect, it } from "vitest";
import UiButton from "../../../apps/web/src/components/ui/UiButton.vue";

type ButtonProps = InstanceType<typeof UiButton>["$props"];

function render(props: ButtonProps): Promise<string> {
  return renderToString(createSSRApp({ render: () => h(UiButton, props, () => "Go") }));
}

describe("UiButton disabled state", () => {
  it("marks a disabled button and shows its reason as the tooltip and description", async () => {
    const html = await render({ variant: "primary", disabled: true, disabledReason: "Pick a project first" });

    expect(html).toContain("ui-button--disabled");
    expect(html).toContain("disabled");
    expect(html).toContain('title="Pick a project first"');
    expect(html).toContain('aria-description="Pick a project first"');
  });

  it("shows no reason on an enabled button", async () => {
    const html = await render({ disabled: false, disabledReason: "Pick a project first" });

    expect(html).not.toContain("ui-button--disabled");
    expect(html).not.toContain("Pick a project first");
  });

  it("keeps a loading button in its own colors instead of the grey disabled look", async () => {
    const html = await render({ variant: "primary", loading: true, disabled: true, disabledReason: "Busy" });

    expect(html).toContain("ui-button--loading");
    expect(html).not.toContain("ui-button--disabled");
    expect(html).toContain("aria-busy");
  });
});
