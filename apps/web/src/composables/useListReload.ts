import { onBeforeUnmount, watch, type Ref, type WatchSource } from "vue";

/**
 * Standard list reload wiring used by every filtered list:
 * - any filter change resets to page 1 (or reloads if already on page 1),
 * - a page change reloads,
 * - text search is debounced.
 */
export function useListReload(options: {
  load: () => unknown;
  page: Ref<number>;
  filters: WatchSource[];
  search?: Ref<string>;
  debounceMs?: number;
}): void {
  function resetAndLoad(): void {
    if (options.page.value !== 1) {
      options.page.value = 1;
    } else {
      void options.load();
    }
  }

  watch(options.filters, resetAndLoad);
  watch(options.page, () => {
    void options.load();
  });

  if (options.search) {
    let timer: number | undefined;
    watch(options.search, () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(resetAndLoad, options.debounceMs ?? 300);
    });
    onBeforeUnmount(() => window.clearTimeout(timer));
  }
}
