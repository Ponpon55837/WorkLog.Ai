/**
 * Knowledge page limits and the one rule for when a page is near them. Storage, the schema, MCP and the Web all read
 * these, so a save, a read and the editor agree on when to suggest moving sections to a custom page.
 */

export interface KnowledgePageSize {
  sectionCount: number;
  maxSections: number;
  contentChars: number;
  maxContentChars: number;
}

/** Which limit a page is near: its section count or its section content characters. */
export type KnowledgePageLimit = "sections" | "content";

/** Present only when a page is near a limit: the largest sections to move to a custom page, largest first. */
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
/**
 * A page is near its limits with one section slot left, or with 90% of its content used: the 800 characters left
 * are about one average section (8,000 / 12), so the next added section is likely to be refused.
 */
export const KNOWLEDGE_PAGE_NEAR_SECTIONS = KNOWLEDGE_PAGE_MAX_SECTIONS - 1;
export const KNOWLEDGE_PAGE_NEAR_CONTENT_CHARS = 7_200;
/**
 * Removing what no longer answers the page question is maintenance; shortening what is still true is not. Only when
 * the page is still near its limits after that does the user decide on a custom page.
 */
export const KNOWLEDGE_PAGE_SPLIT_GUIDANCE =
  "First drop outdated text (done, overturned); then ask the user before moving these to a custom page (work_request_knowledge_page_update). Never trim true text.";
const SPLIT_CANDIDATE_LIMIT = 3;

/**
 * The page's size against its limits and, when it is near one, the sections to move out. One pass: the content total
 * and the largest sections (never every section, so the page keeps one) are taken together.
 */
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
