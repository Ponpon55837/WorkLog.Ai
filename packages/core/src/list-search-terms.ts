/** @internal test-only */
export const MAX_LIST_SEARCH_TERMS = 8;
/** @internal test-only */
export const MAX_LIST_SEARCH_TERM_LENGTH = 200;

export interface ListSearchTerms {
  terms: string[];
  warnings: string[];
}

function cutTerm(term: string): string {
  return Array.from(term).slice(0, MAX_LIST_SEARCH_TERM_LENGTH).join("");
}

export function parseListSearchTerms(query: string): ListSearchTerms {
  const terms: string[] = [];
  const warnings: string[] = [];
  let ignored = 0;
  for (const match of query.toLowerCase().matchAll(/"([^"]+)"|\S+/g)) {
    const whole = (match[1] ?? match[0]).replace(/"/g, "").trim();
    if (!whole) continue;
    const term = Array.from(whole).length > MAX_LIST_SEARCH_TERM_LENGTH ? cutTerm(whole) : whole;
    if (terms.includes(term)) continue;
    if (terms.length === MAX_LIST_SEARCH_TERMS) {
      ignored += 1;
      continue;
    }
    if (term !== whole) {
      warnings.push(
        `Search word ${terms.length + 1} is longer than ${MAX_LIST_SEARCH_TERM_LENGTH} characters; only its first ${MAX_LIST_SEARCH_TERM_LENGTH} were matched.`,
      );
    }
    terms.push(term);
  }
  if (ignored > 0) {
    warnings.push(
      `Only the first ${MAX_LIST_SEARCH_TERMS} search words were used; ${ignored} more ${ignored === 1 ? "was" : "were"} ignored.`,
    );
  }
  return { terms, warnings };
}
