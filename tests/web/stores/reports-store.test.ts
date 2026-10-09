import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreRequest } from "../helpers/store-harness.js";
import { createStoreHarness } from "../helpers/store-harness.js";
import { useReportsStore } from "../../../apps/web/src/stores/reports.js";
import { t } from "../../../apps/web/src/i18n/index.js";

const mocks = vi.hoisted(() => ({ showToast: vi.fn(), confirmAction: vi.fn(async () => true) }));
vi.mock("../../../apps/web/src/composables/useToast", () => ({ useToast: () => ({ showToast: mocks.showToast }) }));
vi.mock("../../../apps/web/src/composables/useConfirm", () => ({ confirmAction: mocks.confirmAction }));

let harness: ReturnType<typeof createStoreHarness>;
let requestStatus: string;
let exportStatus: "success" | "skipped";

const report = {
  outcome: "report",
  period: "week",
  range: { from: "2026-09-21", to: "2026-09-27" },
  totals: {
    sessions: 2,
    events: 3,
    changedFiles: 4,
    changedFilesOversizedSessions: 2,
    verification: { passed: 1, failed: 0, in_progress: 0, not_run: 1, not_supplied: 0 },
  },
  comparison: {
    sessions: { current: 2, previous: 1, difference: 1, percent: 100 },
    events: { current: 3, previous: 2, difference: 1, percent: 50 },
    changedFiles: { current: 4, previous: 3, difference: 1, percent: 33 },
  },
  evidence: [{ id: "evidence-1", kind: "event", reference: "event-1" }],
  evidencePageInfo: {
    page: 1,
    pageSize: 10,
    total: 1,
    totalPages: 1,
    from: 1,
    to: 1,
    hasPrevious: false,
    hasNext: false,
  },
};

const synthesisRequest = () => ({
  id: "request-1",
  status: requestStatus,
  period: "week",
  range: { from: "2026-09-21", to: "2026-09-27" },
  sourceSessionIds: ["session-1"],
});

function reportResponder({ url, method }: StoreRequest): unknown {
  if (url.pathname === "/api/reports" && method === "GET") {
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    return { ...report, range: from && to ? { from, to } : report.range };
  }
  if (url.pathname === "/api/sessions") {
    const page = Number(url.searchParams.get("page") ?? 1);
    const pageSize = Number(url.searchParams.get("pageSize") ?? 10);
    return {
      items: [{ id: "session-1", title: "Session" }],
      pageInfo: {
        page,
        pageSize,
        total: 1,
        totalPages: 1,
        from: 1,
        to: 1,
        hasPrevious: page > 1,
        hasNext: false,
      },
    };
  }
  if (url.pathname === "/api/reports/synthesis-requests" && method === "GET") {
    return { outcome: "report_synthesis_requests", requests: [synthesisRequest()] };
  }
  if (url.pathname === "/api/reports/summaries" && method === "GET") {
    return {
      outcome: "report_summaries",
      summaries: [
        { id: "current", title: "Current", isCurrent: true },
        { id: "old", title: "Older", isCurrent: false },
      ],
    };
  }
  if (url.pathname === "/api/reports/synthesis-requests" && method === "POST") {
    return { outcome: "report_synthesis_request", request: synthesisRequest(), duplicate: false };
  }
  if (url.pathname.endsWith("/retry")) {
    requestStatus = "processing";
    return { outcome: "report_synthesis_request_retried", request: synthesisRequest() };
  }
  if (url.pathname.endsWith("/cancel")) {
    requestStatus = "cancelled";
    return { outcome: "report_synthesis_request_cancelled", request: synthesisRequest() };
  }
  if (url.pathname === "/api/reports/summaries/old" && method === "DELETE") {
    return { outcome: "report_summary_deleted", summaryId: "old" };
  }
  if (url.pathname === "/api/reports/export") {
    return exportStatus === "success"
      ? { outcome: "report_export", filename: "report.md", contentType: "text/markdown", content: "# Report" }
      : { outcome: "skipped", reason: "報告無法匯出。" };
  }
  return {};
}

beforeEach(() => {
  requestStatus = "failed";
  exportStatus = "success";
  harness = createStoreHarness(reportResponder);
  mocks.showToast.mockClear();
  mocks.confirmAction.mockReset().mockResolvedValue(true);
});

afterEach(async () => {
  await harness.cleanup();
  vi.restoreAllMocks();
});

describe("reports store", () => {
  it("keys report, evidence, and source Session queries by their complete scopes", async () => {
    const store = useReportsStore();
    store.reportDate = "2026-09-24";
    store.loadReport();
    await vi.waitFor(() => expect(harness.count("/api/reports")).toBe(1));
    await vi.waitFor(() => expect(harness.count("/api/sessions")).toBe(1));

    store.reportProjectId = "project-1";
    store.loadReport();
    await vi.waitFor(() => expect(harness.count("/api/reports")).toBe(2));
    const projectReport = harness.calls.filter(({ url }) => url.pathname === "/api/reports")[1];
    expect(projectReport?.url.searchParams.get("period")).toBe("week");
    expect(projectReport?.url.searchParams.get("date")).toBe("2026-09-24");
    expect(projectReport?.url.searchParams.get("projectId")).toBe("project-1");

    store.reportPeriod = "custom";
    store.reportRange = { from: "2026-09-01", to: "2026-09-07" };
    store.loadReport();
    await vi.waitFor(() => expect(harness.count("/api/reports")).toBe(3));
    const customReport = harness.calls.filter(({ url }) => url.pathname === "/api/reports")[2];
    expect(customReport?.url.searchParams.get("from")).toBe("2026-09-01");
    expect(customReport?.url.searchParams.get("to")).toBe("2026-09-07");
    expect(customReport?.url.searchParams.get("projectId")).toBe("project-1");
    await vi.waitFor(() => expect(harness.count("/api/reports/synthesis-requests")).toBe(3));
    const synthesisRequest = harness.calls
      .filter(({ url, method }) => url.pathname === "/api/reports/synthesis-requests" && method === "GET")
      .at(-1);
    expect(synthesisRequest?.url.searchParams.get("period")).toBe("custom");
    expect(synthesisRequest?.url.searchParams.get("from")).toBe("2026-09-01");
    expect(synthesisRequest?.url.searchParams.get("to")).toBe("2026-09-07");
    expect(synthesisRequest?.url.searchParams.get("projectId")).toBe("project-1");

    store.reportEvidencePage = 2;
    store.reportEvidencePageSize = 20;
    store.reportEvidenceKind = "event";
    store.reportEvidenceQuery = " build ";
    store.loadReportEvidence();
    await vi.waitFor(() => expect(harness.count("/api/reports")).toBe(4));
    const evidenceRequest = harness.calls.filter(({ url }) => url.pathname === "/api/reports")[3];
    expect(evidenceRequest?.url.searchParams.get("from")).toBe("2026-09-01");
    expect(evidenceRequest?.url.searchParams.get("to")).toBe("2026-09-07");
    expect(evidenceRequest?.url.searchParams.get("projectId")).toBe("project-1");
    expect(evidenceRequest?.url.searchParams.get("evidencePage")).toBe("2");
    expect(evidenceRequest?.url.searchParams.get("evidencePageSize")).toBe("20");
    expect(evidenceRequest?.url.searchParams.get("evidenceKind")).toBe("event");
    expect(evidenceRequest?.url.searchParams.get("evidenceQuery")).toBe("build");

    store.reportSessionPage = 2;
    store.reportSessionPageSize = 20;
    await vi.waitFor(() => expect(harness.count("/api/sessions")).toBeGreaterThan(2));
    const sourceSessions = harness.calls.filter(({ url }) => url.pathname === "/api/sessions").at(-1);
    expect(sourceSessions?.url.searchParams.get("from")).toBe("2026-09-01");
    expect(sourceSessions?.url.searchParams.get("to")).toBe("2026-09-07");
    expect(sourceSessions?.url.searchParams.get("projectId")).toBe("project-1");
    expect(sourceSessions?.url.searchParams.get("page")).toBe("2");
    expect(sourceSessions?.url.searchParams.get("pageSize")).toBe("20");
  });

  it("loads report, source sessions, evidence, and synthesis history and invalidates after mutations", async () => {
    const store = useReportsStore();
    store.loadReport();
    await vi.waitFor(() => expect(store.report?.range).toEqual(report.range));
    await vi.waitFor(() => expect(store.reportSessionItems).toHaveLength(1));
    await vi.waitFor(() => expect(store.reportSynthesisRequest?.id).toBe("request-1"));
    expect(store.report?.range).toEqual(report.range);
    expect(store.reportComparisons).toHaveLength(3);
    expect(store.reportComparisons[2]?.foot).toBe(t("common.notTheSameAsGitOversized", { count: 2 }));
    expect(store.reportSessionItems).toHaveLength(1);
    expect(store.reportSynthesisRequest?.id).toBe("request-1");
    expect(store.reportSynthesisCanRetry).toBe(true);
    expect(store.reportSynthesisSummary?.id).toBe("current");

    await store.loadReportEvidence();
    await vi.waitFor(() => expect(store.report?.evidence).toEqual(report.evidence));
    await vi.waitFor(() => expect(harness.count("/api/reports")).toBe(2));
    await store.loadReportSynthesis();
    await store.refreshReportSynthesis();
    store.selectReportSynthesisVersion({ id: "old", title: "Older", isCurrent: false } as never);
    expect(store.reportSynthesisSummary?.id).toBe("old");

    await store.createReportSynthesisRequest();
    expect(harness.count("/api/reports/synthesis-requests", "POST")).toBe(1);
    await vi.waitFor(() => expect(harness.count("/api/reports/synthesis-requests")).toBeGreaterThan(1));
    await store.retryReportSynthesisRequest();
    expect(store.reportSynthesisCanRetry).toBe(false);
    expect(store.reportSynthesisIsActive).toBe(true);
    await store.cancelReportSynthesisRequest();
    expect(store.reportSynthesisCanRetry).toBe(true);
    expect(mocks.confirmAction).toHaveBeenCalledOnce();

    await store.deleteReportSynthesisVersion({ id: "current", title: "Current", isCurrent: true } as never);
    expect(harness.count("/api/reports/summaries/current", "DELETE")).toBe(0);
    await store.deleteReportSynthesisVersion({ id: "old", title: "Older", isCurrent: false } as never);
    expect(harness.count("/api/reports/summaries/old", "DELETE")).toBe(1);
  });

  it("exports the selected report and presents an API-level skipped response", async () => {
    const anchor = { href: "", download: "", style: { display: "" }, click: vi.fn(), remove: vi.fn() };
    vi.stubGlobal("document", { body: { append: vi.fn() }, createElement: vi.fn(() => anchor) });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:report");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const store = useReportsStore();
    store.loadReport();
    await vi.waitFor(() => expect(store.report).not.toBeNull());
    await store.exportReport("markdown");
    expect(anchor.download).toBe("report.md");
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(store.reportExportLoading).toBeNull();
    expect(mocks.showToast).toHaveBeenCalledWith(t("reports.downloadedTheReport", { format: "Markdown" }));

    exportStatus = "skipped";
    await store.exportReport("json");
    expect(mocks.showToast).toHaveBeenCalledWith("報告無法匯出。");
  });

  it("does not run export without a report and respects declined cancellation confirmations", async () => {
    const empty = useReportsStore();
    await empty.exportReport("json");
    expect(mocks.showToast).toHaveBeenCalledWith(t("reports.loadAReportBeforeExporting"));
    empty.loadReport();
    await vi.waitFor(() => expect(empty.report).not.toBeNull());

    requestStatus = "pending";
    await empty.loadReportSynthesis();
    mocks.confirmAction.mockResolvedValueOnce(false);
    await empty.cancelReportSynthesisRequest();
    expect(harness.count("/api/reports/synthesis-requests/request-1/cancel", "POST")).toBe(0);
  });
});
