import { useQueryCache } from "@pinia/colada";
import { getActivePinia } from "pinia";
import { watch } from "vue";
import { useApi } from "./useApi";
import { updateApiConnection, useApiConnection } from "./useApiConnection";

/** Invalidates only enabled queries; Pinia Colada refetches those with active observers. */
export function invalidateActiveQueries(): Promise<unknown> {
  const pinia = getActivePinia();
  return pinia ? useQueryCache(pinia).invalidateQueries() : Promise.resolve();
}

/** Connects the data-free SQLite change stream and connection recovery to active queries. */
export function startAppRefreshEvents(): () => void {
  let source: EventSource | undefined;
  let stopped = false;
  const { client } = useApi();
  const { isApiOffline } = useApiConnection();

  function invalidate(): void {
    void invalidateActiveQueries().catch(() => undefined);
  }

  const stopWatchingConnection = watch(isApiOffline, (isOffline, wasOffline) => {
    if (wasOffline && !isOffline && document.visibilityState === "visible") {
      invalidate();
    }
  });

  function connect(): void {
    if (stopped || source || document.visibilityState !== "visible") {
      return;
    }
    source = client.openChangeStream(
      () => {
        if (document.visibilityState === "visible") {
          invalidate();
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
      invalidate();
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
