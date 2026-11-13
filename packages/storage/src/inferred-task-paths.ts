import { CHANGED_FILES_NORMAL } from "./search-repository.js";

export interface InferredPathSource {
  id: string;
  score: number;
  changedFiles: readonly string[];
}

/** A file the similar Sessions changed: its weight, the Sessions to read first, and every Session that changed it. */
export interface WeightedTaskPath {
  weight: number;
  /** At most two Sessions; the pointer only needs a place to start reading. */
  sourceSessionIds: string[];
  /** Every distinct Session that changed the file (at most the number of sources). */
  sessionIds: string[];
}

/** At most two Sessions are named per inferred path; the pointer only needs a place to start reading. */
const SOURCE_SESSION_LIMIT = 2;

/**
 * Weight of every file the most similar Sessions changed: each Session adds score / sqrt(files) to every distinct
 * file, so a focused Session counts more than a sprawling one, and a Session with no files or more than
 * CHANGED_FILES_NORMAL files (likely a dirty worktree) adds nothing.
 * Complexity: O(S*F) time and O(P) space for S Sessions, F files each and P distinct files; S <= 5, F <= 20, so P <= 100.
 */
export function weighTaskPaths(sources: ReadonlyArray<InferredPathSource>): Map<string, WeightedTaskPath> {
  const candidates = new Map<string, WeightedTaskPath>();
  for (const source of sources) {
    const files = [...new Set(source.changedFiles)];
    if (files.length === 0 || files.length > CHANGED_FILES_NORMAL) continue;
    const share = source.score / Math.sqrt(files.length);
    for (const file of files) {
      const candidate = candidates.get(file) ?? { weight: 0, sourceSessionIds: [], sessionIds: [] };
      candidate.weight += share;
      if (candidate.sourceSessionIds.length < SOURCE_SESSION_LIMIT) candidate.sourceSessionIds.push(source.id);
      candidate.sessionIds.push(source.id);
      candidates.set(file, candidate);
    }
  }
  return candidates;
}
