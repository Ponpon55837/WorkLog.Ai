import type { WorkIntelligenceStore } from "@work-intelligence/storage";

type SaveResult = ReturnType<WorkIntelligenceStore["saveKnowledgePage"]>;
type CheckedResult = ReturnType<WorkIntelligenceStore["markKnowledgePageChecked"]>;

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
    ...(result.warnings ? { warnings: result.warnings } : {}),
    ...(result.droppedSourceSessionIds ? { droppedSourceSessionIds: result.droppedSourceSessionIds } : {}),
    ...(result.redactions ? { redactions: result.redactions } : {}),
    ...(result.splitSuggestion ? { size: result.size, splitSuggestion: result.splitSuggestion } : {}),
  };
}

export function toKnowledgePageCheckedReceipt(result: CheckedResult): unknown {
  if (result.outcome !== "knowledge_page_checked") return result;
  const { page } = result;
  return {
    outcome: result.outcome,
    page: {
      slug: page.slug,
      version: page.version,
      status: page.status,
      newSessionCount: page.newSessionCount,
      ...(page.checkedThrough ? { checkedThrough: page.checkedThrough } : {}),
      ...(page.sourcedThrough ? { sourcedThrough: page.sourcedThrough } : {}),
      ...(page.needsReview ? { needsReview: true } : {}),
      ...(page.updateRequestedAt ? { updateRequestedAt: page.updateRequestedAt } : {}),
    },
  };
}
