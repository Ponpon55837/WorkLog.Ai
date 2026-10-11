import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveReportSummaryInputSchema } from "../../packages/schema/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

function fixtureSaveInput(requestId: string, sourceSessionIds: string[]) {
  return {
    requestId,
    title: "Fictional large period",
    executiveSummary: "Synthetic delivery with all reviewed sources.",
    themes: [],
    highlights: [],
    verification: [],
    risks: [],
    decisions: [],
    nextSteps: [],
    sourceSessionIds,
    generatedByAgent: "fixture",
    promptVersion: "report-synthesis-v4",
  };
}
const resources: Array<{ root: string; store: WorkIntelligenceStore }> = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wi-report-sources-"));
  const store = new WorkIntelligenceStore(":memory:");
  resources.push({ root, store });
  const project = store.addProject("Fictional source scope", root);
  store.updateProject(project.id, { status: "tracked" });
  function source(index: number) {
    const result = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: `source-${index}`,
      title: `Fictional source ${index}`,
      summary: "Verified synthetic work.",
      changedFiles: ["fixture.ts"],
      completedAt: new Date(Date.UTC(2026, 8, 10, 1, index)).toISOString(),
      verification: { status: "passed" },
    });
    if (result.outcome !== "finalized") throw new Error("Missing source");
    return result.session.id;
  }
  function request() {
    const result = store.createReportSynthesisRequest({ period: "week", date: "2026-09-10", projectId: project.id });
    if (result.outcome !== "report_synthesis_request") throw new Error("Missing request");
    return result.request;
  }
  function context(
    id: string,
    options: { sessionPage?: number; maxSessions?: number; evidencePage?: number; maxEvidence?: number } = {},
  ) {
    const result = store.getReportSynthesisContext({ requestId: id, ...options });
    if (result.outcome !== "report_context") throw new Error("Missing context");
    return result;
  }
  return { store, root, project, source, request, context };
}
afterEach(() => {
  for (const { root, store } of resources.splice(0)) {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
describe("fixed report source pages", () => {
  it("retains older sources after 205 newer Sessions displace the latest window and snapshots all 208 new sources", () => {
    const { store, source, request, context } = fixture();
    const old = Array.from({ length: 3 }, (_, i) => source(i));
    const original = request();
    for (let i = 3; i < 208; i++) source(i);
    const retained = context(original.id);
    expect(new Set(retained.sourceSessionIds)).toEqual(new Set(old));
    expect(retained.coverage).toMatchObject({
      requestedSessions: 3,
      eligibleSessions: 3,
      unavailableSessions: 0,
      selectedSessions: 3,
      currentPeriodSessions: 208,
    });
    expect(retained.truncation.sessions).toBe(false);
    expect(retained.report.sessionTruncation.currentPeriod).toBe(true);
    expect(retained.report.evidence.every((item) => old.includes(item.sessionId))).toBe(true);
    const all = request();
    expect(all.sourceSessionIds).toHaveLength(208);
    const pages = [1, 2, 3].map((sessionPage) => context(all.id, { sessionPage, maxSessions: 100 }));
    expect(pages.flatMap((page) => page.sourceSessionIds)).toEqual(all.sourceSessionIds);
    expect(pages.map((page) => page.sessions.length)).toEqual([100, 100, 8]);
    expect(pages[2]!.coverage.sessionPageInfo.hasNext).toBe(false);
    const saved = fixtureSaveInput(all.id, all.sourceSessionIds);
    expect(saveReportSummaryInputSchema.safeParse(saved).success).toBe(true);
    expect(store.saveReportSummary(saved).outcome).toBe("report_summary_saved");
  });
  it("scopes evidence to the selected source page and exposes voided sources without replacing them", () => {
    const { store, source, request, context, project } = fixture();
    const ids = Array.from({ length: 4 }, (_, i) => source(i));
    const original = request();
    const first = context(original.id, { maxSessions: 2, maxEvidence: 1 });
    const nextEvidence = context(original.id, { maxSessions: 2, maxEvidence: 1, evidencePage: 2 });
    expect(first.coverage.evidence).toEqual({ scope: "selected_sessions", total: 4, returned: 1 });
    expect(first.report.evidence).not.toEqual(nextEvidence.report.evidence);
    expect(first.report.evidence.every((e) => first.sourceSessionIds.includes(e.sessionId))).toBe(true);
    const second = context(original.id, { maxSessions: 2, sessionPage: 2 });
    expect(second.sourceSessionIds.some((id) => first.sourceSessionIds.includes(id))).toBe(false);
    store.setSessionVoid({ sessionId: ids[0]!, voided: true, reason: "Fictional invalidation" });
    const filtered = context(original.id);
    expect(filtered.coverage).toMatchObject({
      requestedSessions: 4,
      eligibleSessions: 3,
      unavailableSessions: 1,
      selectedSessions: 3,
    });
    expect(filtered.sourceSessionIds).not.toContain(ids[0]);
    expect(filtered.truncation.sessions).toBe(true);
    expect(() => store.saveReportSummary(fixtureSaveInput(original.id, ids))).toThrow(/nonvoided/);
    store.updateProject(project.id, { status: "paused" });
    expect(store.getReportSynthesisContext({ requestId: original.id }).outcome).toBe("skipped");
  });
});
