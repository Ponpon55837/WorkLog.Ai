import { onBeforeUnmount, watch, type Ref, type WatchSource } from "vue";

/**
 * Standard list reload wiring used by every filtered list:
 * - a filter change resets to page 1 (or reloads if already on page 1),
 * - a page change reloads,
 * - a search-only change is debounced,
 * - changes that arrive together with a page change (back/forward navigation restoring the URL)
 *   keep that page and reload once.
 * Returns `reloadNow` for explicit submits (Enter in the search box).
 */
export function useListReload(options: {
  load: () => unknown;
  page: Ref<number>;
  filters: WatchSource[];
  search?: Ref<string>;
  debounceMs?: number;
}): { reloadNow: () => void } {
  let timer: number | undefined;

  function cancelPending(): void {
    window.clearTimeout(timer);
    timer = undefined;
  }

  function resetAndLoad(): void {
    cancelPending();
    if (options.page.value !== 1) {
      options.page.value = 1;
    } else {
      void options.load();
    }
  }

  const search = options.search;
  const sources: WatchSource[] = [...options.filters, ...(search ? [search] : []), options.page];

  watch(sources, (next, previous) => {
    const changed = (index: number): boolean => next[index] !== previous[index];
    const pageIndex = sources.length - 1;
    const searchIndex = search ? pageIndex - 1 : -1;
    const filtersChanged = options.filters.some((_, index) => changed(index));
    const searchChanged = searchIndex >= 0 && changed(searchIndex);

    if (changed(pageIndex)) {
      cancelPending();
      void options.load();
    } else if (filtersChanged) {
      resetAndLoad();
    } else if (searchChanged) {
      cancelPending();
      timer = window.setTimeout(resetAndLoad, options.debounceMs ?? 300);
    }
  });

  onBeforeUnmount(cancelPending);

  return { reloadNow: resetAndLoad };
}
