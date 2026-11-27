export interface FinalizeContradiction {
  code: string;
  fields: Record<string, unknown>;
  ids?: string[];
}

export const FINALIZE_CONTRADICTIONS: readonly FinalizeContradiction[] = [
  {
    code: "both_lists",
    fields: { resolvedOutstandingItemIds: ["item-a"], supersededOutstandingItemIds: ["item-a"] },
    ids: ["item-a"],
  },
  { code: "superseded_without_next_steps", fields: { supersededOutstandingItemIds: ["item-b"] }, ids: ["item-b"] },
  {
    code: "knowledge_applied_and_contradicted",
    fields: { appliedKnowledgeIds: ["knowledge-a"], contradictedKnowledgeIds: ["knowledge-a"] },
    ids: ["knowledge-a"],
  },
  {
    code: "started_after_completed",
    fields: { startedAt: "2020-01-02T10:00:00.000Z", completedAt: "2020-01-02T09:00:00.000Z" },
  },
];

export function finalizeRequest(projectRoot: string, key: string, fields: Record<string, unknown> = {}) {
  return {
    projectRoot,
    idempotencyKey: key,
    title: `Lamp rotation ${key}`,
    summary: `${key}: the lamp rotation schedule was adjusted.`,
    workSummary: { outcomes: ["Adjusted"], scope: [], decisions: [], verification: [], nextSteps: [] },
    changedFiles: [],
    verification: { status: "passed" },
    ...fields,
  };
}
