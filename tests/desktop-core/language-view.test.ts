import { describe, expect, it, vi } from "vitest";
import type { RepairApi } from "../../packages/desktop-core/src/index.js";
import { languageMessages } from "../../packages/desktop-core/src/index.js";

// The DOM helpers and `document` are replaced by plain records, so the card can be read without a browser.
interface FakeNode {
  readonly tag: string;
  className?: string;
  text?: string;
  children: FakeNode[];
  type?: string;
  name?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  dataset: Record<string, string>;
  listeners: Record<string, () => void>;
  addEventListener(type: string, listener: () => void): void;
}

function fake(tag: string, options: { className?: string; text?: string } = {}, children: FakeNode[] = []): FakeNode {
  return {
    tag,
    ...options,
    children,
    dataset: {},
    listeners: {},
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
  };
}

vi.mock("../../apps/desktop/src/renderer/repair/dom.js", () => ({
  element: fake,
  section: (heading: string, ...children: FakeNode[]) => ({ ...fake("section", { text: heading }, children), id: "" }),
  hint: (text: string) => fake("p", { className: "hint", text }),
}));

const { languageSection } = await import("../../apps/desktop/src/renderer/repair/language-view.js");

function radios(node: FakeNode): FakeNode[] {
  return node.children.flatMap((child) => (child.type === "radio" ? [child] : radios(child)));
}

function texts(node: FakeNode): string[] {
  return [...(node.text === undefined ? [] : [node.text]), ...node.children.flatMap(texts)];
}

function host(answer: { ok: boolean } = { ok: true }) {
  const api = { setLanguage: vi.fn(async () => answer) } as unknown as RepairApi & {
    setLanguage: ReturnType<typeof vi.fn>;
  };
  return { api, text: languageMessages("en"), rerender: vi.fn(), refresh: vi.fn() };
}

/** The Settings tab's 「語言」 card: three radio buttons, the saved choice ticked, a click handed to main. */
describe("the 語言 card", () => {
  it("lists 跟隨系統 (naming the system's language), 繁體中文 and English, with the setting ticked", () => {
    const card = languageSection(host(), { preference: "zh-TW", systemLocale: "en" }) as unknown as FakeNode;
    expect(radios(card).map((radio) => [radio.dataset.id, radio.checked])).toEqual([
      ["language-system", false],
      ["language-zh-TW", true],
      ["language-en", false],
    ]);
    expect(texts(card)).toEqual(
      expect.arrayContaining(["Language", "Display language", "Follow system (English)", "繁體中文", "English"]),
    );
  });

  it("hands the choice to main and reads the state again, which carries the new language", async () => {
    const view = host();
    const card = languageSection(view, { preference: "system", systemLocale: "en" }) as unknown as FakeNode;
    const choice = radios(card).find((radio) => radio.value === "zh-TW") as FakeNode;
    choice.checked = true;
    choice.listeners.change?.();
    await vi.waitFor(() => expect(view.refresh).toHaveBeenCalled());
    expect(view.api.setLanguage).toHaveBeenCalledWith("zh-TW");
  });

  it("says so when the setting could not be saved", async () => {
    const view = host({ ok: false });
    const card = languageSection(view, { preference: "system", systemLocale: "en" }) as unknown as FakeNode;
    const choice = radios(card).find((radio) => radio.value === "en") as FakeNode;
    choice.checked = true;
    choice.listeners.change?.();
    await vi.waitFor(() => expect(view.refresh).toHaveBeenCalled());
    const again = languageSection(view, { preference: "system", systemLocale: "en" }) as unknown as FakeNode;
    expect(texts(again)).toContain(languageMessages("en").failed);
  });
});
