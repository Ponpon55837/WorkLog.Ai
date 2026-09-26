import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreRequest } from "../helpers/store-harness.js";
import { createStoreHarness, jsonResponse } from "../helpers/store-harness.js";
import { useReportsStore } from "../../../apps/web/src/stores/reports.js";
import { useSessionsStore } from "../../../apps/web/src/stores/sessions.js";

const toastMocks = vi.hoisted(() => ({ showToast: vi.fn() }));

vi.mock("../../../apps/web/src/composables/useToast", () => ({
  useToast: () => ({ showToast: toastMocks.showToast }),
}));

let harness: ReturnType<typeof createStoreHarness>;

function workResponder({ url, method }: StoreRequest): unknown {
  if (url.pathname === "/api/sessions" && method === "GET") {
    return {
      items: url.searchParams.has("q") ? [{ id: "source" }, { id: "candidate" }] : [],
      pageInfo: { page: 1, pageSize: 10, total: 0, totalPages: 1, from: 0, to: 0, hasPrevious: false, hasNext: false },
    };
  }
  if (url.pathname === "/api/sessions/bad") return jsonResponse({ code: "not_found", error: "English" }, 404);
  if (url.pathname === "/api/sessions/session-1") return { session: { id: "session-1", title: "First" } };
  if (url.pathname === "/api/sessions/session-2") return { session: { id: "session-2", title: "Second" } };
  if (url.pathname === "/api/sessions/session-1/summary" && method === "PATCH") {
    return { outcome: "summary_updated", duplicate: false, session: { id: "session-1" }, idempotencyKey: "edit" };
  }
  if (url.pathname === "/api/sessions/session-1/work-summary") {
    return {
      outcome: "work_summary_updated",
      duplicate: false,
      session: { id: "session-1" },
      idempotencyKey: "sections",
      mode: "patch",
      appliedWorkSummary: {},
    };
  }
  if (url.pathname === "/api/sessions/session-1/verification") return { outcome: "updated", sessionId: "session-1" };
  if (url.pathname === "/api/sessions/session-1/links") return { outcome: "session_link_updated", action: "linked" };
  if (url.pathname === "/api/sessions/session-1/links/session-2")
    return { outcome: "session_link_updated", action: "unlinked" };
  if (url.pathname === "/api/sessions/session-1/void")
    return { outcome: "session_void_updated", sessionId: "session-1", voided: true };
  if (url.pathname === "/api/evidence/evidence-1/void")
    return { outcome: "evidence_void_updated", evidenceId: "evidence-1" };
  if (url.pathname === "/api/reports") return { outcome: "skipped", reason: "這段期間沒有工作紀錄。" };
  return {};
}

beforeEach(() => {
  harness = createStoreHarness(workResponder);
  toastMocks.showToast.mockClear();
});

afterEach(async () => harness.cleanup());

describe("work data stores", () => {
  it("validates Session filters, loads the list, navigates details, and refreshes after a summary edit", async () => {
    const store = useSessionsStore();
    store.setSessionsListActive(true);
    store.dateFrom = "2026-09-10";
    store.dateTo = "2026-09-01";
    expect(store.hasSessionFilters).toBe(true);
    await store.loadSessions();
    expect(store.sessionFilterError).toBe("起始日期必須早於或等於結束日期。");
    expect(harness.count("/api/sessions")).toBe(0);

    store.clearSessionFilters();
    await store.loadSessions();
    expect(store.sessionsLoaded).toBe(true);
    expect(harness.count("/api/sessions")).toBe(1);
    store.setSessionSequence(["session-1", "session-2"]);
    await store.openSessionDetail("session-1");
    expect(store.position).toEqual({ index: 0, total: 2 });
    store.openAdjacentSession(1);
    await vi.waitFor(() => expect(store.selectedDetail?.session.id).toBe("session-2"));

    await store.saveSessionEdits({ sessionId: "session-1", summary: { idempotencyKey: "edit", value: "Updated" } });
    await vi.waitFor(() => expect(harness.count("/api/sessions")).toBeGreaterThan(1));
    expect(harness.count("/api/sessions/session-1/summary", "PATCH")).toBe(1);
    store.closeSessionDetail();
    expect(store.selectedDetail).toBeNull();
  });

  it("maps a report API error and blocks incomplete or oversized custom ranges before fetching", async () => {
    const store = useReportsStore();
    store.reportPeriod = "custom";
    store.reportRange = { from: "", to: "" };
    await store.loadReport();
    expect(store.reportError).toBe("請選擇自訂期間的起訖日期。");
    expect(harness.count("/api/reports")).toBe(0);

    store.reportRange = { from: "2025-01-01", to: "2026-09-27" };
    await store.loadReport();
    expect(store.reportError).toBe("自訂期間最長 366 天。");
    expect(harness.count("/api/reports")).toBe(0);

    store.reportPeriod = "week";
    harness.setResponder(({ url }) =>
      url.pathname === "/api/reports"
        ? jsonResponse({ code: "service_unavailable", error: "English detail" }, 503)
        : workResponder({ url, method: "GET", body: undefined, signal: undefined }),
    );
    await store.loadReport();
    expect(store.reportError).toBe("服務暫時無法使用，請稍後再試。");
    expect(store.report).toBeNull();
    expect(store.reportComparisons).toEqual([]);
    await store.loadReportSessions();
    await store.loadReportEvidence();
    await store.loadReportSynthesis();
    expect(harness.count("/api/sessions")).toBe(0);
  });

  it("loads link candidates, saves all editor sections, updates void state, and restores the prior detail on failure", async () => {
    const store = useSessionsStore();
    await store.loadSessions();
    store.openLinkCandidates("source", " candidate ");
    await vi.waitFor(() => expect(store.linkCandidates).toHaveLength(1));
    expect(store.linkCandidates[0]?.id).toBe("candidate");
    store.searchLinkCandidates("updated");
    await vi.waitFor(() =>
      expect(harness.calls.filter(({ url }) => url.pathname === "/api/sessions").length).toBeGreaterThan(2),
    );
    store.closeLinkCandidates();
    expect(store.linkCandidates).toEqual([]);

    await store.saveSessionEdits({
      sessionId: "session-1",
      summary: { idempotencyKey: "edit", value: "Updated" },
      workSummary: { idempotencyKey: "sections", sections: { outcomes: ["Outcome"] } },
      verification: { status: "passed" } as never,
    });
    expect(harness.count("/api/sessions/session-1/work-summary", "PATCH")).toBe(1);
    expect(harness.count("/api/sessions/session-1/verification", "PATCH")).toBe(1);
    await store.linkSessions({ sessionId: "session-1", relatedSessionId: "session-2", relation: "related" });
    await store.unlinkSessions({ sessionId: "session-1", relatedSessionId: "session-2" });
    await store.setSessionVoid({ sessionId: "session-1", voided: true } as never);
    await store.setEvidenceVoid({ sessionId: "session-1", evidenceId: "evidence-1", voided: true } as never);
    expect(harness.count("/api/sessions/session-1/links", "POST")).toBe(1);
    expect(harness.count("/api/sessions/session-1/links/session-2", "DELETE")).toBe(1);

    await store.openSessionDetail("session-1");
    await store.openSessionDetail("bad");
    expect(store.selectedDetail?.session.id).toBe("session-1");
    expect(toastMocks.showToast).toHaveBeenLastCalledWith("找不到請求的資料，請重新整理後再試。", "danger");
  });
});
