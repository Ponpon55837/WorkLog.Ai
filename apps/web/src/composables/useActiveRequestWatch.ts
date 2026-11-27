import { onBeforeUnmount, watch } from "vue";

type WatchedRequest = { id: string; status: string };

const activeStatuses = new Set(["pending", "processing"]);

/** `onSettled` fires once per request seen active that then leaves that state within the same `scope`; changing scope resets tracking so a request that scrolled out of view is not reported finished. */
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
