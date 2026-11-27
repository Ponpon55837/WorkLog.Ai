/** Case folding covers ASCII letters only, like SQLite `lower()`, so results match the SQL scorer this replaced. */
export interface RelatedPendingFocus {
  terms: readonly string[];
  paths: readonly string[];
  sources: readonly string[];
}

export type RelatedPendingCandidate = {
  id: string;
  source_session_id: string;
  source_session_completed_at: string;
  position: number;
  text_key: string;
  title_key: string;
  summary_key: string;
  changed_files_json: string;
};

/** About 100 ms on the development machine; the worst allowed input took 2.1 s unbounded. */
export const RELATED_PENDING_UNIT_LIMIT = 50_000_000;
const PATH_PAIR_UNITS = 16;
const JSON_UNITS_PER_CHAR = 4;

const TEXT_WEIGHT = 3;
const TITLE_WEIGHT = 0.5;
const SUMMARY_WEIGHT = 0.25;
const PATH_WEIGHT = 10;
const SOURCE_WEIGHT_STEPS = 20;
const ASCII_UPPER = /[A-Z]/g;

function foldAsciiCase(value: string): string {
  return value.replace(ASCII_UPPER, (letter) => letter.toLowerCase());
}

function storedPaths(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value)
      ? value
          .filter((path): path is string => typeof path === "string")
          .map((path) => foldAsciiCase(path.replaceAll("\\", "/")))
      : [];
  } catch {
    return [];
  }
}

function pathMatches(stored: string, query: string): boolean {
  return (
    stored === query || stored.startsWith(`${query}/`) || stored.endsWith(`/${query}`) || query.endsWith(`/${stored}`)
  );
}

function countTerms(value: string, terms: readonly string[]): number {
  let count = 0;
  for (const term of terms) if (value.includes(term)) count += 1;
  return count;
}

const ISSUE_REFERENCE = /(?<![\w&])#(\d{1,7})\b|\/(?:issues|pull)\/(\d{1,7})\b/g;
const ISSUE_RANGE = /(?<![\w&])#(\d{1,7})\s*[-–—~～]\s*#?(\d{1,7})\b/g;
const VERSION_REFERENCE = /(?<![\w.])v?(\d{1,3}\.\d{1,3}\.\d{1,3})(?!\w|\.\d)/g;

export function identifiersIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(ISSUE_REFERENCE)) found.add(`#${match[1] ?? match[2]}`);
  for (const match of text.matchAll(VERSION_REFERENCE)) found.add(match[1] as string);
  return found;
}

export function sharesIdentifier(text: string, identifiers: ReadonlySet<string>): boolean {
  if (identifiers.size === 0) return false;
  for (const identifier of identifiersIn(text)) if (identifiers.has(identifier)) return true;
  return false;
}

type IssueSpan = readonly [first: number, last: number];

export function issueSpansIn(text: string): IssueSpan[] {
  const spans: IssueSpan[] = [];
  for (const match of text.matchAll(ISSUE_REFERENCE)) {
    const number = Number(match[1] ?? match[2]);
    spans.push([number, number]);
  }
  for (const match of text.matchAll(ISSUE_RANGE)) {
    const first = Number(match[1]);
    const last = Number(match[2]);
    if (first < last) spans.push([first, last]);
  }
  return spans;
}

export function spansOverlap(left: readonly IssueSpan[], right: readonly IssueSpan[]): boolean {
  return left.some(([leftFirst, leftLast]) =>
    right.some(([rightFirst, rightLast]) => leftFirst <= rightLast && rightFirst <= leftLast),
  );
}

function compareBinary(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The sum keeps the SQL scorer's term order, so equal inputs give bit-identical scores and ties.
 * @internal test-only
 */
export function rankRelatedPending<T extends RelatedPendingCandidate>(
  candidates: readonly T[],
  focus: RelatedPendingFocus,
): T[] {
  return rankRelatedPendingWithin(candidates, focus, Number.POSITIVE_INFINITY).ranked;
}

export function rankRelatedPendingWithin<T extends RelatedPendingCandidate>(
  candidates: readonly T[],
  focus: RelatedPendingFocus,
  limitUnits: number,
): { ranked: T[]; exhausted: boolean; units: number } {
  let units = 0;
  let exhausted = false;
  const charge = (cost: number): boolean => {
    if (units + cost > limitUnits) {
      exhausted = true;
      return false;
    }
    units += cost;
    return true;
  };
  const termCount = Math.max(1, focus.terms.length);
  const sourceWeights = new Map(
    focus.sources.map((id, index) => [id, (SOURCE_WEIGHT_STEPS - index) / SOURCE_WEIGHT_STEPS]),
  );
  const pathsBySession = new Map<string, number>();
  const scored: Array<{ candidate: T; relevance: number }> = [];
  for (const candidate of candidates) {
    let pathScore = pathsBySession.get(candidate.source_session_id);
    if (pathScore === undefined) {
      pathScore = 0;
      if (focus.paths.length > 0) {
        if (!charge(JSON_UNITS_PER_CHAR * candidate.changed_files_json.length + 1)) break;
        const stored = storedPaths(candidate.changed_files_json);
        const storedUnits = stored.reduce((total, path) => total + path.length + PATH_PAIR_UNITS, 0);
        if (!charge(storedUnits * focus.paths.length)) break;
        for (const query of focus.paths) if (stored.some((path) => pathMatches(path, query))) pathScore += 1;
      }
      pathsBySession.set(candidate.source_session_id, pathScore);
    }
    if (
      focus.terms.length > 0 &&
      !charge((candidate.text_key.length + candidate.title_key.length + candidate.summary_key.length + 3) * termCount)
    ) {
      break;
    }
    const relevance =
      countTerms(candidate.text_key, focus.terms) * TEXT_WEIGHT +
      countTerms(candidate.title_key, focus.terms) * TITLE_WEIGHT +
      countTerms(candidate.summary_key, focus.terms) * SUMMARY_WEIGHT +
      (sourceWeights.get(candidate.source_session_id) ?? 0) +
      pathScore * PATH_WEIGHT;
    if (relevance > 0) scored.push({ candidate, relevance });
  }
  const ranked = scored
    .sort(
      (left, right) =>
        right.relevance - left.relevance ||
        compareBinary(right.candidate.source_session_completed_at, left.candidate.source_session_completed_at) ||
        compareBinary(right.candidate.source_session_id, left.candidate.source_session_id) ||
        left.candidate.position - right.candidate.position ||
        compareBinary(left.candidate.id, right.candidate.id),
    )
    .map((entry) => entry.candidate);
  return { ranked, exhausted, units };
}
