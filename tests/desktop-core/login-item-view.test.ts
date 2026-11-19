import { describe, expect, it, vi } from "vitest";
import type { RepairApi, RepairLoginItemSection } from "../../packages/desktop-core/src/index.js";
import { loginItemMessages } from "../../packages/desktop-core/src/index.js";

// The DOM helpers are replaced by plain records, so the view's choices can be read without a browser.
vi.mock("../../apps/desktop/src/renderer/repair/dom.js", () => ({
  section: (heading: string, ...children: unknown[]) => ({ kind: "section", heading, children: children.flat() }),
  hint: (text: string) => ({ kind: "hint", text, hidden: false }),
  checkbox: (label: string, id: string, checked: boolean, enabled: boolean) => ({
    kind: "checkbox",
    label,
    id,
    checked,
    enabled,
  }),
  button: (label: string, id: string, enabled: boolean, onClick: () => void) => ({
    kind: "button",
    label,
    id,
    enabled,
    onClick,
  }),
}));

const { loginItemSection } = await import("../../apps/desktop/src/renderer/repair/login-item-view.js");

interface Node {
  readonly kind: string;
  readonly text?: string;
  readonly id?: string;
  readonly onClick?: () => void;
}
const render = (item: RepairLoginItemSection, openSystemSettings = vi.fn(async () => ({ ok: true }))) => {
  const text = loginItemMessages("zh-TW");
  const host = {
    api: { openSystemSettings } as unknown as RepairApi,
    text,
    working: false,
    rerender: () => undefined,
    refresh: () => undefined,
  };
  const card = loginItemSection(host, item) as unknown as { children: Node[] };
  return { text, nodes: card.children, openSystemSettings };
};

describe("the login item card when macOS waits for approval", () => {
  it("says so instead of showing the item as off, and offers the one fixed place through the enum bridge", () => {
    const { text, nodes, openSystemSettings } = render({ supported: true, desired: true, system: "needs-approval" });
    const texts = nodes.filter((node) => node.kind === "hint").map((node) => node.text);
    expect(texts).toContain(text.statusNeedsApproval);
    expect(texts).not.toContain(text.statusOff);
    const open = nodes.find((node) => node.id === "open-login-items");
    expect(open).toBeDefined();
    open?.onClick?.();
    expect(openSystemSettings).toHaveBeenCalledWith("login-items");
  });

  it("offers no button when the system needs nothing from the user", () => {
    const { nodes } = render({ supported: true, desired: true, system: "enabled" });
    expect(nodes.find((node) => node.id === "open-login-items")).toBeUndefined();
  });
});
