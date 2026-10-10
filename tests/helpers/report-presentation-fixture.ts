import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

/** Synthetic base versions for storage, API and migration regressions. */
export function seedReportPresentation(store: WorkIntelligenceStore, root: string, global = false) {
  const project = store.addProject("Fictional report orchard", root);
  store.updateProject(project.id, { status: "tracked" });
  const saved = store.finalizeSession({
    projectRoot: root,
    idempotencyKey: "presentation-source",
    title: "Fictional source",
    summary: "Verified fictional delivery.",
    completedAt: "2026-09-10T12:00:00Z",
    changedFiles: [],
    verification: { status: "passed" },
  });
  if (saved.outcome !== "finalized") throw new Error("Missing synthetic source");
  const requested = store.createReportSynthesisRequest({
    period: "week",
    date: "2026-09-10",
    ...(global ? {} : { projectId: project.id }),
  });
  if (requested.outcome !== "report_synthesis_request") throw new Error("Missing synthetic request");
  store.getReportSynthesisContext({ requestId: requested.request.id });
  const block = {
    title: "Fictional outcome",
    detail: "Original verified detail.",
    sourceSessionIds: [saved.session.id],
  };
  const result = store.saveReportSummary({
    requestId: requested.request.id,
    title: "Fictional weekly report",
    executiveSummary: "Original executive summary.",
    themes: [block],
    highlights: [block],
    verification: [block],
    risks: [block],
    decisions: [],
    nextSteps: [],
    sourceSessionIds: [saved.session.id],
    generatedByAgent: "fixture",
    promptVersion: "fixture-v1",
  });
  if (result.outcome !== "report_summary_saved") throw new Error("Missing synthetic summary");
  return { project, sourceId: saved.session.id, summary: result.summary };
}
