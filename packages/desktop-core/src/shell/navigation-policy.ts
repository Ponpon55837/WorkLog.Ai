import { PORT_HANDOFF_FRAGMENT_KEY, decodePortHandoffFragment } from "@work-intelligence/schema";

/** Custom scheme of the repair page. Registered as privileged before the app is ready. */
export const REPAIR_SCHEME = "wi-repair";
export const REPAIR_ORIGIN = `${REPAIR_SCHEME}://app`;
export const REPAIR_PAGE_URL = `${REPAIR_ORIGIN}/index.html`;

export interface RepairAsset {
  /** File name inside the build's repair folder. A fixed value, never built from the request. */
  readonly file: string;
  readonly contentType: string;
}

/**
 * The only four things the repair scheme serves (`tokens.css` is the shared design tokens, copied beside the page at
 * build time). The request picks a key; it never contributes to a path.
 */
export const REPAIR_ASSETS: ReadonlyMap<string, RepairAsset> = new Map([
  ["/index.html", { file: "index.html", contentType: "text/html; charset=utf-8" }],
  ["/tokens.css", { file: "tokens.css", contentType: "text/css; charset=utf-8" }],
  ["/repair.css", { file: "repair.css", contentType: "text/css; charset=utf-8" }],
  ["/repair.js", { file: "repair.js", contentType: "text/javascript; charset=utf-8" }],
]);

/** Content-Security-Policy of the repair page: its own files only, no network, no embedding, no forms. */
export const REPAIR_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/** True when `url` is exactly a repair-scheme URL on the fixed host, with no credentials and no port. */
function isRepairUrl(parsed: URL): boolean {
  return (
    parsed.protocol === `${REPAIR_SCHEME}:` &&
    parsed.hostname === "app" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.port === ""
  );
}

/** The asset a repair-scheme URL names (`/` is the page), or undefined for anything else. */
export function resolveRepairAsset(url: string): RepairAsset | undefined {
  const parsed = parse(url);
  if (!parsed || !isRepairUrl(parsed)) return undefined;
  return REPAIR_ASSETS.get(parsed.pathname === "/" ? "/index.html" : parsed.pathname);
}

/** True for the repair page itself (any of its fixed assets; the page is the only document). */
export function isRepairPageUrl(url: string): boolean {
  return resolveRepairAsset(url) !== undefined;
}

/** The Dashboard origin: plain http, the loopback address, exactly the active port, no credentials. */
export function isDashboardUrl(url: string, activePort: number | null): boolean {
  if (activePort === null) return false;
  const parsed = parse(url);
  return (
    parsed !== undefined &&
    parsed.protocol === "http:" &&
    parsed.hostname === "127.0.0.1" &&
    parsed.port === String(activePort) &&
    parsed.username === "" &&
    parsed.password === ""
  );
}

/**
 * The Dashboard address the App itself opens: exactly the root path, and either no fragment or the one handoff fragment
 * `dashboardUrlFor` builds (nothing else: no query, no other hash).
 */
export function isDashboardOpenUrl(url: string, activePort: number | null): boolean {
  const parsed = parse(url);
  if (parsed === undefined || !isDashboardUrl(url, activePort)) return false;
  if (parsed.pathname !== "/" || parsed.search !== "") return false;
  return (
    parsed.hash === "" ||
    (parsed.hash.startsWith(`#${PORT_HANDOFF_FRAGMENT_KEY}=`) && decodePortHandoffFragment(parsed.hash) !== undefined)
  );
}
