import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../../apps/web/src/api/client.js";

type RecordedRequest = { url: URL; method: string; body: unknown };

function recordRequests() {
  const calls: RecordedRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: new URL(String(input)),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return new Response(JSON.stringify({ outcome: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("domain API factories", () => {
  it("routes each domain method through the shared transport with encoded paths and query options", async () => {
    const calls = recordRequests();
    const api = createApiClient("http://api.test");

    await api.listBackups();
    await api.createBackup();
    await api.deleteBackup("backup 1.sqlite");
    await api.exportDatabase();

    await api.exportProjectData({ type: "all" });
    await api.exportProjectData({ type: "project", projectId: "project-1" });
    await api.previewProjectDataImport({} as never);
    await api.importProjectData({} as never);
    await api.getDashboard();
    await api.listProjects();
    await api.listProjectDeletionAudits();
    await api.createProject({ name: "A", rootPath: "/a" });
    await api.updateProject("project/1", { status: "tracked" });
    await api.deleteProject("project/1", "A");

    await api.listSessions({ q: "two words", voided: "only", page: 2, pageSize: "all" });
    await api.getSessionDetail("session/1");
    await api.updateSessionVerification("session/1", { status: "passed" });
    await api.linkSession("session/1", "session/2", "related");
    await api.unlinkSession("session/1", "session/2");
    await api.setSessionVoid({ sessionId: "session/1", voided: true, reason: "duplicate" } as never);
    await api.setEvidenceVoid({ evidenceId: "evidence/1", voided: true, reason: "duplicate" } as never);
    await api.updateSessionSummary({
      sessionId: "session/1",
      idempotencyKey: "summary",
      mode: "replace",
      summary: "x",
    });
    await api.updateSessionWorkSummary({
      sessionId: "session/1",
      idempotencyKey: "sections",
      mode: "patch",
      workSummary: {},
    });

    await api.getReport({ period: "week", evidencePageSize: "all", evidenceQuery: "fix" });
    await api.listReportSynthesisRequests({ period: "week", scopeType: "all", limit: 10 });
    await api.listReportSummaries({ period: "week", currentOnly: false });
    await api.createReportSynthesisRequest({ period: "week", idempotencyKey: "create" });
    await api.retryReportSynthesisRequest("request/1");
    await api.cancelReportSynthesisRequest("request/1");
    await api.deleteReportSummary("summary/1");
    await api.exportReport({ period: "month", format: "json", evidencePageSize: "all" });

    await api.listKnowledgeCandidates("/projects/a");
    await api.requestKnowledgeCandidates("/projects/a");
    await api.decideKnowledgeCandidate({ candidateId: "candidate/1", decision: "reject" } as never);
    await api.searchKnowledge({ query: "search", pageSize: "all" });
    await api.getKnowledgeHistory("knowledge/1", { projectRoot: "/projects/a" });
    await api.updateKnowledge("knowledge/1", { title: "Updated" } as never);
    await api.listSessionDecisions({ projectRoot: "/projects/a", status: "all", limit: 17 });
    await api.reviewSessionDecision({
      decisionId: "decision/1",
      projectRoot: "/projects/a",
      reviewStatus: "confirmed",
    });
    await api.listKnowledgePages("/projects/a");
    await api.requestKnowledgePageUpdate({ projectRoot: "/projects/a", slug: "pitfalls" });
    await api.updateKnowledgePage({
      pageId: "page/1",
      sections: [{ heading: "H", content: "資料不足", sourceSessionIds: [] }],
    });
    await api.listKnowledgePageVersions("page/1");

    await api.listMetadataBackfillRequests();
    await api.createMetadataBackfillRequest("project/1");
    await api.cancelMetadataBackfillRequest("request/1");
    await api.previewMetadataBackfill(12);
    await api.getGraph({ projectId: "project/1", maxNodes: 180, cursor: "next" });
    await api.getHotspots({ projectId: "project/1", groupBy: "directory", from: "2026-01-01", limit: 5 });
    await api.setDiagramVoid({ diagramId: "diagram/1", voided: true, reason: "Wrong" });
    await api.getTimeline({ projectId: "project/1", from: "2026-01-01", to: "2026-01-31" });
    await api.getGraphPath({ projectId: "project/1", from: "session:a", to: "file:p:b", includeDerived: true });
    await api.previewHandoffs("/projects/a", ".handoffs");
    await api.importHandoffs({ projectRoot: "/projects/a", handoffDirectory: ".handoffs", sourcePaths: ["one.md"] });
    await api.getHealth();
    await api.getSystemStatus();
    await api.pickFolder();

    expect(calls).toHaveLength(57);
    expect(calls.find((call) => call.url.pathname === "/api/backups/backup%201.sqlite")).toMatchObject({
      method: "DELETE",
      body: {},
    });
    expect(calls.find((call) => call.url.pathname === "/api/sessions")).toMatchObject({
      url: expect.objectContaining({ searchParams: expect.any(URLSearchParams) }),
    });
    const sessionList = calls.find((call) => call.url.pathname === "/api/sessions");
    expect(sessionList?.url.searchParams.get("pageSize")).toBe("0");
    expect(sessionList?.url.searchParams.get("voided")).toBe("only");
    expect(calls.find((call) => call.url.pathname === "/api/reports")).toBeDefined();
    expect(calls.find((call) => call.url.pathname === "/api/knowledge/knowledge%2F1")).toMatchObject({
      method: "PATCH",
      body: { knowledgeId: "knowledge/1", title: "Updated" },
    });
    const decisionList = calls.find((call) => call.url.pathname === "/api/session-decisions");
    expect(decisionList?.url.searchParams.get("projectRoot")).toBe("/projects/a");
    expect(decisionList?.url.searchParams.get("status")).toBe("all");
    expect(decisionList?.url.searchParams.get("limit")).toBe("17");
    expect(calls.find((call) => call.url.pathname === "/api/session-decisions/decision%2F1/review")).toMatchObject({
      method: "PATCH",
      body: { projectRoot: "/projects/a", reviewStatus: "confirmed" },
    });
    expect(
      calls.find((call) => call.url.pathname === "/api/knowledge-pages")?.url.searchParams.get("projectRoot"),
    ).toBe("/projects/a");
    expect(calls.find((call) => call.url.pathname === "/api/knowledge-pages/update-requests")).toMatchObject({
      method: "POST",
      body: { projectRoot: "/projects/a", slug: "pitfalls" },
    });
    expect(calls.find((call) => call.url.pathname === "/api/knowledge-pages/page%2F1")).toMatchObject({
      method: "PATCH",
      body: { sections: [{ heading: "H" }] },
    });
    expect(calls.find((call) => call.url.pathname === "/api/knowledge-pages/page%2F1/versions")).toBeDefined();
    expect(
      Object.fromEntries(calls.find((call) => call.url.pathname === "/api/graph/path")?.url.searchParams ?? []),
    ).toEqual({ projectId: "project/1", from: "session:a", to: "file:p:b", includeDerived: "true" });
    expect(
      Object.fromEntries(calls.find((call) => call.url.pathname === "/api/insights/timeline")?.url.searchParams ?? []),
    ).toEqual({ projectId: "project/1", from: "2026-01-01", to: "2026-01-31" });
    expect(calls.find((call) => call.url.pathname === "/api/diagrams/diagram%2F1/void")).toMatchObject({
      method: "PATCH",
      body: { voided: true, reason: "Wrong" },
    });
    const hotspots = calls.find((call) => call.url.pathname === "/api/insights/hotspots");
    expect(Object.fromEntries(hotspots?.url.searchParams ?? [])).toEqual({
      projectId: "project/1",
      groupBy: "directory",
      from: "2026-01-01",
      limit: "5",
    });
    expect(calls.find((call) => call.url.pathname === "/api/imports/handoffs")).toMatchObject({ method: "POST" });
  });
});
