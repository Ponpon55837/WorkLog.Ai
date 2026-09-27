import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  parse: vi.fn(async (source: string) => {
    if (source.includes("-->\n") || source.endsWith("-->")) throw new Error("Parse error on line 2:\n...");
    return true;
  }),
  render: vi.fn(async (id: string) => ({ svg: `<svg id="${id}"><style>#${id} .node{fill:red}</style><g/></svg>` })),
}));

vi.mock("../../../apps/web/src/utils/mermaid-loader", () => ({
  importMermaid: async () => ({ default: mermaidMock }),
}));

beforeEach(() => {
  vi.stubGlobal("document", { body: {} });
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
        startOnLoad: false,
        themeVariables: { fontFamily: "Noto Sans TC", fontSize: "14px" },
      }),
    );
    expect(first.svg).not.toContain("<style");
    expect(first.css).toContain(".node{fill:red}");
    expect(second.svg).not.toEqual(first.svg);
  });

  it("rejects source Mermaid cannot parse", async () => {
    const { renderMermaid } = await import("../../../apps/web/src/utils/mermaid.js");
    await expect(renderMermaid("flowchart LR\n  A -->")).rejects.toThrow(/Parse error/);
  });
});
