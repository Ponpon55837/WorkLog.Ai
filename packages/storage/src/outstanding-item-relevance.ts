/**
 * Relevance of pending outstanding items to a focus (task terms, changed paths, recalled source Sessions).
 *
 * The candidate query reads each pending item once; this module scores it. Matching every stored path against every
 * query path in SQL recomputed `lower(replace(...))` per pair and cost most of a finalize, so each stored path is
 * folded once here instead. The rules are the ones the SQL scorer used, so results and tie order are unchanged:
 * case folding covers ASCII letters only (like SQLite `lower()`), and directories match on segment boundaries.
 */

export interface RelatedPendingFocus {
  /** Lower-case query terms; each one counted once per field. */
  terms: readonly string[];
  /** Normalized project-relative query paths. */
  paths: readonly string[];
  /** Recalled source Session ids, best first; earlier ids weigh more. */
  sources: readonly string[];
}

export type RelatedPendingCandidate = {
  id: string;
  source_session_id: string;
  source_session_completed_at: string;
  position: number;
  /** `lower()` of the item text, the source title, and the first 2,000 characters of its summary. */
  text_key: string;
  title_key: string;
  summary_key: string;
  /** The source Session's stored changed-files JSON array. */
  changed_files_json: string;
};

/**
 * Work one relatedPending call may spend scoring, in character units charged before the work runs: each candidate's
 * three text keys once per term (String.prototype.includes, about 1.8 ns per character and term for 80-character
 * near-miss terms over repeated letters), and per source Session its changed-files JSON (parsed and folded) plus each
 * stored path once per query path. 50M units is about 100 ms on the development machine; the worst allowed input
 * (2,000 items of 4,000 characters, 24 near-miss terms, 20 query paths against 200 stored paths of 1,000 characters)
 * took 2.1 s unbounded. Real data uses well under 1%.
 */
export const RELATED_PENDING_UNIT_LIMIT = 50_000_000;
/** Per-pair constant work of a path comparison (four prefix/suffix checks), in the units above. */
const PATH_PAIR_UNITS = 16;
const JSON_UNITS_PER_CHAR = 4;

const TEXT_WEIGHT = 3;
let relatedPendingProbe: number[] | undefined;
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

/** Equal, inside the query directory, the query path ending in the stored path, or the reverse. */
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

function compareBinary(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Scores candidates and returns the positive ones, best first: relevance, then the newest source Session, its id
 * (descending), the item position, and the item id. The sum keeps the SQL scorer's term order so equal inputs give
 * bit-identical scores and the same ties.
 */
export function rankRelatedPending<T extends RelatedPendingCandidate>(
  candidates: readonly T[],
  focus: RelatedPendingFocus,
): T[] {
  return rankRelatedPendingWithin(candidates, focus, Number.POSITIVE_INFINITY).ranked;
}

/** Measurement instrumentation only: records the units of every scoring run until called again. */
export function setRelatedPendingProbe(probe: number[] | undefined): void {
  relatedPendingProbe = probe;
}

/**
 * rankRelatedPending within `limitUnits` (see RELATED_PENDING_UNIT_LIMIT). Candidates arrive newest source Session
 * first; each is charged before it is scored, and once the budget would be passed the rest are left out and
 * `exhausted` is set, so the ranking covers the newest candidates the budget could afford.
 */
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
  relatedPendingProbe?.push(units);
  return { ranked, exhausted, units };
}
