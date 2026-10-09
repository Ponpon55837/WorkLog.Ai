import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  parse: vi.fn(async (source: string) => {
    if (source.includes("-->\n") || source.endsWith("-->")) throw new Error("Parse error on line 2:\n...");
    return true;
  }),
  render: vi.fn(async (id: string, _source: string, target: Element) => {
    const wrapper = document.createElement("div");
    target.appendChild(wrapper);
    const svg = document.createElement("svg");
    wrapper.appendChild(svg);
    const style = document.createElement("style");
    style.textContent = `#${id} .node{fill:red}`;
    svg.insertBefore(style, null);
    return { svg: `<svg id="${id}"><g/></svg>` };
  }),
}));

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly style: Record<string, string> = {};
  textContent = "";

  constructor(readonly localName: string) {}

  setAttribute(): void {}

  appendChild<T extends FakeElement>(node: T): T {
    this.children.push(node);
    return node;
  }

  insertBefore<T extends FakeElement>(node: T): T {
    this.children.unshift(node);
    return node;
  }

  remove(): void {}
}

class FakeDivElement extends FakeElement {
  constructor() {
    super("div");
  }
}

class FakeSvgElement extends FakeElement {
  constructor() {
    super("svg");
  }
}

vi.mock("../../../apps/web/src/utils/mermaid-loader", () => ({
  importMermaid: async () => ({ default: mermaidMock }),
}));

beforeEach(() => {
  vi.stubGlobal("Element", FakeElement);
  vi.stubGlobal("HTMLDivElement", FakeDivElement);
  vi.stubGlobal("SVGSVGElement", FakeSvgElement);
  vi.stubGlobal("document", {
    body: { append: vi.fn() },
    documentElement: { dataset: { theme: "dark" } },
    createElement: (name: string) =>
      name === "svg" ? new FakeSvgElement() : name === "div" ? new FakeDivElement() : new FakeElement(name),
  });
  vi.stubGlobal("window", { getComputedStyle: () => ({ fontFamily: "Noto Sans TC", fontSize: "14px" }) });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("splitSvgStyles", () => {
  it("moves every <style> block out of the SVG markup and keeps its rules", async () => {
    const { splitSvgStyles } = await import("../../../apps/web/src/utils/mermaid.js");
    const svg =
      '<svg id="d"><style type="text/css">#d .node{fill:red}</style><g/><style>#d text{fill:blue}</style></svg>';
    expect(splitSvgStyles(svg)).toEqual({
      svg: '<svg id="d"><g/></svg>',
      css: "#d .node{fill:red}\n#d text{fill:blue}",
    });
    expect(splitSvgStyles("<svg><g/></svg>")).toEqual({ svg: "<svg><g/></svg>", css: "" });
  });
});

describe("renderMermaid", () => {
  it("loads Mermaid once in strict mode with the page font and returns markup without <style>", async () => {
    const { renderMermaid } = await import("../../../apps/web/src/utils/mermaid.js");
    const first = await renderMermaid("flowchart LR\n  A --> B");
    const second = await renderMermaid("flowchart LR\n  B --> C");
    expect(mermaidMock.initialize).toHaveBeenCalledTimes(1);
    expect(mermaidMock.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        securityLevel: "strict",
        htmlLabels: false,
        startOnLoad: false,
        themeVariables: { fontFamily: "Noto Sans TC", fontSize: "14px" },
      }),
    );
    expect(first.svg).not.toContain("<style");
    expect(first.css).toContain(".node{fill:red}");
    expect(mermaidMock.render.mock.calls[0]?.[2]).toBeDefined();
    expect(second.svg).not.toEqual(first.svg);
  });

  it("switches the Mermaid theme with the page theme", async () => {
    const { renderMermaid } = await import("../../../apps/web/src/utils/mermaid.js");
    await renderMermaid("flowchart LR\n  A --> B");
    const calls = mermaidMock.initialize.mock.calls.length;
    (document.documentElement.dataset as Record<string, string>).theme = "light";
    await renderMermaid("flowchart LR\n  A --> B");
    expect(mermaidMock.initialize).toHaveBeenCalledTimes(calls + 1);
    expect(mermaidMock.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "default" }));
  });

  it("rejects source Mermaid cannot parse", async () => {
    const { renderMermaid } = await import("../../../apps/web/src/utils/mermaid.js");
    await expect(renderMermaid("flowchart LR\n  A -->")).rejects.toThrow(/Parse error/);
  });
});
