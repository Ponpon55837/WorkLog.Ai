import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAttentionStore } from "../../../apps/web/src/stores/attention.js";
import { useDashboardStore } from "../../../apps/web/src/stores/dashboard.js";
import { attentionRoute } from "../../../apps/web/src/utils/attention.js";
import { createStoreHarness, jsonResponse } from "../helpers/store-harness.js";

let harness: ReturnType<typeof createStoreHarness>;
beforeEach(() => {
  harness = createStoreHarness(({ url }) =>
    url.pathname === "/api/reports"
      ? { outcome: "skipped" }
      : {
          outcome: "attention",
          items: [],
          groups: [{ kind: "knowledge", state: "partial", total: null, examined: 200, available: 201 }],
          total: null,
          minimumTotal: 0,
          pageInfo: {},
        },
  );
});
afterEach(async () => harness.cleanup());

describe("attention view state", () => {
  it("keys every scope and preserves unknown coverage", async () => {
    const store = useAttentionStore();
    store.setActive(true);
    await store.reload();
    expect(store.loaded).toBe(true);
    expect(store.hasIncomplete).toBe(true);
    store.projectId = "p1";
    store.kind = "knowledge";
    store.view = "suppressed";
    store.page = 2;
    store.pageSize = 50;
    await store.reload();
    const query = harness.calls.at(-1)?.url.searchParams;
    expect(Object.fromEntries(query ?? [])).toEqual({
      projectId: "p1",
      kind: "knowledge",
      view: "suppressed",
      page: "2",
      pageSize: "50",
    });
    store.setActive(false);
    store.projectId = "p2";
    const count = harness.calls.length;
    await Promise.resolve();
    expect(harness.calls.length).toBe(count);
  });
  it("shares the unfiltered shell read and never claims complete coverage after an error", async () => {
    const dashboard = useDashboardStore();
    await dashboard.loadDashboardData();
    const store = useAttentionStore();
    store.setActive(true);
    await vi.waitFor(() => expect(store.loaded).toBe(true));
    expect(harness.count("/api/attention")).toBe(1);
    harness.setResponder(() => jsonResponse({ code: "service_unavailable" }, 503));
    await store.reload();
    expect(store.error).toBeTruthy();
    expect(store.hasIncomplete).toBe(true);
  });
  it("maps exact cleanup and custom-report scopes only to application routes", () => {
    const base = {
      id: "item",
      sourceId: "request",
      title: "Fictional",
      reason: "review" as const,
      updatedAt: "2026-09-01T00:00:00Z",
      sourceRevision: "revision",
      projectId: "p1",
    };
    expect(
      attentionRoute({ ...base, kind: "cleanup", target: { kind: "cleanup", sourceId: "request", projectId: "p1" } }),
    ).toEqual({
      name: "sessions",
      params: { tab: "outstanding" },
      query: { itemProject: "p1", cleanup: "review", cleanupRequest: "request" },
    });
    expect(
      attentionRoute({
        ...base,
        kind: "synthesis",
        target: { kind: "synthesis", sourceId: "request", period: "custom", from: "2026-09-01", to: "2026-09-03" },
      }),
    ).toMatchObject({ name: "reports", query: { from: "2026-09-01", to: "2026-09-03", period: "custom" } });
  });
  it("refreshes display intent without resolving a source and rejects stale writes", async () => {
    harness.setResponder(({ method }) =>
      method === "PATCH"
        ? { outcome: "attention_preference", preference: { revision: 1, state: "hidden" } }
        : { outcome: "attention", items: [], groups: [], total: 1, minimumTotal: 1, suppressedCount: 1, pageInfo: {} },
    );
    const store = useAttentionStore();
    store.setActive(true);
    await store.reload();
    const input = {
      projectId: "p",
      kind: "decision" as const,
      sourceId: "source",
      sourceRevision: "a".repeat(64),
      expectedRevision: 0,
      action: "hide" as const,
    };
    await expect(store.setPreference(input)).resolves.toBeUndefined();
    expect(store.result?.total).toBe(1);
    expect(harness.calls.find((call) => call.method === "PATCH")?.url.pathname).toBe("/api/attention/preferences");
    harness.setResponder(() => jsonResponse({ code: "conflict", error: "Changed source" }, 409));
    await expect(store.setPreference(input)).rejects.toMatchObject({ status: 409 });
    expect(store.saving).toBe(false);
    expect(store.result?.total).toBe(1);
  });
});
