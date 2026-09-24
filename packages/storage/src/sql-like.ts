/** SQL fragment to append after every `LIKE ?` that binds {@link likeContainsPattern}. */
export const LIKE_ESCAPE = "ESCAPE '\\'";

/** Wraps a query as a LIKE substring pattern where `%`, `_` and `\` match literally. */
export function likeContainsPattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}
