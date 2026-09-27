/** Stable query keys shared by Pinia Colada stores and mutation invalidation. */
const reportsViewKey = ["view", "reports"] as const;

export const queryKeys = {
  app: {
    health: ["app", "health"] as const,
  },
  dashboard: {
    summary: ["dashboard"] as const,
    overview: ["dashboard", "overview"] as const,
  },
  commandPalette: {
    search: ["command-palette", "search"] as const,
  },
  projects: {
    list: ["projects"] as const,
    deletionAudits: ["project-deletion-audits"] as const,
    backups: ["projects", "backups"] as const,
    handoffImportPreview: ["projects", "handoff-import-preview"] as const,
    projectDataImportPreview: ["projects", "data-import-preview"] as const,
    metadataBackfillView: ["projects", "metadata-backfill-view"] as const,
    metadataBackfillPreview: ["projects", "metadata-backfill-preview"] as const,
  },
  knowledge: {
    list: ["knowledge", "list"] as const,
    history: ["knowledge", "history"] as const,
    candidates: ["knowledge", "candidates"] as const,
  },
  sessionDecisions: {
    list: ["session-decisions", "list"] as const,
  },
  sessions: {
    list: ["sessions", "list"] as const,
    detail: ["sessions", "detail"] as const,
    linkCandidates: ["sessions", "link-candidates"] as const,
  },
  reports: {
    report: [...reportsViewKey, "report"] as const,
    evidence: [...reportsViewKey, "evidence"] as const,
    sessions: [...reportsViewKey, "sessions"] as const,
    synthesis: [...reportsViewKey, "synthesis"] as const,
  },
  views: {
    graph: ["view", "graph"] as const,
    reports: reportsViewKey,
    sessions: ["view", "sessions"] as const,
    systemStatus: ["view", "system-status"] as const,
  },
};
