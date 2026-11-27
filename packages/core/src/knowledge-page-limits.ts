export interface KnowledgePageSize {
  sectionCount: number;
  maxSections: number;
  contentChars: number;
  maxContentChars: number;
}

export type KnowledgePageLimit = "sections" | "content";

export interface KnowledgePageSplitSuggestion {
  near: KnowledgePageLimit[];
  headings: string[];
  splitWith: string;
}

export interface KnowledgePageLimits {
  size: KnowledgePageSize;
  splitSuggestion?: KnowledgePageSplitSuggestion;
}

export const KNOWLEDGE_PAGE_MAX_SECTIONS = 12;
export const KNOWLEDGE_PAGE_MAX_CONTENT_CHARS = 8_000;
export const KNOWLEDGE_PAGE_NEAR_SECTIONS = KNOWLEDGE_PAGE_MAX_SECTIONS - 1;
export const KNOWLEDGE_PAGE_NEAR_CONTENT_CHARS = 7_200;
export const KNOWLEDGE_PAGE_SPLIT_GUIDANCE =
  "First drop outdated text (done, overturned); then ask the user before moving these to a custom page (work_request_knowledge_page_update). Never trim true text.";
const SPLIT_CANDIDATE_LIMIT = 3;

export function knowledgePageLimits(
  sections: ReadonlyArray<{ heading: string; content: string }>,
): KnowledgePageLimits {
  const candidateLimit = Math.min(SPLIT_CANDIDATE_LIMIT, sections.length - 1);
  const largest: Array<{ heading: string; chars: number }> = [];
  let contentChars = 0;
  for (const section of sections) {
    const chars = section.content.length;
    contentChars += chars;
    if (candidateLimit <= 0) continue;
    let index = largest.length;
    while (index > 0 && largest[index - 1]!.chars < chars) index -= 1;
    if (index >= candidateLimit) continue;
    largest.splice(index, 0, { heading: section.heading, chars });
    if (largest.length > candidateLimit) largest.pop();
  }
  const size: KnowledgePageSize = {
    sectionCount: sections.length,
    maxSections: KNOWLEDGE_PAGE_MAX_SECTIONS,
    contentChars,
    maxContentChars: KNOWLEDGE_PAGE_MAX_CONTENT_CHARS,
  };
  const near: KnowledgePageLimit[] = [];
  if (sections.length >= KNOWLEDGE_PAGE_NEAR_SECTIONS) near.push("sections");
  if (contentChars >= KNOWLEDGE_PAGE_NEAR_CONTENT_CHARS) near.push("content");
  if (near.length === 0 || largest.length === 0) return { size };
  return {
    size,
    splitSuggestion: {
      near,
      headings: largest.map((section) => section.heading),
      splitWith: KNOWLEDGE_PAGE_SPLIT_GUIDANCE,
    },
  };
}
