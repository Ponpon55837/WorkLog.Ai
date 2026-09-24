import { onBeforeUnmount, watch } from "vue";

type WatchedRequest = { id: string; status: string };

const activeStatuses = new Set(["pending", "processing"]);

/**
 * Re-checks Agent requests while any is pending or processing, so the page picks up what the Agent
 * wrote without a manual refresh. Checks pause while the tab is hidden and stop once nothing is active.
 * `onSettled` fires once per request that was seen active and then left that state within the same
 * `scope` (a new status, or gone from the list); changing the scope, e.g. another report period,
 * resets tracking so a request that merely scrolled out of view is not reported as finished.
 */
export function useActiveRequestWatch<T extends WatchedRequest>(options: {
  requests: () => readonly T[];
  check: () => Promise<void>;
  onSettled: (request: T, status: string | undefined) => void;
  scope?: () => string;
  intervalMs?: number;
}): void {
  const intervalMs = options.intervalMs ?? 5_000;
  let active = new Map<string, T>();
  let timer: number | undefined;
  let checking = false;

  function stop(): void {
    window.clearTimeout(timer);
    timer = undefined;
  }

  async function checkNow(): Promise<void> {
    stop();
    checking = true;
    try {
      await options.check();
    } finally {
      checking = false;
    }
    schedule();
  }

  function schedule(): void {
    stop();
    if (active.size === 0 || document.visibilityState !== "visible") {
      return;
    }
    timer = window.setTimeout(() => void checkNow(), intervalMs);
  }

  function track(requests: readonly T[]): void {
    const current = new Map(requests.map((request) => [request.id, request]));
    for (const [id, previous] of active) {
      const now = current.get(id);
      if (!now || !activeStatuses.has(now.status)) {
        options.onSettled(previous, now?.status);
      }
    }
    active = new Map(requests.filter((request) => activeStatuses.has(request.status)).map((r) => [r.id, r]));
    if (!checking) {
      schedule();
    }
  }

  function onVisibilityChange(): void {
    if (document.visibilityState === "visible" && active.size > 0) {
      // Catch up right away instead of waiting a full interval after the tab comes back.
      void checkNow();
    } else {
      schedule();
    }
  }

  watch(
    () => options.scope?.() ?? "",
    () => {
      active = new Map();
      stop();
    },
  );
  watch(options.requests, track, { immediate: true, deep: true });
  document.addEventListener("visibilitychange", onVisibilityChange);
  onBeforeUnmount(() => {
    stop();
    document.removeEventListener("visibilitychange", onVisibilityChange);
  });
}
