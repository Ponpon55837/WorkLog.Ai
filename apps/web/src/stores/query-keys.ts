/** Stable query keys shared by Pinia Colada stores and mutation invalidation. */
const reportsViewKey = ["view", "reports"] as const;

export const queryKeys = {
  app: {
    health: ["app", "health"] as const,
  },
  attention: { list: ["attention", "list"] as const },
  dashboard: {
    summary: ["dashboard"] as const,
    overview: ["dashboard", "overview"] as const,
    activity: ["dashboard", "activity"] as const,
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
    pages: ["knowledge", "pages"] as const,
    pageVersions: ["knowledge", "page-versions"] as const,
  },
  sessionDecisions: {
    list: ["session-decisions", "list"] as const,
  },
  outstandingCleanup: {
    requests: ["outstanding-cleanup", "requests"] as const,
    proposals: ["outstanding-cleanup", "proposals"] as const,
  },
  outstandingItems: {
    list: ["outstanding-items", "list"] as const,
  },
  sessions: {
    list: ["sessions", "list"] as const,
    agents: ["sessions", "agents"] as const,
    detail: ["sessions", "detail"] as const,
    related: ["sessions", "related"] as const,
    linkCandidates: ["sessions", "link-candidates"] as const,
  },
  agentReads: {
    list: ["agent-reads", "list"] as const,
    session: ["agent-reads", "session"] as const,
  },
  reports: {
    report: [...reportsViewKey, "report"] as const,
    evidence: [...reportsViewKey, "evidence"] as const,
    sessions: [...reportsViewKey, "sessions"] as const,
    synthesis: [...reportsViewKey, "synthesis"] as const,
  },
  views: {
    graph: ["view", "graph"] as const,
    hotspots: ["view", "graph", "hotspots"] as const,
    timeline: ["view", "graph", "timeline"] as const,
    reports: reportsViewKey,
    sessions: ["view", "sessions"] as const,
    systemStatus: ["view", "system-status"] as const,
  },
};
