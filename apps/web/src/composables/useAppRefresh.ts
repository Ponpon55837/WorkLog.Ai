import { onMounted, ref, watch } from "vue";
import { useApi } from "./useApi";

const refreshTick = ref(0);

/** Global refresh signal: the header refresh button bumps it; views reload their own data. */
export function requestAppRefresh(): void {
  refreshTick.value += 1;
}

/** Connects the app-wide refresh signal to SQLite changes while this tab is visible. */
export function startAppRefreshEvents(): () => void {
  let source: EventSource | undefined;
  let stopped = false;
  const { client } = useApi();

  function connect(): void {
    if (stopped || source || document.visibilityState !== "visible") {
      return;
    }
    let openedOnce = false;
    source = client.openChangeStream(
      () => {
        if (document.visibilityState === "visible") {
          requestAppRefresh();
        }
      },
      () => {
        if (openedOnce && document.visibilityState === "visible") {
          // EventSource reconnects automatically; re-fetch in case a change happened while offline.
          requestAppRefresh();
        }
        openedOnce = true;
      },
    );
  }

  function onVisibilityChange(): void {
    if (document.visibilityState === "visible") {
      connect();
      // The stream is closed while hidden, so catch up immediately when the tab returns.
      requestAppRefresh();
      return;
    }
    source?.close();
    source = undefined;
  }

  document.addEventListener("visibilitychange", onVisibilityChange);
  connect();

  return () => {
    stopped = true;
    document.removeEventListener("visibilitychange", onVisibilityChange);
    source?.close();
    source = undefined;
  };
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
