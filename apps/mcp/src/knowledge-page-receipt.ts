import type { WorkIntelligenceStore } from "@work-intelligence/storage";

type SaveResult = ReturnType<WorkIntelligenceStore["saveKnowledgePage"]>;

export function toKnowledgePageSaveReceipt(result: SaveResult): unknown {
  if (result.outcome !== "knowledge_page_saved" || !result.sectionChanges) return result;
  const { page } = result;
  return {
    outcome: result.outcome,
    duplicate: result.duplicate,
    page: {
      slug: page.slug,
      version: page.version,
      status: page.status,
      newSessionCount: page.newSessionCount,
      ...(page.needsReview ? { needsReview: true } : {}),
      ...(page.updateRequestedAt ? { updateRequestedAt: page.updateRequestedAt } : {}),
    },
    sectionChanges: result.sectionChanges,
    ...(result.redactions ? { redactions: result.redactions } : {}),
    ...(result.splitSuggestion ? { size: result.size, splitSuggestion: result.splitSuggestion } : {}),
  };
}
