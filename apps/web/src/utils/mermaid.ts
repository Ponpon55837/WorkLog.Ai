import { importMermaid } from "./mermaid-loader";

/** Mermaid's inline <style> blocks, which the page CSP (`style-src-elem 'self'`) does not allow. */
const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;

let renderCount = 0;
let loaded: Promise<typeof import("mermaid").default> | undefined;
let configuredTheme: "default" | "dark" | undefined;

/** Separates an SVG's <style> rules from its markup, so the rules can be applied as a constructed stylesheet. */
export function splitSvgStyles(svg: string): { svg: string; css: string } {
  const rules: string[] = [];
  const markup = svg.replace(STYLE_BLOCK, (_block, css: string) => {
    rules.push(css);
    return "";
  });
  return { svg: markup, css: rules.join("\n") };
}

/** Provides Mermaid an attached measurement surface while keeping its SVG <style> node out of the document. */
function createCspSafeRenderTarget(): { element: HTMLDivElement; cssRules: string[] } {
  const element = document.createElement("div");
  const cssRules: string[] = [];
  element.setAttribute("aria-hidden", "true");
  Object.assign(element.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    width: "100vw",
    visibility: "hidden",
  });

  // Mermaid inserts its generated SVG <style> synchronously through these elements. Intercept that one node on
  // the temporary render tree so the browser never reports a blocked inline style; the captured rules are applied
  // to the final SVG through the component's Constructable Stylesheet.
  const appendToTarget = element.appendChild.bind(element);
  element.appendChild = (node) => {
    if (node instanceof HTMLDivElement) {
      const appendToWrapper = node.appendChild.bind(node);
      node.appendChild = (child) => {
        if (child instanceof SVGSVGElement) {
          const insertBeforeSvg = child.insertBefore.bind(child);
          child.insertBefore = (newNode, referenceNode) => {
            if (newNode instanceof Element && newNode.localName === "style") {
              cssRules.push(newNode.textContent ?? "");
              return newNode;
            }
            return insertBeforeSvg(newNode, referenceNode);
          };
        }
        return appendToWrapper(child);
      };
    }
    return appendToTarget(node);
  };

  document.body.append(element);
  return { element, cssRules };
}

/** Re-applied when the page theme changes, so a diagram drawn after a switch uses the matching Mermaid theme. */
function configureMermaid(mermaid: typeof import("mermaid").default): void {
  const theme = document.documentElement?.dataset.theme === "light" ? "default" : "dark";
  if (theme === configuredTheme) return;
  configuredTheme = theme;
  // Mermaid measures labels while its own <style> is blocked by the CSP, so the page font applies; drawing then
  // uses Mermaid's CSS. Giving Mermaid the page font keeps both the same, so labels fit their boxes.
  const pageFont = window.getComputedStyle(document.body);
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme,
    themeVariables: { fontFamily: pageFont.fontFamily, fontSize: pageFont.fontSize },
    flowchart: { htmlLabels: false },
  });
}

/** Loads Mermaid once, on first use, with labels sanitized and interaction disabled. */
function loadMermaid(): Promise<typeof import("mermaid").default> {
  loaded ??= importMermaid().then(({ default: mermaid }) => {
    return mermaid;
  });
  return loaded;
}

/** Renders Mermaid source to SVG markup plus the CSS it needs; throws with Mermaid's message on invalid source. */
export async function renderMermaid(source: string): Promise<{ svg: string; css: string }> {
  const mermaid = await loadMermaid();
  configureMermaid(mermaid);
  await mermaid.parse(source);
  renderCount += 1;
  const target = createCspSafeRenderTarget();
  try {
    const { svg } = await mermaid.render(`work-diagram-${renderCount}`, source, target.element);
    const result = splitSvgStyles(svg);
    return { svg: result.svg, css: [...target.cssRules, result.css].filter(Boolean).join("\n") };
  } finally {
    target.element.remove();
  }
}
