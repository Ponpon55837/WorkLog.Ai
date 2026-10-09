import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreRequest } from "../helpers/store-harness.js";
import { createStoreHarness, jsonResponse } from "../helpers/store-harness.js";
import { useAppStore } from "../../../apps/web/src/stores/app.js";
import { useCommandPaletteStore } from "../../../apps/web/src/stores/command-palette.js";
import { useDashboardStore } from "../../../apps/web/src/stores/dashboard.js";
import { useSystemStatusStore } from "../../../apps/web/src/stores/system-status.js";
import { t } from "../../../apps/web/src/i18n/index.js";

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
  if (url.pathname === "/api/attention")
    return {
      outcome: "attention",
      items: [
        { id: "one", kind: "synthesis" },
        { id: "two", kind: "decision" },
      ],
      groups: [{ kind: "decision", state: "complete", total: 7 }],
      total: 7,
      minimumTotal: 7,
      pageInfo: { total: 2 },
    };
  if (url.pathname === "/api/system/status") {
    return systemStatusError
      ? jsonResponse({ code: "service_unavailable", error: "English" }, 503)
      : {
          database: { state: "missing" },
          mcp: {
            restartRequired: false,
            monitoringAvailable: true,
            activeProcesses: 0,
            outdatedProcesses: 0,
            updateAvailableProcesses: 0,
            message: "尚無可監測的 MCP 連線。",
          },
        };
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

    harness.setResponder(({ url }) =>
      url.pathname === "/api/health"
        ? jsonResponse({ code: "service_unavailable", error: "temporary" }, 503)
        : shellResponder({ url, method: "GET", body: undefined, signal: undefined }),
    );
    await expect(store.loadHealth()).rejects.toMatchObject({ code: "service_unavailable" });
    expect(store.appHealthError).toBe(t("format.theServiceIsTemporarilyUnavailable"));

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
    store.abortPendingRequests();
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

  it("loads the full report and unfiltered aggregate count independently", async () => {
    const store = useDashboardStore();
    expect(store.attentionLoaded).toBe(false);
    expect(store.attentionCount).toBeUndefined();
    await store.loadDashboardData();
    expect(harness.calls.map(({ url }) => url.pathname).sort()).toEqual(["/api/attention", "/api/reports"]);
    expect(harness.calls.find(({ url }) => url.pathname === "/api/reports")?.url.searchParams.has("date")).toBe(false);
    expect(store.weekReport).toBeNull();
    expect(store.attentionCount).toBe(7);
    expect(store.inbox).toHaveLength(2);
    expect(store.attentionComplete).toBe(true);
    expect(store.weekVerification).toEqual({
      total: 0,
      passed: 0,
      failed: 0,
      inProgress: 0,
      notRun: 0,
      notSupplied: 0,
    });
  });

  it("does not turn failed overview requests into a healthy empty queue", async () => {
    const store = useDashboardStore();
    harness.setResponder(() => jsonResponse({ code: "service_unavailable", error: "offline" }, 503));
    await store.loadDashboardData();
    expect(harness.calls).toHaveLength(2);
    expect(store.weekReportFailed).toBe(true);
    expect(store.attentionCount).toBeUndefined();
    expect(store.attentionFailed).toBe(true);
    expect(store.attentionLoaded).toBe(false);
    expect(store.attentionComplete).toBe(false);
  });

  it("maps system diagnostic state and stops its page query when the page closes", async () => {
    const store = useSystemStatusStore();
    expect(store.systemStatus).toBeNull();
    expect(store.databaseStatus.label).toBe(t("status.unreadable"));
    store.setSystemStatusActive(true);
    await store.refreshSystemStatus();
    expect(store.systemStatus?.database.state).toBe("missing");
    expect(store.systemStatus?.mcp.monitoringAvailable).toBe(true);
    expect(store.databaseStatus.label).toBe(t("status.missing"));
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
    expect(store.systemStatusError).toBe(t("format.theServiceIsTemporarilyUnavailable"));
  });
});
