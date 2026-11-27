import { CHANGED_FILES_NORMAL } from "./search-repository.js";

export interface InferredPathSource {
  id: string;
  score: number;
  changedFiles: readonly string[];
}

export interface WeightedTaskPath {
  weight: number;
  sourceSessionIds: string[];
  sessionIds: string[];
}

const SOURCE_SESSION_LIMIT = 2;

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
