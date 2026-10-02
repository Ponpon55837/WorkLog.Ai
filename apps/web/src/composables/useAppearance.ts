import { onBeforeUnmount, watch } from "vue";
import { storeToRefs } from "pinia";
import { intlLocale } from "../i18n";
import { usePreferencesStore } from "../stores/preferences";

/**
 * Applies the theme and language preferences to the document: `data-theme` selects the token set in
 * styles/tokens.css and `lang` keeps screen readers and font fallback right. Call once from App.vue.
 */
export function useAppearance(): void {
  const { resolvedTheme, systemPrefersDark, locale } = storeToRefs(usePreferencesStore());
  const media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  systemPrefersDark.value = media?.matches ?? true;

  function onSystemChange(event: MediaQueryListEvent): void {
    systemPrefersDark.value = event.matches;
  }

  media?.addEventListener("change", onSystemChange);

  watch(
    resolvedTheme,
    (value, previous) => {
      const root = document.documentElement;
      // Cross-fade colours only when the theme changes, never on first paint.
      if (previous) {
        root.classList.add("is-theme-switching");
        window.setTimeout(() => root.classList.remove("is-theme-switching"), 320);
      }
      root.dataset.theme = value;
      // Read the colour back from the tokens so raw values stay in tokens.css.
      const canvas = window.getComputedStyle(root).getPropertyValue("--bg-canvas").trim();
      if (canvas) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", canvas);
    },
    { immediate: true },
  );

  watch(locale, () => (document.documentElement.lang = intlLocale()), { immediate: true });

  onBeforeUnmount(() => media?.removeEventListener("change", onSystemChange));
}
