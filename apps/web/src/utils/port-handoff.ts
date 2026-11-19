import {
  PORT_HANDOFF_FRAGMENT_KEY,
  SIDE_PANEL_WIDTH_KEYS,
  decodePortHandoffFragment,
  sanitizeBrowserPreferences,
  type BrowserPreferences,
} from "@work-intelligence/schema/port-handoff";

/** The storage keys the preference owners already use; the handoff only writes under these. */
const LOCALE_KEY = "work-intelligence:locale";
const THEME_KEY = "work-intelligence:theme";
const EDITOR_KEY = "work-intelligence:editor";
const PROJECTS_POLICY_DISMISSED_KEY = "wi.projects.policyDismissed";
const SIDE_PANEL_WIDTH_KEY_PREFIX = "wi.side-panel-width.";

/** The part of `Storage` the handoff needs; browser storage can be missing or blocked, so every access is guarded. */
type HandoffStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * What `consumePortHandoff` needs from the page; the browser entry passes `window.location` and `history`.
 * @internal test-only
 */
export interface PortHandoffHost {
  hash: string;
  pathname: string;
  search: string;
  storage: HandoffStorage | undefined;
  replaceUrl(url: string): void;
}

function readItem(storage: HandoffStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeItem(storage: HandoffStorage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    // A blocked storage only means the preference is not carried over.
  }
}

/** The page's whitelisted preferences as stored in this browser, ready to hand to the App; never includes anything else. */
export function readBrowserPreferences(storage: HandoffStorage | undefined): BrowserPreferences {
  if (!storage) return {};
  const widths: Record<string, number> = {};
  for (const key of SIDE_PANEL_WIDTH_KEYS) {
    const stored = readItem(storage, `${SIDE_PANEL_WIDTH_KEY_PREFIX}${key}`);
    if (stored !== null && stored.trim() !== "") widths[key] = Number(stored);
  }
  return sanitizeBrowserPreferences({
    locale: readItem(storage, LOCALE_KEY) ?? undefined,
    theme: readItem(storage, THEME_KEY) ?? undefined,
    editor: readItem(storage, EDITOR_KEY) ?? undefined,
    projectsPolicyDismissed: readItem(storage, PROJECTS_POLICY_DISMISSED_KEY) === "1" ? true : undefined,
    sidePanelWidths: widths,
  });
}

/** Writes each whitelisted preference under its existing key; the values were validated by the schema. */
export function writeBrowserPreferences(storage: HandoffStorage, preferences: BrowserPreferences): void {
  if (preferences.locale) writeItem(storage, LOCALE_KEY, preferences.locale);
  if (preferences.theme) writeItem(storage, THEME_KEY, preferences.theme);
  if (preferences.editor) writeItem(storage, EDITOR_KEY, preferences.editor);
  if (preferences.projectsPolicyDismissed) writeItem(storage, PROJECTS_POLICY_DISMISSED_KEY, "1");
  for (const key of SIDE_PANEL_WIDTH_KEYS) {
    const width = preferences.sidePanelWidths?.[key];
    if (width !== undefined) writeItem(storage, `${SIDE_PANEL_WIDTH_KEY_PREFIX}${key}`, String(width));
  }
}

function hasHandoffKey(hash: string): boolean {
  return (hash.startsWith("#") ? hash.slice(1) : hash).startsWith(`${PORT_HANDOFF_FRAGMENT_KEY}=`);
}

/**
 * Applies a handoff from the App found in the URL hash: writes the whitelisted preferences, clears the hash and returns
 * the route to open. Returns undefined, and touches nothing, when the hash is not a valid handoff. Must run before the
 * preferences store reads storage. Never logs the fragment or the preferences.
 */
export function consumePortHandoff(host: PortHandoffHost): string | undefined {
  const handoff = decodePortHandoffFragment(host.hash);
  if (handoff && host.storage) writeBrowserPreferences(host.storage, handoff.preferences);
  // A fragment with our key is never left in the address bar, valid or not.
  if (handoff || hasHandoffKey(host.hash)) host.replaceUrl(`${host.pathname}${host.search}`);
  return handoff?.route;
}

/** The part of a resolved route that the gate reads: the path pattern of each matched record. */
export interface ResolvedRouteRecord {
  path: string;
}

/**
 * A route from the App's handoff is opened only when it matches a real page: a resolvable route is kept as it is, and
 * the catch-all or an unknown route becomes "/".
 */
export function gateHandoffRoute(
  route: string,
  resolve: (route: string) => { matched: readonly ResolvedRouteRecord[] },
): string {
  const { matched } = resolve(route);
  const known = matched.length > 0 && matched.every((record) => !record.path.includes(":pathMatch("));
  return known ? route : "/";
}
