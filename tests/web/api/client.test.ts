import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../../apps/web/src/api/client.js";

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
});
