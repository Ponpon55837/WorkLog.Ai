/** SQL fragment to append after every `LIKE ?` that binds {@link likeContainsPattern}. */
export const LIKE_ESCAPE = "ESCAPE '\\'";

/** Wraps a query as a LIKE substring pattern where `%`, `_` and `\` match literally. */
export function likeContainsPattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

const MAX_SEARCH_TERMS = 8;

/**
 * Splits a list-search query into lowercase terms: words separated by spaces, or a "quoted phrase" kept
 * whole. List searches require every term (in any field), so "report timezone" finds a record that
 * mentions both words apart, while the list keeps its time order and pagination.
 */
export function splitSearchTerms(query: string): string[] {
  const terms: string[] = [];
  for (const match of query.toLowerCase().matchAll(/"([^"]+)"|(\S+)/g)) {
    // Stray quotes (an empty pair, or one left unclosed) are not part of the word.
    const term = (match[1] ?? match[2] ?? "").replace(/"/g, "").trim();
    if (term && !terms.includes(term)) {
      terms.push(term);
    }
  }
  return terms.slice(0, MAX_SEARCH_TERMS);
}
