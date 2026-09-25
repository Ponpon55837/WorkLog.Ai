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

  it("uses the API's error message when the response is a JSON error", async () => {
    respond(400, JSON.stringify({ error: "匯出範圍無效。" }));
    await expect(new ApiClient().request("/api/export")).rejects.toThrow("匯出範圍無效。");
  });

  it("explains that the API is unavailable when the dev proxy answers with an empty body", async () => {
    // Vite's proxy returns 500 text/plain with no body while the API server restarts.
    respond(500, "", "text/plain");
    await expect(new ApiClient().request("/api/dashboard")).rejects.toThrow("請求失敗，請確認 API 是否已啟動。");
  });

  it("rejects a successful response that is not JSON instead of throwing a parse error", async () => {
    respond(200, "<html></html>", "text/html");
    await expect(new ApiClient().request("/api/dashboard")).rejects.toThrow("API 回應格式不正確");
  });
});
