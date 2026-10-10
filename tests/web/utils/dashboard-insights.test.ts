import { describe, expect, it } from "vitest";
import { dashboardInsights } from "../../../apps/web/src/utils/dashboard-insights.js";
const report = {
  totals: {
    sessions: 500,
    events: 0,
    changedFiles: 0,
    changedFilesOversizedSessions: 0,
    verification: { passed: 400, failed: 1, in_progress: 10, not_run: 40, not_supplied: 49 },
  },
  comparison: {
    sessions: { current: 500, previous: 0, delta: 500, direction: "up" as const },
    events: { current: 0, previous: 0, delta: 0, direction: "flat" as const },
    changedFiles: { current: 0, previous: 0, delta: 0, direction: "flat" as const },
  },
  projects: [
    { projectId: "b", projectName: "Beta", sessionCount: 300, eventCount: 0, sourceSessionIds: [] },
    { projectId: "a", projectName: "Alpha", sessionCount: 200, eventCount: 0, sourceSessionIds: [] },
  ],
};
describe("weekly insights", () => {
  it("uses complete aggregates above the 200-source window and prioritizes verification failures", () => {
    expect(dashboardInsights(report)).toMatchObject({
      sessions: 500,
      previous: 0,
      topProject: { id: "b", share: 60 },
      verification: "failed",
      count: 1,
    });
    const next = structuredClone(report);
    next.totals.verification.failed = 0;
    expect(dashboardInsights(next).verification).toBe("in_progress");
    next.totals.verification.in_progress = 0;
    expect(dashboardInsights(next)).toMatchObject({ verification: "incomplete", notSupplied: 49, notRun: 40 });
    next.totals.verification.not_supplied = 0;
    next.totals.verification.not_run = 0;
    expect(dashboardInsights(next)).toMatchObject({ verification: "passed", count: 400 });
  });
  it("chooses equal shares deterministically and does not divide an empty period", () => {
    const next = structuredClone(report);
    next.projects[1]!.sessionCount = 300;
    expect(dashboardInsights(next).topProject?.id).toBe("a");
    next.totals.sessions = 0;
    expect(dashboardInsights(next).topProject).toBeNull();
  });
});
