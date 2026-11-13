import { CHANGED_FILES_NORMAL } from "./search-repository.js";

export interface InferredPathSource {
  id: string;
  score: number;
  changedFiles: readonly string[];
}

export interface InferredTaskPath {
  path: string;
  sourceSessionIds: string[];
}

/** At most two Sessions are named per inferred path; the pointer only needs a place to start reading. */
const SOURCE_SESSION_LIMIT = 2;

/**
 * Weight of every file the most similar Sessions changed: each Session adds score / sqrt(files) to every distinct
 * file, so a focused Session counts more than a sprawling one, and a Session with no files or more than
 * CHANGED_FILES_NORMAL files (likely a dirty worktree) adds nothing.
 * Complexity: O(S*F) time and O(P) space for S Sessions, F files each and P distinct files; S <= 5, F <= 20, so P <= 100.
 */
export function weighTaskPaths(
  sources: ReadonlyArray<InferredPathSource>,
): Map<string, { weight: number; sourceSessionIds: string[] }> {
  const candidates = new Map<string, { weight: number; sourceSessionIds: string[] }>();
  for (const source of sources) {
    const files = [...new Set(source.changedFiles)];
    if (files.length === 0 || files.length > CHANGED_FILES_NORMAL) continue;
    const share = source.score / Math.sqrt(files.length);
    for (const file of files) {
      const candidate = candidates.get(file) ?? { weight: 0, sourceSessionIds: [] };
      candidate.weight += share;
      if (candidate.sourceSessionIds.length < SOURCE_SESSION_LIMIT) candidate.sourceSessionIds.push(source.id);
      candidates.set(file, candidate);
    }
  }
  return candidates;
}

/**
 * Candidate paths for a task without paths: the `limit` heaviest files of weighTaskPaths, ties broken by path.
 * Complexity: O(S*F + P log P) time and O(P) space.
 */
export function inferTaskPaths(sources: ReadonlyArray<InferredPathSource>, limit = 3): InferredTaskPath[] {
  return [...weighTaskPaths(sources)]
    .sort(
      ([leftPath, left], [rightPath, right]) =>
        right.weight - left.weight || (leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0),
    )
    .slice(0, Math.max(0, limit))
    .map(([path, { sourceSessionIds }]) => ({ path, sourceSessionIds }));
}
