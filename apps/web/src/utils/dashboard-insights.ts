import type { WorkReport } from "@work-intelligence/core";

export interface DashboardInsights {
  sessions: number;
  delta: number;
  previous: number;
  topProject: { id: string; name: string; share: number } | null;
  verification: "failed" | "in_progress" | "incomplete" | "passed";
  count: number;
  notSupplied: number;
  notRun: number;
}

/** Uses full-period SQL aggregates, never the bounded source list or daily trends. */
export function dashboardInsights(report: Pick<WorkReport, "totals" | "comparison" | "projects">): DashboardInsights {
  const v = report.totals.verification;
  let top: WorkReport["projects"][number] | undefined;
  for (const project of report.projects) {
    if (
      !top ||
      project.sessionCount > top.sessionCount ||
      (project.sessionCount === top.sessionCount && project.projectId < top.projectId)
    )
      top = project;
  }
  const verification =
    v.failed > 0
      ? "failed"
      : v.in_progress > 0
        ? "in_progress"
        : v.not_supplied + v.not_run > 0
          ? "incomplete"
          : "passed";
  return {
    sessions: report.totals.sessions,
    delta: report.comparison.sessions.delta,
    previous: report.comparison.sessions.previous,
    topProject:
      top && report.totals.sessions > 0
        ? {
            id: top.projectId,
            name: top.projectName,
            share: Math.round((top.sessionCount / report.totals.sessions) * 100),
          }
        : null,
    verification,
    count: verification === "failed" ? v.failed : verification === "in_progress" ? v.in_progress : v.passed,
    notSupplied: v.not_supplied,
    notRun: v.not_run,
  };
}
