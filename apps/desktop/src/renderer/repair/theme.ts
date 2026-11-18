/**
 * The theme follows the system, as the Web UI's 「跟隨系統」 does: tokens.css has dark at `:root` and light at
 * `:root[data-theme="light"]`, so the page only has to set `data-theme` from the system setting, before its first render
 * and again whenever the setting changes.
 */
export type Theme = "light" | "dark";

export const LIGHT_SCHEME_QUERY = "(prefers-color-scheme: light)";

export function themeFor(prefersLight: boolean): Theme {
  return prefersLight ? "light" : "dark";
}

/** Sets the theme now and keeps it in step with the system setting. */
export function followSystemTheme(root: HTMLElement, query: MediaQueryList): void {
  const apply = (): void => {
    root.dataset.theme = themeFor(query.matches);
  };
  apply();
  query.addEventListener("change", apply);
}
