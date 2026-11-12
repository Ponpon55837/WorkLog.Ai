import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { toAgentReport, toAgentReportContext } from "../../packages/storage/src/report-agent-view.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only. Storage tests run with TZ=UTC.
const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup(sessionCount: number, summary = "Tended the hives.") {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-agent-view-"));
  tempDirs.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject("Apiary", root);
  store.updateProject(project.id, { status: "tracked" });
  for (let index = 0; index < sessionCount; index++) {
    store.finalizeSession({
      projectRoot: root,
      idempotencyKey: `session-${index}`,
      title: `${"T".repeat(index === 0 ? 130 : 5)}-${index}`,
      summary: index === 0 ? summary.padEnd(300, "s") : summary,
      verification: { status: "passed" },
      completedAt: `2030-01-10T00:${String(index).padStart(2, "0")}:00.000Z`,
    });
  }
  return store;
}

describe("Agent report projection", () => {
  it("passes non-report outcomes through unchanged", () => {
    const store = setup(0);
    const result = store.getReport({ period: "week", date: "2030-01-10", projectId: "missing-project" });
    expect(result.outcome).not.toBe("report");
    expect(toAgentReport(result)).toBe(result);
  });

  it("previews sessions with truncation markers and drops the full completed work", () => {
    const store = setup(3);
    const report = store.getReport({ period: "week", date: "2030-01-10" });
    const view = toAgentReport(report);
    if (view.outcome !== "report") throw new Error("Expected a report");

    expect(view).not.toHaveProperty("completedWork");
    expect(view.projection).toMatchObject({ view: "agent", previewOnly: true, maxCharacters: 24_000 });
    expect(view.sessions).toHaveLength(3);
    const truncated = view.sessions.find((session) => session.title.length === 120);
    expect(truncated?.truncatedFields).toEqual(["title", "summary"]);
    expect(truncated?.summary).toHaveLength(240);
    expect(view.sessions.find((session) => session.title.length < 120)?.truncatedFields).toEqual([]);
    expect(view.sourceSessionIds).toEqual(view.sessions.map((session) => session.id));
  });

  it("pages sessions, clamps the page and page size, and clamps the character budget", () => {
    const store = setup(5);
    const report = store.getReport({ period: "week", date: "2030-01-10" });

    const second = toAgentReport(report, { maxSessions: 2, sessionPage: 2, maxCharacters: 1 });
    if (second.outcome !== "report") throw new Error("Expected a report");
    expect(second.sourcePageInfo).toMatchObject({
      page: 2,
      pageSize: 2,
      total: 5,
      totalPages: 3,
      from: 3,
      to: 4,
      hasPrevious: true,
      hasNext: true,
    });
    expect(second.projection.maxCharacters).toBe(12_000);

    const clamped = toAgentReport(report, { maxSessions: 0, sessionPage: 99, maxCharacters: 999_999 });
    if (clamped.outcome !== "report") throw new Error("Expected a report");
    expect(clamped.sourcePageInfo).toMatchObject({ page: 5, pageSize: 1, hasNext: false });
    expect(clamped.projection.maxCharacters).toBe(60_000);
  });

  it("removes whole items, never cuts text, and records what the budget omitted", () => {
    const store = setup(60, "x".repeat(200));
    const report = store.getReport({ period: "week", date: "2030-01-10" });
    const view = toAgentReport(report, { maxSessions: 100, maxCharacters: 12_000 });
    if (view.outcome !== "report") throw new Error("Expected a report");

    expect(JSON.stringify(view).length).toBeLessThanOrEqual(12_000);
    const omitted = view.projection.budgetOmitted.sessions ?? 0;
    expect(omitted).toBeGreaterThan(0);
    expect(view.sessions.length + omitted).toBe(60);
    expect(view.sourceSessionIds).toEqual(view.sessions.map((session) => session.id));
    expect(view.projection.sourceSessionIdsOmitted).toHaveLength(Math.min(5, omitted));
    expect(view.projection.moreSourceSessionIdsOmitted).toBe(Math.max(0, omitted - 5));
    for (const session of view.sessions.filter((item) => item.title.length < 120)) {
      expect(session.summary).toBe("x".repeat(200));
    }
  });

  it("builds an Agent context without source id lists and passes other outcomes through", () => {
    const store = setup(3);
    const created = store.createReportSynthesisRequest({
      period: "week",
      date: "2030-01-10",
      idempotencyKey: "agent-view-context",
    });
    if (created.outcome !== "report_synthesis_request") throw new Error("Expected a request");
    const context = store.getReportSynthesisContext({ requestId: created.request.id, maxSessions: 20 });
    const view = toAgentReportContext(context, 20_000);
    if (!("sessions" in view)) throw new Error("Expected an Agent context");

    expect(view.request).not.toHaveProperty("sourceSessionIds");
    expect(view).not.toHaveProperty("handoffSummaries");
    expect(view.report).not.toHaveProperty("sourceSessionIds");
    expect(view.sessions).toHaveLength(3);
    expect(view.projection.maxCharacters).toBe(20_000);
    expect(view.projection.omittedFields).toContain("handoffSummaries");

    const missing = store.getReportSynthesisContext({ requestId: "missing-request", maxSessions: 20 });
    expect(toAgentReportContext(missing)).toBe(missing);
  });

  it("sends the report block on the first Session page only and returns it again whenever page 1 is read", () => {
    const store = setup(12);
    const report = store.getReport({ period: "week", date: "2030-01-10" });
    if (report.outcome !== "report") throw new Error("Expected a report");
    for (const session of report.sessions) {
      store.attachEvidence({ sessionId: session.id, kind: "test", reference: "fixture", summary: "Hive count." });
    }
    const created = store.createReportSynthesisRequest({ period: "week", date: "2030-01-10" });
    if (created.outcome !== "report_synthesis_request") throw new Error("Expected a request");
    const page = (sessionPage: number, maxSessions = 5) => {
      const view = toAgentReportContext(
        store.getReportSynthesisContext({ requestId: created.request.id, sessionPage, maxSessions }),
      );
      if (!("sessions" in view)) throw new Error("Expected an Agent context");
      return view;
    };

    const first = page(1);
    expect(first).not.toHaveProperty("reportBlockOnSessionPage");
    expect(first.report).toMatchObject({ totals: { sessions: 12 }, periodSummary: expect.any(String) });
    expect(first.projection.omittedFields).not.toContain("report.block");
    // Long Session-id lists keep their first ids and a count; the Session pages list every source.
    const [project] = (first.report as { projects: Array<{ sourceSessionIds: string[] }> }).projects;
    expect(project).toMatchObject({ sessionCount: 12, sourceSessionIdsOmittedCount: 4 });
    expect(project!.sourceSessionIds).toEqual(report.projects[0]!.sourceSessionIds.slice(0, 8));
    // Evidence names its Session by id only: the preview of that Session is on the same page.
    const firstIds = new Set(first.sessions.map((session) => session.id));
    expect(first.report.evidence.length).toBeGreaterThanOrEqual(5);
    for (const item of first.report.evidence) {
      expect(item).not.toHaveProperty("sessionTitle");
      expect(firstIds.has(item.sessionId)).toBe(true);
    }

    const second = page(2);
    expect(second.reportBlockOnSessionPage).toBe(1);
    expect(Object.keys(second.report).sort()).toEqual(["evidence", "evidencePageInfo"]);
    expect(new Set(second.report.evidence.map((item) => item.sessionId))).toEqual(
      new Set(second.sessions.map((session) => session.id)),
    );
    expect(second.projection.omittedFields).toContain("report.block");
    expect(second.coverage.sessionPageInfo).toMatchObject({ page: 2, hasNext: true });
    expect(JSON.stringify(second).length).toBeLessThan(JSON.stringify(first).length);

    // A retry of a later page is the same; reading page 1 again (for example after a restart) returns the block.
    expect(page(2).report).toEqual(second.report);
    expect(page(3).sessions).toHaveLength(2);
    expect(page(1).report).toEqual(first.report);

    // A period that fits one page is complete on that page.
    const single = page(1, 20);
    expect(single).not.toHaveProperty("reportBlockOnSessionPage");
    expect(single.sessions).toHaveLength(12);
    expect(single.coverage.sessionPageInfo.hasNext).toBe(false);
    expect(single.report).toMatchObject({ totals: { sessions: 12 } });
  });
});
