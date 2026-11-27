import { PORT_HANDOFF_FRAGMENT_KEY, decodePortHandoffFragment } from "@work-intelligence/schema";

export const REPAIR_SCHEME = "wi-repair";
export const REPAIR_ORIGIN = `${REPAIR_SCHEME}://app`;
export const REPAIR_PAGE_URL = `${REPAIR_ORIGIN}/index.html`;

export interface RepairAsset {
  readonly file: string;
  readonly contentType: string;
}

export const REPAIR_ASSETS: ReadonlyMap<string, RepairAsset> = new Map([
  ["/index.html", { file: "index.html", contentType: "text/html; charset=utf-8" }],
  ["/tokens.css", { file: "tokens.css", contentType: "text/css; charset=utf-8" }],
  ["/repair.css", { file: "repair.css", contentType: "text/css; charset=utf-8" }],
  ["/repair.js", { file: "repair.js", contentType: "text/javascript; charset=utf-8" }],
]);

export const REPAIR_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

function isRepairUrl(parsed: URL): boolean {
  return (
    parsed.protocol === `${REPAIR_SCHEME}:` &&
    parsed.hostname === "app" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.port === ""
  );
}

export function resolveRepairAsset(url: string): RepairAsset | undefined {
  const parsed = parse(url);
  if (!parsed || !isRepairUrl(parsed)) return undefined;
  return REPAIR_ASSETS.get(parsed.pathname === "/" ? "/index.html" : parsed.pathname);
}

export function isRepairPageUrl(url: string): boolean {
  return resolveRepairAsset(url) !== undefined;
}

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

export function isDashboardOpenUrl(url: string, activePort: number | null): boolean {
  const parsed = parse(url);
  if (parsed === undefined || !isDashboardUrl(url, activePort)) return false;
  if (parsed.pathname !== "/" || parsed.search !== "") return false;
  return (
    parsed.hash === "" ||
    (parsed.hash.startsWith(`#${PORT_HANDOFF_FRAGMENT_KEY}=`) && decodePortHandoffFragment(parsed.hash) !== undefined)
  );
}
