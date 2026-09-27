import { PiniaColada, useQueryCache } from "@pinia/colada";
import { createPinia, setActivePinia } from "pinia";
import { createApp } from "vue";
import { vi } from "vitest";

export type StoreRequest = {
  url: URL;
  method: string;
  body: unknown;
  signal: AbortSignal | undefined;
};

export type StoreResponder = (request: StoreRequest) => unknown | Response | Promise<unknown | Response>;

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Each caller gets a fresh Pinia/query cache and a replaceable fake HTTP server. */
export function createStoreHarness(responder: StoreResponder = () => ({})) {
  const calls: StoreRequest[] = [];
  let respond = responder;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request: StoreRequest = {
      url: new URL(String(input), "http://localhost"),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      signal: init?.signal ?? undefined,
    };
    calls.push(request);
    const result = await respond(request);
    return result instanceof Response ? result : jsonResponse(result);
  });

  vi.stubGlobal("fetch", fetchMock);
  const pinia = createPinia();
  const app = createApp({}).use(pinia).use(PiniaColada);
  setActivePinia(pinia);

  return {
    calls,
    fetchMock,
    setResponder(next: StoreResponder) {
      respond = next;
    },
    count(path: string, method = "GET") {
      return calls.filter((call) => call.url.pathname === path && call.method === method).length;
    },
    async cleanup() {
      // Stop queries still in flight so they cannot resolve into the next test's cache.
      app.runWithContext(() => useQueryCache().cancelQueries());
      setActivePinia(undefined);
      vi.unstubAllGlobals();
    },
  };
}
