export const REWORD_SIMILARITY_THRESHOLD = 0.5;

/** The schema allows at most 20 x 20 pairs; above this a malformed caller gets no quadratic fuzzy pairing. */
const MAX_REWORD_PAIR_COUNT = 2_500;

export interface RewordPreviousItem {
  id: string;
  position: number;
  text: string;
}

export interface RewordNextEntry {
  index: number;
  text: string;
}

export interface RewordPair {
  id: string;
  index: number;
  similarity: number;
}

type BigramCounts = { counts: Map<string, number>; total: number };

function normalizeForSimilarity(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function bigramCounts(text: string): BigramCounts {
  const characters = [...normalizeForSimilarity(text)];
  const counts = new Map<string, number>();
  if (characters.length === 0) return { counts, total: 0 };
  if (characters.length === 1) return { counts: new Map([[characters[0]!, 1]]), total: 1 };
  for (let index = 0; index < characters.length - 1; index++) {
    const bigram = characters[index]! + characters[index + 1]!;
    counts.set(bigram, (counts.get(bigram) ?? 0) + 1);
  }
  return { counts, total: characters.length - 1 };
}

function diceFromCounts(left: BigramCounts, right: BigramCounts): number {
  if (left.total === 0 || right.total === 0) return 0;
  const [small, large] = left.counts.size <= right.counts.size ? [left, right] : [right, left];
  let shared = 0;
  for (const [bigram, count] of small.counts) {
    const other = large.counts.get(bigram);
    if (other) shared += Math.min(count, other);
  }
  return (2 * shared) / (left.total + right.total);
}

/** Character bigrams, because CJK text has no word breaks. */
export function outstandingTextSimilarity(a: string, b: string): number {
  return diceFromCounts(bigramCounts(a), bigramCounts(b));
}

export function pairRewordedItems(
  previous: readonly RewordPreviousItem[],
  next: readonly RewordNextEntry[],
  threshold = REWORD_SIMILARITY_THRESHOLD,
): RewordPair[] {
  if (previous.length === 0 || next.length === 0) return [];
  if (previous.length * next.length > MAX_REWORD_PAIR_COUNT) return [];
  const previousCounts = previous.map((item) => bigramCounts(item.text));
  const nextCounts = next.map((entry) => bigramCounts(entry.text));
  const candidates: Array<RewordPair & { distance: number }> = [];
  previous.forEach((item, previousIndex) => {
    next.forEach((entry, nextIndex) => {
      const similarity = diceFromCounts(previousCounts[previousIndex]!, nextCounts[nextIndex]!);
      if (similarity >= threshold) {
        candidates.push({
          id: item.id,
          index: entry.index,
          similarity,
          distance: Math.abs(item.position - entry.index),
        });
      }
    });
  });
  candidates.sort(
    (left, right) =>
      right.similarity - left.similarity ||
      left.distance - right.distance ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0) ||
      left.index - right.index,
  );
  const usedIds = new Set<string>();
  const usedIndexes = new Set<number>();
  const pairs: RewordPair[] = [];
  for (const { id, index, similarity } of candidates) {
    if (usedIds.has(id) || usedIndexes.has(index)) continue;
    usedIds.add(id);
    usedIndexes.add(index);
    pairs.push({ id, index, similarity });
  }
  return pairs;
}
