/** Stable query keys shared by Pinia Colada stores and mutation invalidation. */
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
    metadataBackfillView: ["projects", "metadata-backfill-view"] as const,
    metadataBackfillPreview: ["projects", "metadata-backfill-preview"] as const,
  },
  knowledge: {
    list: ["knowledge", "list"] as const,
    history: ["knowledge", "history"] as const,
    candidates: ["knowledge", "candidates"] as const,
  },
  sessions: {
    list: ["sessions", "list"] as const,
    detail: ["sessions", "detail"] as const,
    linkCandidates: ["sessions", "link-candidates"] as const,
  },
  views: {
    graph: ["view", "graph"] as const,
    knowledge: ["view", "knowledge"] as const,
    reports: ["view", "reports"] as const,
    sessions: ["view", "sessions"] as const,
    systemStatus: ["view", "system-status"] as const,
  },
};
