import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../../apps/web/src/api/client.js";
import { appendQuery } from "../../../apps/web/src/api/transport.js";

function respond(status: number, body: string, contentType = "application/json"): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status, headers: { "Content-Type": contentType } })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ApiClient.request", () => {
  it("returns the JSON payload of a successful response", async () => {
    respond(200, JSON.stringify({ outcome: "ok" }));
    await expect(new ApiClient().request("/api/health")).resolves.toEqual({ outcome: "ok" });
  });

  it("does not interpret a successful payload's details field as an error envelope", async () => {
    respond(200, JSON.stringify({ details: { source: "health-check" } }));
    await expect(new ApiClient().request("/api/health")).resolves.toEqual({ details: { source: "health-check" } });
  });

  it("preserves the API error code, HTTP status, and message", async () => {
    respond(400, JSON.stringify({ error: "匯出範圍無效。" }));
    await expect(new ApiClient().request("/api/export")).rejects.toMatchObject({
      name: "ApiError",
      code: "invalid_input",
      status: 400,
      message: "匯出範圍無效。",
    });
  });

  it("uses the machine-readable code supplied by the API", async () => {
    respond(409, JSON.stringify({ error: "English server message", code: "PROJECT_NAME_MISMATCH" }));
    await expect(new ApiClient().request("/api/projects/project-1")).rejects.toMatchObject({
      code: "PROJECT_NAME_MISMATCH",
      status: 409,
    });
  });

  it("explains that the API is unavailable when the dev proxy answers with an empty body", async () => {
    // Vite's proxy returns 500 text/plain with no body while the API server restarts.
    respond(500, "", "text/plain");
    await expect(new ApiClient().request("/api/dashboard")).rejects.toThrow("請求失敗，請確認 API 是否已啟動。");
  });

  it("rejects a successful response that is not JSON instead of throwing a parse error", async () => {
    respond(200, "<html></html>", "text/html");
    await expect(new ApiClient().request("/api/dashboard")).rejects.toMatchObject({
      code: "malformed_response",
      status: 200,
    });
  });

  it("reports transport failures to the shared connection state", async () => {
    const onConnectionChange = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    await expect(new ApiClient("", onConnectionChange).request("/api/health")).rejects.toMatchObject({
      code: "network_error",
      status: 0,
    });
    expect(onConnectionChange).toHaveBeenCalledWith(false);
  });

  it("marks only non-API gateway failures offline, not the API's own JSON errors", async () => {
    const onConnectionChange = vi.fn();
    respond(500, "", "text/plain");
    await expect(new ApiClient("", onConnectionChange).request("/api/health")).rejects.toThrow("請確認 API 是否已啟動");
    expect(onConnectionChange).toHaveBeenLastCalledWith(false);

    respond(503, JSON.stringify({ error: "資料庫暫時忙碌，請稍後再試", code: "database_busy" }));
    await expect(new ApiClient("", onConnectionChange).request("/api/health")).rejects.toMatchObject({
      code: "database_busy",
      status: 503,
      message: "資料庫暫時忙碌，請稍後再試",
    });
    expect(onConnectionChange).toHaveBeenLastCalledWith(true);

    respond(400, JSON.stringify({ error: "輸入無效。" }));
    await expect(new ApiClient("", onConnectionChange).request("/api/health")).rejects.toThrow("輸入無效。");
    expect(onConnectionChange).toHaveBeenLastCalledWith(true);
  });

  it.each([
    [403, "origin_not_allowed"],
    [404, "not_found"],
    [409, "conflict"],
    [413, "payload_too_large"],
    [415, "unsupported_media_type"],
    [421, "host_not_allowed"],
    [502, "internal_error"],
    [503, "service_unavailable"],
  ])("maps HTTP %i to the %s API code when no code is returned", async (status, code) => {
    respond(status, "not json", "text/plain");
    await expect(new ApiClient().request("/api/test")).rejects.toMatchObject({ status, code });
  });

  it("preserves explicit abort errors without reporting the API offline", async () => {
    const onConnectionChange = vi.fn();
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("Aborted", "AbortError");
      }),
    );

    await expect(
      new ApiClient("", onConnectionChange).request("/api/test", { signal: controller.signal }),
    ).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(onConnectionChange).not.toHaveBeenCalled();
  });

  it("downloads a binary response and uses the API error envelope on download failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("sqlite", { status: 200 })),
    );
    const client = new ApiClient();
    const blob = await client.download("/api/export", { scope: "all" }, "fallback");
    expect(await blob.text()).toBe("sqlite");

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ error: "no access", code: "origin_not_allowed" }), { status: 403 }),
      ),
    );
    await expect(client.download("/api/export", {}, "fallback")).rejects.toMatchObject({
      code: "origin_not_allowed",
      status: 403,
      message: "no access",
    });
  });

  it("registers change-stream and reconnection handlers on the same-origin event endpoint", () => {
    class EventSourceMock {
      public listeners = new Map<string, EventListener[]>();
      public constructor(public readonly url: string) {}
      public addEventListener(name: string, listener: EventListener): void {
        this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
      }
      public emit(name: string): void {
        this.listeners.get(name)?.forEach((listener) => listener(new Event(name)));
      }
    }
    vi.stubGlobal("EventSource", EventSourceMock as unknown as typeof EventSource);
    const changed = vi.fn();
    const reconnected = vi.fn();
    const source = new ApiClient("http://localhost:5966/").openChangeStream(
      changed,
      reconnected,
    ) as unknown as EventSourceMock;
    expect(source.url).toBe("http://localhost:5966/api/events");
    source.emit("changed");
    source.emit("open");
    expect(changed).toHaveBeenCalledOnce();
    expect(reconnected).toHaveBeenCalledOnce();
    new ApiClient().openChangeStream(changed);
  });
});

describe("appendQuery", () => {
  it("omits empty values while preserving booleans, zeroes, and encoding", () => {
    expect(appendQuery("/path", { empty: "", missing: undefined, pageSize: 0, include: false, q: "two words" })).toBe(
      "/path?pageSize=0&include=false&q=two+words",
    );
    expect(appendQuery("/path", { empty: "" })).toBe("/path");
  });
});

describe("ApiClient.pageInfo", () => {
  it("normalizes page values and represents empty lists consistently", () => {
    expect(ApiClient.pageInfo(0, 0, 0)).toEqual({
      page: 1,
      pageSize: 1,
      total: 0,
      totalPages: 1,
      from: 0,
      to: 0,
      hasPrevious: false,
      hasNext: false,
      truncated: false,
    });
    expect(ApiClient.pageInfo(25, 99, 10)).toMatchObject({
      page: 3,
      totalPages: 3,
      from: 21,
      to: 25,
      hasPrevious: true,
      hasNext: false,
    });
    expect(ApiClient.pageInfo(25, 2, 10)).toMatchObject({ hasPrevious: true, hasNext: true, from: 11, to: 20 });
  });
});
