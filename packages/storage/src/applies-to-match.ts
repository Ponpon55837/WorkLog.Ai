/*
 * Matching normalized paths against normalized appliesTo entries. A glob must match the whole path; a plain entry
 * matches by path segments. Stored patterns come from Agents and imports, so every scan is metered.
 *
 * The accounting invariant. A unit stands for one character operation. Every operation here whose cost grows with the
 * length of a stored entry or a caller path is charged to the scan's budget BEFORE it runs, with at least one unit per
 * code unit comparison it may make (times a weight, measured so one unit costs about the same time on every path):
 *   - reading a stored list (storedAppliesTo): the JSON text it parses, then each entry it normalizes (x4);
 *   - compiling a glob or a plain entry's segment search: x16 per pattern character on a cache miss (tokenizing, the
 *     literal prefix and suffix, the literal runs and their failure tables: at most 5 comparisons per character, and
 *     allocation), 1 unit on a hit;
 *   - each pattern and path pair: 12 units for its constant-time work;
 *   - the prefix, suffix, equality and segment-suffix checks: the length they compare, only when they run;
 *   - the ordered literal search and a plain entry's `/path/` search: twice the window searched (Knuth-Morris-Pratt
 *     compares at most twice per window character; indexOf on a near-miss run had no such bound);
 *   - the NFA simulation: (tokens + 1) to set up and per path character it reads.
 * Why that bounds the work: each loop that compares characters runs only after a charge covering its worst case, a
 * charge that would pass the limit marks the budget exhausted and the loop does not run, and an exhausted budget
 * makes every later charge fail. So `units` never passes `limit`, the comparisons made are at most `units` (the debug
 * counter, setAppliesToWorkCounter, lets tests check examined <= charged on hostile inputs), and the time spent is at
 * most `limit` times the slowest path's cost per unit. Entries above the write-time limits (length, count, or stars)
 * are never tokenized and never match; a scan that skipped one reports itself incomplete, like one the budget cut.
 */
import {
  APPLIES_TO_TOKEN_ANY,
  APPLIES_TO_TOKEN_LITERAL,
  APPLIES_TO_TOKEN_ONE,
  APPLIES_TO_TOKEN_SEGMENT,
  isAppliesToGlob,
  MAX_APPLIES_TO_ENTRIES,
  MAX_APPLIES_TO_ENTRY_LENGTH,
  MAX_APPLIES_TO_GLOB_STARS,
  tokenizeAppliesToGlobCompact,
} from "@work-intelligence/core";
import { normalizePath, type PathContext } from "./search-text.js";

/**
 * Work one scan may spend on appliesTo matching, in character-operation units (see the invariant above). When the
 * next charge would pass `limit`, `exhausted` is set and that operation and every later one report no match, so the
 * scan stops and says it was cut short. `skippedEntries` counts stored entries above the write-time limits.
 */
export interface AppliesToBudget {
  readonly limit: number;
  units: number;
  exhausted: boolean;
  skippedEntries: number;
}

/** Tests a normalized path; with a budget, the match is charged to it and is false once the budget is spent. */
export type AppliesToMatcher = (path: string, budget?: AppliesToBudget) => boolean;

/** Test instrumentation: code units the matcher's loops compared, independent of what was charged. */
export interface AppliesToWorkCounter {
  examined: number;
}

/** A glob split around its wildcards, so the exact rejections run before the simulation. */
interface CompiledGlob {
  /** Over MAX_APPLIES_TO_GLOB_STARS: never matches. */
  overComplex: boolean;
  /** Literal code units before the first wildcard and after the last one. */
  prefix: string;
  suffix: string;
  /** The tokens from the first wildcard to the last, inclusive: kind and literal code unit per token. */
  kinds: Uint8Array;
  codes: Uint16Array;
  /** Maximal literal runs inside the middle, in pattern order, with their KMP failure tables. */
  literals: string[];
  failures: Uint16Array[];
  /** Code units every match has: one per literal and per `?`. */
  minLength: number;
  /** Pattern length, for the cache's size bound. */
  size: number;
}

interface CacheEntry<T> {
  value: T;
  size: number;
  recent: boolean;
}

interface BoundedCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T, size: number): void;
}

/**
 * Knowledge rows one appliesTo scan reads at most, newest first: the scans run in memory on caller-supplied paths,
 * so their cost stays bounded however many Knowledge items the tracked projects hold.
 */
export const APPLIES_TO_SCAN_LIMIT = 2_000;

/**
 * Units one scan may spend: recall, the relaxed Knowledge search, file history, and finalize's knowledgeToReview each
 * get one per call (shared by every row, never reset per row). Chosen from a time target of 100 ms of blocking: on the
 * development machine the slowest path (the 16-star simulation) cost 3.7 ns per unit, the near-miss literal search
 * 3.1, compiling 3.6, plain entries 3.5, and the ordinary-pattern mix 3.3, so 20M units is 75-90 ms there. On a copy
 * of real data the heaviest caller-path scan spent 0.3M units, 1.5% of it.
 */
export const APPLIES_TO_MATCH_UNIT_LIMIT = 20_000_000;

/**
 * Units one staleness read may spend: it compares every distinct appliesTo entry of the listed Knowledge with every
 * distinct file later Sessions changed, both stored, so it grows with history rather than with the caller's input. It
 * runs synchronously inside Knowledge lists and recall and cannot yield, so it is capped at about 200 ms (2.5 times the
 * caller-path scans); a copy of real data spent 3.4M units, 7% of it, for its whole Knowledge list.
 */
export const APPLIES_TO_STALENESS_UNIT_LIMIT = 50_000_000;

/** Per-path weights, so one unit costs about the same time on each path (measured; see APPLIES_TO_MATCH_UNIT_LIMIT). */
const JSON_UNITS_PER_CHAR = 1;
const NORMALIZE_UNITS_PER_CHAR = 4;
const COMPILE_UNITS_PER_CHAR = 16;
const PAIR_UNITS = 12;

// Compiled globs, and failure tables of plain entries and paths, shared across scans. Bounded by count and by total
// characters; eviction is second chance (an entry used since it was last considered moves to the back once), so a
// scan of many distinct long patterns evicts one entry per miss (each miss is charged) instead of clearing the cache
// and recompiling everything, and a hit costs no reordering.
const CACHE_LIMIT = 512;
const CACHE_CHARACTERS = 256_000;
const globCache = createBoundedCache<CompiledGlob>();
const segmentCache = createBoundedCache<{ word: string; failure: Uint16Array }>();

// Scratch state arrays for the simulation, grown to the longest middle seen (at most the entry length limit).
let activeStates = new Uint8Array(64);
let nextStates = new Uint8Array(64);

let workCounter: AppliesToWorkCounter | undefined;

function isStarKind(kind: number): boolean {
  return kind === APPLIES_TO_TOKEN_SEGMENT || kind === APPLIES_TO_TOKEN_ANY;
}

/** Characters `.` in a JavaScript RegExp without the `s` flag does not match; `**` has always excluded them. */
function isLineTerminatorCode(code: number): boolean {
  return code === 10 || code === 13 || code === 0x2028 || code === 0x2029;
}

function createBoundedCache<T>(): BoundedCache<T> {
  const entries = new Map<string, CacheEntry<T>>();
  let characters = 0;
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entry.recent = true;
      return entry.value;
    },
    set(key, value, size) {
      entries.set(key, { value, size, recent: false });
      characters += size;
      // Each pass either evicts the oldest entry or clears its mark and moves it back, so this ends within two passes.
      while (entries.size > CACHE_LIMIT || characters > CACHE_CHARACTERS) {
        const [oldestKey, oldest] = entries.entries().next().value as [string, CacheEntry<T>];
        entries.delete(oldestKey);
        if (oldest.recent && oldestKey !== key) {
          oldest.recent = false;
          entries.set(oldestKey, oldest);
        } else {
          characters -= oldest.size;
        }
      }
    },
  };
}

/** Charges `cost` units; false (and the budget marked spent) when that would pass its limit. */
function charge(budget: AppliesToBudget | undefined, cost: number): boolean {
  if (!budget) return true;
  if (budget.exhausted || budget.units + cost > budget.limit) {
    budget.exhausted = true;
    return false;
  }
  budget.units += cost;
  return true;
}

function count(examined: number): void {
  if (workCounter) workCounter.examined += examined;
}

/** The KMP failure table of `word`: at most 2 x length comparisons. */
function failureTable(word: string): Uint16Array {
  const table = new Uint16Array(word.length);
  let examined = 0;
  let matched = 0;
  for (let index = 1; index < word.length; index += 1) {
    const code = word.charCodeAt(index);
    while (matched > 0 && word.charCodeAt(matched) !== code) {
      matched = table[matched - 1]!;
      examined += 1;
    }
    examined += 1;
    if (word.charCodeAt(matched) === code) matched += 1;
    table[index] = matched;
  }
  count(examined);
  return table;
}

/** First start of `word` inside `text[from, end)`, or -1; at most 2 x (end - from) comparisons. */
function findWord(text: string, from: number, end: number, word: string, failure: Uint16Array): number {
  let examined = 0;
  let matched = 0;
  for (let at = from; at < end; at += 1) {
    const code = text.charCodeAt(at);
    while (matched > 0 && word.charCodeAt(matched) !== code) {
      matched = failure[matched - 1]!;
      examined += 1;
    }
    examined += 1;
    if (word.charCodeAt(matched) === code) matched += 1;
    if (matched === word.length) {
      count(examined);
      return at - word.length + 1;
    }
  }
  count(examined);
  return -1;
}

/** Whether `text` has `word` at `at`; at most word.length comparisons. */
function hasAt(text: string, at: number, word: string): boolean {
  if (at < 0 || at + word.length > text.length) return false;
  let index = 0;
  while (index < word.length && text.charCodeAt(at + index) === word.charCodeAt(index)) index += 1;
  count(Math.min(index + 1, word.length));
  return index === word.length;
}

/** `hasAt`, charged `word.length` first; false when unaffordable. */
function chargedHasAt(text: string, at: number, word: string, budget: AppliesToBudget | undefined): boolean {
  return charge(budget, word.length) && hasAt(text, at, word);
}

/** Compiles a glob of at most MAX_APPLIES_TO_ENTRY_LENGTH characters: at most 5 x length + 2 comparisons. */
function compileGlob(pattern: string): CompiledGlob {
  const tokens = tokenizeAppliesToGlobCompact(pattern);
  count(pattern.length);
  const { kinds, codes, length } = tokens;
  let first = 0;
  while (first < length && kinds[first] === APPLIES_TO_TOKEN_LITERAL) first += 1;
  let last = length - 1;
  while (last >= 0 && kinds[last] === APPLIES_TO_TOKEN_LITERAL) last -= 1;
  count(first + (length - last) + 1);
  const text = (from: number, to: number): string => String.fromCharCode(...codes.subarray(from, to));
  const literals: string[] = [];
  let runStart = -1;
  let minLength = 0;
  for (let index = 0; index < length; index += 1) {
    if (!isStarKind(kinds[index]!)) minLength += 1;
    if (index < first || index > last) continue;
    if (kinds[index] === APPLIES_TO_TOKEN_LITERAL) {
      if (runStart < 0) runStart = index;
    } else if (runStart >= 0) {
      literals.push(text(runStart, index));
      runStart = -1;
    }
  }
  count(length);
  return {
    overComplex: tokens.stars > MAX_APPLIES_TO_GLOB_STARS,
    prefix: text(0, first),
    suffix: text(last + 1, length),
    kinds: kinds.slice(first, last + 1),
    codes: codes.slice(first, last + 1),
    literals,
    failures: literals.map(failureTable),
    minLength,
    size: pattern.length,
  };
}

/** The cached compiled glob, charging 1 unit on a hit and the compile on a miss; undefined when unaffordable. */
function cachedGlob(pattern: string, budget: AppliesToBudget | undefined): CompiledGlob | undefined {
  const cached = globCache.get(pattern);
  if (cached) return charge(budget, 1) ? cached : undefined;
  if (!charge(budget, COMPILE_UNITS_PER_CHAR * pattern.length + 1)) return undefined;
  const compiled = compileGlob(pattern);
  globCache.set(pattern, compiled, compiled.size);
  return compiled;
}

/** `/word/` and its failure table, cached like compiled globs and charged the same way; undefined when unaffordable. */
function segmentWord(
  word: string,
  budget: AppliesToBudget | undefined,
): { word: string; failure: Uint16Array } | undefined {
  const cached = segmentCache.get(word);
  if (cached) return charge(budget, 1) ? cached : undefined;
  if (!charge(budget, COMPILE_UNITS_PER_CHAR * (word.length + 2) + 1)) return undefined;
  const segment = `/${word}/`;
  const compiled = { word: segment, failure: failureTable(segment) };
  segmentCache.set(word, compiled, segment.length);
  return compiled;
}

/**
 * Whether `path[start, end)` matches the middle tokens whole, by simulating every pattern position at once (a
 * Thompson-style NFA walk), so a pattern full of stars costs O(tokens x characters) instead of exponential regex
 * backtracking. One pass per character reads each state once, applies its transition, closes stars over the empty
 * run as it goes (state i is final once positions i - 1 and i are done) and clears the old state for reuse.
 * Works on UTF-16 code units, like the anchored RegExp it replaced.
 */
function simulate(glob: CompiledGlob, path: string, start: number, end: number, budget?: AppliesToBudget): boolean {
  const { kinds, codes } = glob;
  const accept = kinds.length;
  if (!charge(budget, accept + 1)) return false;
  if (activeStates.length < accept + 1) {
    activeStates = new Uint8Array(accept + 1);
    nextStates = new Uint8Array(accept + 1);
  }
  let active = activeStates;
  let next = nextStates;
  active.fill(0, 0, accept + 1);
  next.fill(0, 0, accept + 1);
  active[0] = 1;
  for (let index = 0; index < accept; index += 1) if (active[index] && isStarKind(kinds[index]!)) active[index + 1] = 1;
  let examined = accept + 1;
  let result = false;
  for (let offset = start; ; offset += 1) {
    if (offset === end) {
      result = active[accept] === 1;
      break;
    }
    if (!charge(budget, accept + 1)) break;
    const code = path.charCodeAt(offset);
    let alive = false;
    for (let index = 0; index < accept; index += 1) {
      examined += 1;
      if (active[index]) {
        active[index] = 0;
        const kind = kinds[index]!;
        if (kind === APPLIES_TO_TOKEN_LITERAL) {
          if (codes[index] === code) next[index + 1] = 1;
        } else if (kind === APPLIES_TO_TOKEN_ONE) {
          if (code !== 47) next[index + 1] = 1;
        } else if (kind === APPLIES_TO_TOKEN_SEGMENT) {
          if (code !== 47) next[index] = 1;
        } else if (!isLineTerminatorCode(code)) {
          next[index] = 1;
        }
      }
      if (next[index]) {
        alive = true;
        if (isStarKind(kinds[index]!)) next[index + 1] = 1;
      }
    }
    examined += 1;
    active[accept] = 0;
    if (next[accept]) alive = true;
    if (!alive) break;
    [active, next] = [next, active];
  }
  count(examined);
  return result;
}

/**
 * Whole-path glob match. The rejections before the simulation are exact, never heuristics: every literal and `?`
 * consumes one code unit and stars consume zero or more, so a shorter path cannot match; the tokens before the first
 * wildcard and after the last are literals that must be the path's first and last code units (minLength keeps the
 * two apart); and the middle tokens must match the code units between them, which contain each literal run of the
 * middle in pattern order without overlap. A leftmost search for each run, starting where the previous one ended,
 * finds such a placement whenever one exists, so a failed search proves there is no match. Each check is charged
 * before it runs (see the invariant at the top).
 */
function globMatches(glob: CompiledGlob, path: string, budget: AppliesToBudget | undefined): boolean {
  if (glob.overComplex || path.length < glob.minLength) return false;
  if (!chargedHasAt(path, 0, glob.prefix, budget)) return false;
  if (!chargedHasAt(path, path.length - glob.suffix.length, glob.suffix, budget)) return false;
  const start = glob.prefix.length;
  const end = path.length - glob.suffix.length;
  let from = start;
  for (const [index, literal] of glob.literals.entries()) {
    if (end - from < literal.length) return false;
    if (!charge(budget, 2 * (end - from))) return false;
    const at = findWord(path, from, end, literal, glob.failures[index]!);
    if (at < 0) return false;
    from = at + literal.length;
  }
  return simulate(glob, path, start, end, budget);
}

/**
 * pathMatchStrength (search-text.ts) with linear checks, each charged before it runs: equal 1; either one a
 * path-segment suffix of the other 0.8; `stored` inside the directory `queried`, or `/queried/` inside `stored`, 0.6.
 * A check whose separator is absent costs nothing beyond the pair's own units.
 */
function plainStrength(stored: string, queried: string, budget: AppliesToBudget | undefined): number {
  if (!stored || !queried) return 0;
  const storedLength = stored.length;
  const queriedLength = queried.length;
  if (storedLength === queriedLength) return chargedHasAt(stored, 0, queried, budget) ? 1 : 0;
  if (storedLength > queriedLength && stored.charCodeAt(storedLength - queriedLength - 1) === 47) {
    if (chargedHasAt(stored, storedLength - queriedLength, queried, budget)) return 0.8;
  }
  if (queriedLength > storedLength && queried.charCodeAt(queriedLength - storedLength - 1) === 47) {
    if (chargedHasAt(queried, queriedLength - storedLength, stored, budget)) return 0.8;
  }
  if (storedLength < queriedLength + 2) {
    return storedLength > queriedLength &&
      stored.charCodeAt(queriedLength) === 47 &&
      chargedHasAt(stored, 0, queried, budget)
      ? 0.6
      : 0;
  }
  if (stored.charCodeAt(queriedLength) === 47 && chargedHasAt(stored, 0, queried, budget)) return 0.6;
  const segment = segmentWord(queried, budget);
  if (!segment || !charge(budget, 2 * storedLength)) return 0;
  return findWord(stored, 0, storedLength, segment.word, segment.failure) >= 0 ? 0.6 : 0;
}

/** A budget for one scan; see AppliesToBudget. */
export function createAppliesToBudget(limit = APPLIES_TO_MATCH_UNIT_LIMIT): AppliesToBudget {
  return { limit, units: 0, exhausted: false, skippedEntries: 0 };
}

/** Whether a scan's answer may be missing matches: the budget ran out, or a stored entry above the limits was skipped. */
export function appliesToScanIncomplete(budget: AppliesToBudget): boolean {
  return budget.exhausted || budget.skippedEntries > 0;
}

/** Charges work a caller does on stored data next to matching (for example parsing changed files), before it runs. */
export function chargeAppliesTo(budget: AppliesToBudget, units: number): boolean {
  return charge(budget, units);
}

/** Test instrumentation only: counts the comparisons of the matcher's loops into `counter` until called again. */
export function setAppliesToWorkCounter(counter: AppliesToWorkCounter | undefined): void {
  workCounter = counter;
}

/**
 * The entries of one stored appliesTo list with their normalized forms, the only way stored entries enter matching.
 * The JSON text and each entry's normalization are charged first. At most MAX_APPLIES_TO_ENTRIES entries are
 * considered and an entry longer than MAX_APPLIES_TO_ENTRY_LENGTH is not normalized; both count as skipped. Entries
 * that normalize to nothing are left out; the list stops early when the budget is spent.
 */
export function storedAppliesTo(
  stored: string,
  contexts: PathContext[],
  budget: AppliesToBudget,
): Array<{ raw: string; pattern: string }> {
  if (!charge(budget, JSON_UNITS_PER_CHAR * stored.length + 1)) return [];
  let list: unknown;
  try {
    list = JSON.parse(stored);
  } catch {
    return [];
  }
  return Array.isArray(list) ? normalizedAppliesTo(list, contexts, budget) : [];
}

/** storedAppliesTo for a list already parsed (a KnowledgeRecord's appliesTo). */
export function normalizedAppliesTo(
  list: readonly unknown[],
  contexts: PathContext[],
  budget: AppliesToBudget,
): Array<{ raw: string; pattern: string }> {
  if (list.length > MAX_APPLIES_TO_ENTRIES) budget.skippedEntries += list.length - MAX_APPLIES_TO_ENTRIES;
  const context = contexts.reduce((total, item) => total + item.name.length + item.rootPath.length, 0);
  const entries: Array<{ raw: string; pattern: string }> = [];
  for (const raw of list.slice(0, MAX_APPLIES_TO_ENTRIES)) {
    if (typeof raw !== "string") continue;
    if (raw.length > MAX_APPLIES_TO_ENTRY_LENGTH) {
      budget.skippedEntries += 1;
      continue;
    }
    if (!charge(budget, NORMALIZE_UNITS_PER_CHAR * (raw.length + context) + 1)) return entries;
    const pattern = normalizePath(raw, contexts);
    if (pattern) entries.push({ raw, pattern });
  }
  return entries;
}

/** The normalized patterns of storedAppliesTo. */
export function appliesToEntries(stored: string, contexts: PathContext[], budget: AppliesToBudget): string[] {
  return storedAppliesTo(stored, contexts, budget).map((entry) => entry.pattern);
}

/**
 * Precompiles a normalized appliesTo entry into a matcher, for checking one pattern against many paths. With a
 * budget, compiling is charged to it (a cached glob costs 1 unit). An entry longer than MAX_APPLIES_TO_ENTRY_LENGTH
 * never matches and is never tokenized.
 */
export function compileAppliesTo(pattern: string, budget?: AppliesToBudget): AppliesToMatcher {
  if (!pattern) {
    return () => false;
  }
  if (pattern.length > MAX_APPLIES_TO_ENTRY_LENGTH) {
    if (budget) budget.skippedEntries += 1;
    return () => false;
  }
  if (isAppliesToGlob(pattern)) {
    const glob = cachedGlob(pattern, budget);
    if (!glob) return () => false;
    return (path, pathBudget) => Boolean(path) && charge(pathBudget, PAIR_UNITS) && globMatches(glob, path, pathBudget);
  }
  return (path, pathBudget) =>
    Boolean(path) && charge(pathBudget, PAIR_UNITS) && plainStrength(path, pattern, pathBudget) > 0;
}

/**
 * Whether a normalized changed-file path falls under a normalized appliesTo entry: a glob
 * (`*`, `**`, `?`) must match the whole path; a plain path matches itself, files under it as a
 * directory, or a path-segment suffix.
 */
export function matchesAppliesTo(path: string, pattern: string): boolean {
  return compileAppliesTo(pattern)(path);
}

/**
 * How strongly a normalized appliesTo entry covers a normalized path, the rule work_recall ranks by: a glob matching
 * the whole path 0.8; a plain entry equal to it 1, either one a path-segment suffix of the other 0.8, either one a
 * directory containing the other 0.6; otherwise 0.
 */
export function appliesToStrength(pattern: string, path: string, budget?: AppliesToBudget): number {
  if (pattern.length > MAX_APPLIES_TO_ENTRY_LENGTH) {
    if (budget) budget.skippedEntries += 1;
    return 0;
  }
  if (isAppliesToGlob(pattern)) {
    return compileAppliesTo(pattern, budget)(path, budget) ? 0.8 : 0;
  }
  if (!charge(budget, PAIR_UNITS)) return 0;
  return Math.max(plainStrength(pattern, path, budget), plainStrength(path, pattern, budget));
}
