/** Minimum Dice similarity for a pending item's new wording to keep the item's identity. */
export const REWORD_SIMILARITY_THRESHOLD = 0.5;

/**
 * The schema bounds nextSteps to 20 items, so a Session pairs at most 20 x 20 = 400 texts. Anything above this
 * product is outside the contract; skipping fuzzy pairing there keeps a malformed caller from costing quadratic work.
 */
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

/** Character bigrams (by code point) of the normalized text; a single character is its own bigram. */
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

/** Dice coefficient from precomputed bigram multisets; iterates the smaller map, so O(min(|a|, |b|)) lookups. */
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

/**
 * Dice coefficient over character bigrams of the normalized text (NFKC, lower case, no whitespace, punctuation or
 * symbols). Character bigrams work for CJK text, which has no word breaks. Empty normalized texts never match (0).
 */
export function outstandingTextSimilarity(a: string, b: string): number {
  return diceFromCounts(bigramCounts(a), bigramCounts(b));
}

/**
 * Pairs earlier items with reworded entries, one to one. Pairs at or above the threshold are taken best first; ties
 * prefer the nearer position, then the smaller id, then the smaller index, so the result is deterministic.
 */
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
