import { onMounted, ref, watch } from "vue";

const refreshTick = ref(0);

/** Global refresh signal: the header refresh button bumps it; views reload their own data. */
export function requestAppRefresh(): void {
  refreshTick.value += 1;
}

/** Loads view data on mount and again whenever a global refresh is requested. */
export function useViewLoader(load: () => unknown): void {
  onMounted(() => {
    void load();
  });
  watch(refreshTick, () => {
    void load();
  });
}
