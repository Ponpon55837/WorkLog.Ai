/** Stable query keys shared by Pinia Colada stores and mutation invalidation. */
export const queryKeys = {
  dashboard: {
    summary: ["dashboard"] as const,
  },
  projects: {
    list: ["projects"] as const,
    deletionAudits: ["project-deletion-audits"] as const,
  },
};
