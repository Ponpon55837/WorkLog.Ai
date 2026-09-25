import { onMounted, ref, watch } from "vue";
import { useApi } from "./useApi";
import { updateApiConnection, useApiConnection } from "./useApiConnection";

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
  const { isApiOffline } = useApiConnection();
  const stopWatchingConnection = watch(isApiOffline, (isOffline, wasOffline) => {
    if (wasOffline && !isOffline && document.visibilityState === "visible") {
      requestAppRefresh();
    }
  });

  function connect(): void {
    if (stopped || source || document.visibilityState !== "visible") {
      return;
    }
    source = client.openChangeStream(
      () => {
        if (document.visibilityState === "visible") {
          requestAppRefresh();
        }
      },
      () => updateApiConnection(true),
    );
    source.addEventListener("error", () => updateApiConnection(false));
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
    stopWatchingConnection();
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
