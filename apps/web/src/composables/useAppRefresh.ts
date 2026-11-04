import { useQueryCache } from "@pinia/colada";
import { getActivePinia } from "pinia";
import { watch } from "vue";
import { queryKeys } from "../stores/query-keys";
import { useApi } from "./useApi";
import { updateApiConnection, useApiConnection } from "./useApiConnection";

/** Invalidates only enabled queries; Pinia Colada refetches those with active observers. */
export function invalidateActiveQueries(): Promise<unknown> {
  const pinia = getActivePinia();
  return pinia ? useQueryCache(pinia).invalidateQueries() : Promise.resolve();
}

/** Invalidates only Agent read audit queries after their dedicated SSE event. */
export function invalidateAgentReadQueries(): void {
  const pinia = getActivePinia();
  if (pinia) {
    void useQueryCache(pinia)
      .invalidateQueries({ key: queryKeys.agentReads.all })
      .catch(() => undefined);
  }
}

/** Connects data changes, Agent read audits, and API recovery to the relevant active queries. */
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
      () => document.visibilityState === "visible" && invalidateAgentReadQueries(),
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
