export type Theme = "light" | "dark";

export const LIGHT_SCHEME_QUERY = "(prefers-color-scheme: light)";

/** @internal test-only */
export function themeFor(prefersLight: boolean): Theme {
  return prefersLight ? "light" : "dark";
}

export function followSystemTheme(root: HTMLElement, query: MediaQueryList): void {
  const apply = (): void => {
    root.dataset.theme = themeFor(query.matches);
  };
  apply();
  query.addEventListener("change", apply);
}
