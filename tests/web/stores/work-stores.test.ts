import { useQueryCache } from "@pinia/colada";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreRequest } from "../helpers/store-harness.js";
import { createStoreHarness, jsonResponse } from "../helpers/store-harness.js";
import { useReportsStore } from "../../../apps/web/src/stores/reports.js";
import { useSessionsStore } from "../../../apps/web/src/stores/sessions.js";
import { t } from "../../../apps/web/src/i18n/index.js";

const toastMocks = vi.hoisted(() => ({ showToast: vi.fn() }));

vi.mock("../../../apps/web/src/composables/useToast", () => ({
  useToast: () => ({ showToast: toastMocks.showToast }),
}));

let harness: ReturnType<typeof createStoreHarness>;

function workResponder({ url, method }: StoreRequest): unknown {
  if (url.pathname === "/api/sessions" && method === "GET") {
    const page = Number(url.searchParams.get("page") ?? 1);
    const pageSize = Number(url.searchParams.get("pageSize") ?? 10);
    return {
      items: url.searchParams.has("q") ? [{ id: "source" }, { id: "candidate" }] : [],
      pageInfo: {
        page,
        pageSize,
        total: 0,
        totalPages: 1,
        from: 0,
        to: 0,
        hasPrevious: page > 1,
        hasNext: false,
      },
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
  it("keys Session list requests by every active filter and pagination value", async () => {
    const store = useSessionsStore();
    store.setSessionsListActive(true);
    await vi.waitFor(() => expect(harness.count("/api/sessions")).toBe(1));

    store.searchTerm = "  compiler  ";
    store.selectedProjectId = "project-1";
    store.dateFrom = "2026-09-01";
    store.dateTo = "2026-09-27";
    store.voidedFilter = "include";
    store.sessionPage = 2;
    store.sessionPageSize = 20;
    store.loadSessions();

    await vi.waitFor(() => expect(harness.count("/api/sessions")).toBe(2));
    const filteredRequest = harness.calls.filter(({ url }) => url.pathname === "/api/sessions")[1];
    expect(filteredRequest?.url.searchParams.get("q")).toBe("compiler");
    expect(filteredRequest?.url.searchParams.get("projectId")).toBe("project-1");
    expect(filteredRequest?.url.searchParams.get("from")).toBe("2026-09-01");
    expect(filteredRequest?.url.searchParams.get("to")).toBe("2026-09-27");
    expect(filteredRequest?.url.searchParams.get("voided")).toBe("include");
    expect(filteredRequest?.url.searchParams.get("page")).toBe("2");
    expect(filteredRequest?.url.searchParams.get("pageSize")).toBe("20");

    store.sessionPage = 3;
    await vi.waitFor(() => expect(harness.count("/api/sessions")).toBe(3));
    expect(harness.calls.filter(({ url }) => url.pathname === "/api/sessions")[2]?.url.searchParams.get("page")).toBe(
      "3",
    );
  });

  it("validates Session filters, loads the list, navigates details, and refreshes after a summary edit", async () => {
    const store = useSessionsStore();
    store.setSessionsListActive(true);
    store.dateFrom = "2026-09-10";
    store.dateTo = "2026-09-01";
    expect(store.hasSessionFilters).toBe(true);
    await store.loadSessions();
    expect(store.sessionFilterError).toBe(t("session.theStartDateMustBe"));
    expect(harness.count("/api/sessions")).toBe(0);

    store.clearSessionFilters();
    await store.loadSessions();
    await vi.waitFor(() => expect(store.sessionsLoaded).toBe(true));
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

  it("keeps a successful Session save successful when a background refresh is aborted", async () => {
    const store = useSessionsStore();
    vi.spyOn(useQueryCache(), "invalidateQueries").mockRejectedValue(new DOMException("aborted", "AbortError"));
    await expect(
      store.saveSessionEdits({ sessionId: "session-1", summary: { idempotencyKey: "edit", value: "Updated" } }),
    ).resolves.toBeUndefined();
    expect(harness.count("/api/sessions/session-1/summary", "PATCH")).toBe(1);
  });

  it("keeps successful void and link writes successful when their read refresh is aborted", async () => {
    const store = useSessionsStore();
    vi.spyOn(useQueryCache(), "invalidateQueries").mockRejectedValue(new DOMException("aborted", "AbortError"));
    await expect(store.setSessionVoid({ sessionId: "session-1", voided: true } as never)).resolves.toMatchObject({
      outcome: "session_void_updated",
    });
    await expect(
      store.linkSessions({ sessionId: "session-1", relatedSessionId: "session-2", relation: "related" }),
    ).resolves.toMatchObject({ outcome: "session_link_updated" });
    expect(harness.count("/api/sessions/session-1/void", "PATCH")).toBe(1);
    expect(harness.count("/api/sessions/session-1/links", "POST")).toBe(1);
  });

  it("maps a report API error and blocks incomplete or oversized custom ranges before fetching", async () => {
    const store = useReportsStore();
    store.reportPeriod = "custom";
    store.reportRange = { from: "", to: "" };
    await store.loadReport();
    expect(store.reportError).toBe(t("reports.chooseTheStartAndEnd"));
    expect(harness.count("/api/reports")).toBe(0);

    store.reportRange = { from: "2025-01-01", to: "2026-09-27" };
    await store.loadReport();
    expect(store.reportError).toBe(t("reports.aCustomRangeCanSpan", { days: 366 }));
    expect(harness.count("/api/reports")).toBe(0);

    store.reportPeriod = "week";
    harness.setResponder(({ url }) =>
      url.pathname === "/api/reports"
        ? jsonResponse({ code: "service_unavailable", error: "English detail" }, 503)
        : workResponder({ url, method: "GET", body: undefined, signal: undefined }),
    );
    store.loadReport();
    await vi.waitFor(() => expect(store.reportError).toBe(t("format.theServiceIsTemporarilyUnavailable")));
    expect(store.reportError).toBe(t("format.theServiceIsTemporarilyUnavailable"));
    expect(store.report).toBeNull();
    expect(store.reportComparisons).toEqual([]);
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
    expect(toastMocks.showToast).toHaveBeenLastCalledWith(t("format.theRequestedDataWasNot"), "danger");
  });
});
