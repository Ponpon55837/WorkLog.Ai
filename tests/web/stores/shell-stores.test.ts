import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreRequest } from "../helpers/store-harness.js";
import { createStoreHarness, jsonResponse } from "../helpers/store-harness.js";
import { useApi } from "../../../apps/web/src/composables/useApi.js";
import { useQueryCache } from "@pinia/colada";
import { useAppStore } from "../../../apps/web/src/stores/app.js";
import { useCommandPaletteStore } from "../../../apps/web/src/stores/command-palette.js";
import { useDashboardStore } from "../../../apps/web/src/stores/dashboard.js";
import { useSystemStatusStore } from "../../../apps/web/src/stores/system-status.js";
import { queryKeys } from "../../../apps/web/src/stores/query-keys.js";

let harness: ReturnType<typeof createStoreHarness>;
let systemStatusError: boolean;

function shellResponder({ url }: StoreRequest): unknown {
  if (url.pathname === "/api/health") {
    return {
      ok: true,
      app: "Work Intelligence",
      version: "1.0.0",
      schemaVersion: 1,
      policy: "default-deny",
      database: "connected",
    };
  }
  if (url.pathname === "/api/sessions")
    return { items: [], pageInfo: { page: 1, pageSize: 5, total: 0, totalPages: 1 } };
  if (url.pathname === "/api/knowledge") return { outcome: "knowledge", items: [], projects: [], pageInfo: {} };
  if (url.pathname === "/api/reports") return { outcome: "skipped", reason: "沒有可顯示的週報" };
  if (url.pathname === "/api/reports/synthesis-requests") {
    return {
      outcome: "report_synthesis_requests",
      requests: [
        { period: "week", range: { from: "2026-09-21", to: "2026-09-27" }, status: "pending", sourceSessionIds: [] },
        { period: "week", range: { from: "2026-09-21", to: "2026-09-27" }, status: "failed", sourceSessionIds: [] },
        {
          period: "month",
          range: { from: "2026-09-01", to: "2026-09-30" },
          projectId: "p2",
          status: "failed",
          sourceSessionIds: ["s1"],
        },
        {
          period: "quarter",
          range: { from: "2026-07-01", to: "2026-09-30" },
          status: "completed",
          sourceSessionIds: [],
        },
      ],
    };
  }
  if (url.pathname === "/api/backfill/metadata-requests") {
    return {
      outcome: "metadata_backfill_requests",
      requests: [{ id: "backfill-1", status: "processing" }],
    };
  }
  if (url.pathname === "/api/system/status") {
    return systemStatusError
      ? jsonResponse({ code: "service_unavailable", error: "English" }, 503)
      : { database: { state: "missing" } };
  }
  return {};
}

beforeEach(() => {
  systemStatusError = false;
  harness = createStoreHarness(shellResponder);
});

afterEach(async () => harness.cleanup());

describe("shell stores", () => {
  it("loads app health on demand, localizes API errors, and aborts outstanding shared requests", async () => {
    const store = useAppStore();
    expect(store.appHealth).toBeNull();
    await store.loadHealth();
    expect(store.appHealth?.app).toBe("Work Intelligence");
    expect(harness.count("/api/health")).toBe(1);
    const pendingRequest = useApi().beginRequest("abort-pending-from-shell");
    store.abortPendingRequests();
    expect(pendingRequest.signal.aborted).toBe(true);

    harness.setResponder(({ url }) =>
      url.pathname === "/api/health"
        ? jsonResponse({ code: "service_unavailable", error: "temporary" }, 503)
        : shellResponder({ url, method: "GET", body: undefined, signal: undefined }),
    );
    await expect(store.loadHealth()).rejects.toMatchObject({ code: "service_unavailable" });
    expect(store.appHealthError).toBe("服務暫時無法使用，請稍後再試。");

    let aborted = false;
    harness.setResponder(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    const loading = store.loadHealth();
    await vi.waitFor(() => expect(harness.count("/api/health")).toBe(3));
    await useQueryCache().cancelQueries({ key: queryKeys.app.health, exact: true });
    await loading;
    expect(aborted).toBe(true);
  });

  it("searches only while the command palette is open and the term is long enough", async () => {
    const store = useCommandPaletteStore();
    store.setOpen(true);
    store.setSearchTerm(" x ");
    await Promise.resolve();
    expect(harness.calls).toHaveLength(0);

    store.setSearchTerm("  fix  ");
    await vi.waitFor(() => expect(harness.calls).toHaveLength(2));
    expect(harness.calls.map(({ url }) => url.pathname).sort()).toEqual(["/api/knowledge", "/api/sessions"]);
    expect(store.sessions).toEqual([]);
    expect(store.knowledge).toEqual([]);
    store.setOpen(false);
    expect(store.sessions).toEqual([]);
    expect(store.knowledge).toEqual([]);
  });

  it("treats individual search failures as empty results without failing the combined query", async () => {
    const store = useCommandPaletteStore();
    harness.setResponder(({ url }) => {
      if (url.pathname === "/api/sessions") {
        return {
          items: [{ id: "session-1", title: "Found" }],
          pageInfo: { page: 1, pageSize: 5, total: 1, totalPages: 1 },
        };
      }
      if (url.pathname === "/api/knowledge") return jsonResponse({ code: "service_unavailable" }, 503);
      return {};
    });
    store.setOpen(true);
    store.setSearchTerm("first");
    await vi.waitFor(() => expect(harness.calls).toHaveLength(2));
    expect(store.sessions).toHaveLength(1);
    expect(store.knowledge).toEqual([]);

    harness.setResponder(({ url }) =>
      url.pathname === "/api/sessions" || url.pathname === "/api/knowledge"
        ? jsonResponse({ code: "service_unavailable" }, 503)
        : shellResponder({ url, method: "GET", body: undefined, signal: undefined }),
    );
    store.setSearchTerm("second");
    await vi.waitFor(() => expect(harness.calls).toHaveLength(4));
    expect(store.sessions).toEqual([]);
    expect(store.knowledge).toEqual([]);
  });

  it("loads the dashboard overview, keeps the newest request per scope, and builds pending inbox items", async () => {
    const store = useDashboardStore();
    expect(store.dashboardLoading).toBe(false);
    await store.loadDashboardData();
    expect(harness.calls.map(({ url }) => url.pathname).sort()).toEqual([
      "/api/backfill/metadata-requests",
      "/api/reports",
      "/api/reports/synthesis-requests",
    ]);
    expect(store.weekReport).toBeNull();
    expect(store.weekVerification).toEqual({ total: 0, passed: 0, failed: 0, notRun: 0, notSupplied: 0 });
    expect(store.inbox.map(({ kind }) => kind)).toEqual(["synthesis", "synthesis", "backfill"]);
    expect(store.inbox[0]?.title).toContain("待 Agent 整理");
    expect(store.inbox[1]?.title).toContain("AI 整理未完成");
    expect(store.inbox[2]?.title).toContain("metadata");
  });

  it("keeps the dashboard usable when individual overview endpoints fail", async () => {
    const store = useDashboardStore();
    harness.setResponder(() => jsonResponse({ code: "service_unavailable", error: "offline" }, 503));
    await store.loadDashboardData();
    expect(harness.calls).toHaveLength(3);
    expect(store.weekReport).toBeNull();
    expect(store.inbox).toEqual([]);
  });

  it("maps system diagnostic state and stops its page query when the page closes", async () => {
    const store = useSystemStatusStore();
    expect(store.systemStatus).toBeNull();
    expect(store.databaseStatus.label).toBe("無法讀取");
    store.setSystemStatusActive(true);
    await store.refreshSystemStatus();
    expect(store.systemStatus?.database.state).toBe("missing");
    expect(store.databaseStatus.label).toBe("不存在");
    expect(harness.count("/api/system/status")).toBe(1);

    let aborted = false;
    store.setSystemStatusActive(false);
    await Promise.resolve();
    harness.setResponder(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    const refresh = store.refreshSystemStatus();
    await vi.waitFor(() => expect(harness.count("/api/system/status")).toBe(2));
    store.setSystemStatusActive(false);
    await refresh;
    await vi.waitFor(() => expect(aborted).toBe(true));

    systemStatusError = true;
    harness.setResponder(shellResponder);
    await store.refreshSystemStatus();
    expect(store.systemStatusError).toBe("服務暫時無法使用，請稍後再試。");
  });
});
