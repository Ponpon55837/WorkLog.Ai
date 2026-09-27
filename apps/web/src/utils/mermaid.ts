import { importMermaid } from "./mermaid-loader";

/** Mermaid's inline <style> blocks, which the page CSP (`style-src-elem 'self'`) does not allow. */
const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;

let renderCount = 0;
let loaded: Promise<typeof import("mermaid").default> | undefined;

/** Separates an SVG's <style> rules from its markup, so the rules can be applied as a constructed stylesheet. */
export function splitSvgStyles(svg: string): { svg: string; css: string } {
  const rules: string[] = [];
  const markup = svg.replace(STYLE_BLOCK, (_block, css: string) => {
    rules.push(css);
    return "";
  });
  return { svg: markup, css: rules.join("\n") };
}

/** Loads Mermaid once, on first use, with labels sanitized and interaction disabled. */
function loadMermaid(): Promise<typeof import("mermaid").default> {
  loaded ??= importMermaid().then(({ default: mermaid }) => {
    // Mermaid measures labels while its own <style> is blocked by the CSP, so the page font applies; drawing then
    // uses Mermaid's CSS. Giving Mermaid the page font keeps both the same, so labels fit their boxes.
    const pageFont = window.getComputedStyle(document.body);
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      // The Web UI has one dark theme.
      theme: "dark",
      themeVariables: { fontFamily: pageFont.fontFamily, fontSize: pageFont.fontSize },
      flowchart: { htmlLabels: false },
    });
    return mermaid;
  });
  return loaded;
}

/** Renders Mermaid source to SVG markup plus the CSS it needs; throws with Mermaid's message on invalid source. */
export async function renderMermaid(source: string): Promise<{ svg: string; css: string }> {
  const mermaid = await loadMermaid();
  await mermaid.parse(source);
  renderCount += 1;
  const { svg } = await mermaid.render(`work-diagram-${renderCount}`, source);
  return splitSvgStyles(svg);
}
