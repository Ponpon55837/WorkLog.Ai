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
});
