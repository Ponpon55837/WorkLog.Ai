import type { WorkIntelligenceStore } from "@work-intelligence/storage";

type SaveResult = ReturnType<WorkIntelligenceStore["saveKnowledgePage"]>;

/**
 * A section update (upsertSections or removeHeadings) answers with a compact receipt: the page's identity and state,
 * what changed per heading, and the size and split suggestion when the page is near its limits. It does not echo
 * the whole page, which the Agent only needed to read before writing. A full save, every error outcome and every other caller get the storage result unchanged.
 */
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
