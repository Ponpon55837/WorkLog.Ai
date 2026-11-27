import { z } from "zod";

// Only non-secret UI preferences and the route cross origins: never a session, token or database path.
// The page reads the fragment once and clears it with history.replaceState.
export const PORT_HANDOFF_FRAGMENT_KEY = "wi-handoff";

export const MAX_HANDOFF_ROUTE_LENGTH = 512;

export const SIDE_PANEL_WIDTH_KEYS = [
  "knowledge-page",
  "session",
  "graph-node",
  "knowledge-history",
  "diagram-reader",
] as const;

const panelWidthSchema = z.number().int().min(160).max(4000);

/**
 * The whitelist of browser preferences that may cross origins. Each value has a closed schema; an unknown key or a bad
 * value is dropped by {@link sanitizeBrowserPreferences}, never stored.
 */
export const browserPreferencesSchema = z.strictObject({
  locale: z.enum(["zh-TW", "en-US"]).optional(),
  theme: z.enum(["system", "light", "dark"]).optional(),
  editor: z.enum(["none", "vscode", "cursor"]).optional(),
  projectsPolicyDismissed: z.literal(true).optional(),
  sidePanelWidths: z.partialRecord(z.enum(SIDE_PANEL_WIDTH_KEYS), panelWidthSchema).optional(),
});

export type BrowserPreferences = z.infer<typeof browserPreferencesSchema>;

/**
 * A route the page may be sent back to: one leading "/", no "//", no backslash, no scheme or control characters, and
 * at most {@link MAX_HANDOFF_ROUTE_LENGTH} characters. Query and hash are not carried.
 */
export function isSafeHandoffRoute(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_HANDOFF_ROUTE_LENGTH) return false;
  if (!value.startsWith("/") || value.includes("//") || value.includes("\\")) return false;
  if (value.includes("?") || value.includes("#") || value.includes(":")) return false;
  // Control characters, spaces and non-ASCII would be percent-encoded by the router anyway.
  return /^[\x21-\x7e]+$/.test(value);
}

export function sanitizeHandoffRoute(value: unknown): string {
  return isSafeHandoffRoute(value) ? value : "/";
}

export function sanitizeBrowserPreferences(value: unknown): BrowserPreferences {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const shape = browserPreferencesSchema.shape;
  const result: BrowserPreferences = {};
  const locale = shape.locale.safeParse(input.locale);
  if (locale.success && locale.data !== undefined) result.locale = locale.data;
  const theme = shape.theme.safeParse(input.theme);
  if (theme.success && theme.data !== undefined) result.theme = theme.data;
  const editor = shape.editor.safeParse(input.editor);
  if (editor.success && editor.data !== undefined) result.editor = editor.data;
  if (input.projectsPolicyDismissed === true) result.projectsPolicyDismissed = true;
  const widths = input.sidePanelWidths;
  if (typeof widths === "object" && widths !== null && !Array.isArray(widths)) {
    const kept: Partial<Record<(typeof SIDE_PANEL_WIDTH_KEYS)[number], number>> = {};
    for (const key of SIDE_PANEL_WIDTH_KEYS) {
      const width = panelWidthSchema.safeParse((widths as Record<string, unknown>)[key]);
      if (width.success) kept[key] = width.data;
    }
    if (Object.keys(kept).length > 0) result.sidePanelWidths = kept;
  }
  return result;
}

export const openPortSettingsInputSchema = z.strictObject({
  preferences: z.unknown().optional(),
  route: z
    .string()
    .max(MAX_HANDOFF_ROUTE_LENGTH * 4)
    .optional(),
});

export interface PortHandoff {
  preferences: BrowserPreferences;
  route: string;
}

// The whitelist is far smaller, so anything bigger is not ours.
const MAX_HANDOFF_ENCODED_LENGTH = 4096;

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return undefined;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export function encodePortHandoffFragment(handoff: PortHandoff): string {
  const payload = {
    v: 1,
    preferences: sanitizeBrowserPreferences(handoff.preferences),
    route: sanitizeHandoffRoute(handoff.route),
  };
  return `${PORT_HANDOFF_FRAGMENT_KEY}=${toBase64Url(JSON.stringify(payload))}`;
}

// The values that come back are always sanitized again.
export function decodePortHandoffFragment(hash: string): PortHandoff | undefined {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const prefix = `${PORT_HANDOFF_FRAGMENT_KEY}=`;
  if (!raw.startsWith(prefix)) return undefined;
  const encoded = raw.slice(prefix.length);
  if (encoded.length === 0 || encoded.length > MAX_HANDOFF_ENCODED_LENGTH) return undefined;
  const text = fromBase64Url(encoded);
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || (parsed as { v?: unknown }).v !== 1) return undefined;
  const value = parsed as { preferences?: unknown; route?: unknown };
  return { preferences: sanitizeBrowserPreferences(value.preferences), route: sanitizeHandoffRoute(value.route) };
}
