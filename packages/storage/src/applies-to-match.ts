/*
 * Every operation whose cost grows with a stored entry or a caller path is charged to the scan budget BEFORE it
 * runs, so an exhausted budget stops the loop and `units` never passes `limit`; stored patterns come from Agents and
 * imports, so the weights per operation are measured costs and must not be lowered without re-measuring.
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
  MAX_STORED_APPLIES_TO_ENTRIES,
  MAX_STORED_APPLIES_TO_ENTRY_LENGTH,
  tokenizeAppliesToGlobCompact,
} from "@work-intelligence/core";
import { normalizePath, type PathContext } from "./search-text.js";

export interface AppliesToBudget {
  limit: number;
  units: number;
  exhausted: boolean;
  skippedEntries: number;
}

export type AppliesToMatcher = (path: string, budget?: AppliesToBudget) => boolean;

export interface CompiledAppliesTo {
  matches: AppliesToMatcher;
  never: boolean;
  glob?: { prefix: string; suffix: string };
}

export interface AppliesToWorkCounter {
  examined: number;
}

interface CompiledGlob {
  overComplex: boolean;
  prefix: string;
  suffix: string;
  kinds: Uint8Array;
  codes: Uint16Array;
  literals: string[];
  failures: Uint16Array[];
  minLength: number;
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

export const APPLIES_TO_SCAN_LIMIT = 2_000;

/** @internal test-only */
export const APPLIES_TO_MATCH_UNIT_LIMIT = 20_000_000;

/**
 * A fixed total cut legitimate 20,000-Session history short, so knowledgeToReview grants this times the ordinary cost
 * before each row: ordinary work uses at most a third, while a crafted entry still runs out.
 */
export const APPLIES_TO_GRANT_FACTOR = 3;

/** @internal test-only */
export const MAX_STORED_APPLIES_TO_JSON_BYTES =
  MAX_STORED_APPLIES_TO_ENTRIES * (6 * MAX_STORED_APPLIES_TO_ENTRY_LENGTH + 3) + 2;

/** The write limit (200 paths of 1,000 characters) with every character a six-byte JSON escape. */
export const MAX_STORED_CHANGED_FILES_JSON_BYTES = 200 * (6 * 1_000 + 3) + 2;

const JSON_UNITS_PER_CHAR = 4;
const NORMALIZE_UNITS_PER_CHAR = 4;
const COMPILE_UNITS_PER_CHAR = 16;
const PAIR_UNITS = 12;

// Second-chance eviction: a scan of many distinct long patterns evicts one entry per (charged) miss instead of
// clearing the cache, and a hit costs no reordering.
const CACHE_LIMIT = 512;
const CACHE_CHARACTERS = 256_000;
const globCache = createBoundedCache<CompiledGlob>();
const segmentCache = createBoundedCache<{ word: string; failure: Uint16Array }>();

let activeStates = new Uint8Array(64);
let nextStates = new Uint8Array(64);

let workCounter: AppliesToWorkCounter | undefined;
let budgetProbe: AppliesToBudget[] | undefined;

function isStarKind(kind: number): boolean {
  return kind === APPLIES_TO_TOKEN_SEGMENT || kind === APPLIES_TO_TOKEN_ANY;
}

/** Characters `.` in a RegExp without the `s` flag does not match; `**` has always excluded them. */
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
      // Not charged: it runs only after a charged miss, and its moves are amortized within what hits and misses paid.
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

function hasAt(text: string, at: number, word: string): boolean {
  if (at < 0 || at + word.length > text.length) return false;
  let index = 0;
  while (index < word.length && text.charCodeAt(at + index) === word.charCodeAt(index)) index += 1;
  count(Math.min(index + 1, word.length));
  return index === word.length;
}

function chargedHasAt(text: string, at: number, word: string, budget: AppliesToBudget | undefined): boolean {
  return charge(budget, word.length) && hasAt(text, at, word);
}

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

function cachedGlob(pattern: string, budget: AppliesToBudget | undefined): CompiledGlob | undefined {
  const cached = globCache.get(pattern);
  if (cached) return charge(budget, 1) ? cached : undefined;
  if (!charge(budget, COMPILE_UNITS_PER_CHAR * pattern.length + 1)) return undefined;
  const compiled = compileGlob(pattern);
  globCache.set(pattern, compiled, compiled.size);
  return compiled;
}

function chargedIsGlob(pattern: string, budget: AppliesToBudget | undefined): boolean | undefined {
  if (globCache.get(pattern)) return true;
  if (!charge(budget, pattern.length)) return undefined;
  return isAppliesToGlob(pattern);
}

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

/** An NFA walk over every pattern position at once, so a star-heavy pattern costs O(tokens x characters), never exponential. */
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

/** The rejections before the simulation are exact, never heuristics: a failed check proves there is no match. */
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

export function createAppliesToBudget(limit = APPLIES_TO_MATCH_UNIT_LIMIT): AppliesToBudget {
  const budget = { limit, units: 0, exhausted: false, skippedEntries: 0 };
  budgetProbe?.push(budget);
  return budget;
}

/** @internal test-only */
export function setAppliesToBudgetProbe(probe: AppliesToBudget[] | undefined): void {
  budgetProbe = probe;
}

export function appliesToScanIncomplete(budget: AppliesToBudget): boolean {
  return budget.exhausted || budget.skippedEntries > 0;
}

export function grantAppliesTo(budget: AppliesToBudget, units: number): void {
  if (!budget.exhausted) budget.limit += units;
}

export function appliesToPairEstimate(pathLength: number, patternLength: number): number {
  return PAIR_UNITS + pathLength + patternLength;
}

export function chargeGrantedAppliesTo(budget: AppliesToBudget, units: number): boolean {
  grantAppliesTo(budget, APPLIES_TO_GRANT_FACTOR * units);
  return charge(budget, units);
}

export function chargeAppliesTo(budget: AppliesToBudget, units: number): boolean {
  return charge(budget, units);
}

/** @internal test-only */
export function setAppliesToWorkCounter(counter: AppliesToWorkCounter | undefined): void {
  workCounter = counter;
}

export function storedAppliesTo(
  stored: string | null,
  contexts: PathContext[],
  budget: AppliesToBudget,
): Array<{ raw: string; pattern: string }> {
  // appliesToColumnSql found the text above MAX_STORED_APPLIES_TO_JSON_BYTES and did not load it.
  if (stored === null) {
    budget.skippedEntries += 1;
    return [];
  }
  if (!charge(budget, JSON_UNITS_PER_CHAR * stored.length + 1)) return [];
  let list: unknown;
  try {
    list = JSON.parse(stored);
  } catch {
    return [];
  }
  return Array.isArray(list) ? normalizedAppliesTo(list, contexts, budget) : [];
}

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

/** octet_length reads only the record header, so a value above the bound is never loaded into memory. */
export function appliesToColumnSql(column: string): string {
  return `CASE WHEN octet_length(${column}) > ${MAX_STORED_APPLIES_TO_JSON_BYTES} THEN NULL ELSE COALESCE(${column}, '[]') END`;
}

export function chargeStoredJson(budget: AppliesToBudget, text: string, granted = false): boolean {
  const units = JSON_UNITS_PER_CHAR * text.length + 1;
  return granted ? chargeGrantedAppliesTo(budget, units) : charge(budget, units);
}

export function chargeNormalizePath(
  budget: AppliesToBudget,
  path: string,
  contexts: PathContext[],
  granted = false,
): boolean {
  const context = contexts.reduce((total, item) => total + item.name.length + item.rootPath.length, 0);
  const units = NORMALIZE_UNITS_PER_CHAR * (path.length + context) + 1;
  return granted ? chargeGrantedAppliesTo(budget, units) : charge(budget, units);
}

export function classifyAppliesTo(pattern: string, budget: AppliesToBudget): boolean | undefined {
  return chargedIsGlob(pattern, budget);
}

export function appliesToEntries(stored: string | null, contexts: PathContext[], budget: AppliesToBudget): string[] {
  return storedAppliesTo(stored, contexts, budget).map((entry) => entry.pattern);
}

export function compileAppliesToEntry(pattern: string, budget?: AppliesToBudget): CompiledAppliesTo {
  const never = { matches: () => false, never: true };
  if (!pattern) {
    return never;
  }
  if (pattern.length > MAX_APPLIES_TO_ENTRY_LENGTH) {
    if (budget) budget.skippedEntries += 1;
    return never;
  }
  const isGlob = chargedIsGlob(pattern, budget);
  if (isGlob === undefined) return never;
  if (isGlob) {
    const glob = cachedGlob(pattern, budget);
    if (!glob) return never;
    return {
      // An over-complex glob still charges each pair; globMatches rejects it first.
      matches: (path, pathBudget) =>
        Boolean(path) && charge(pathBudget, PAIR_UNITS) && globMatches(glob, path, pathBudget),
      never: glob.overComplex,
      glob: { prefix: glob.prefix, suffix: glob.suffix },
    };
  }
  return {
    matches: (path, pathBudget) =>
      Boolean(path) && charge(pathBudget, PAIR_UNITS) && plainStrength(path, pattern, pathBudget) > 0,
    never: false,
  };
}

export function compileAppliesTo(pattern: string, budget?: AppliesToBudget): AppliesToMatcher {
  return compileAppliesToEntry(pattern, budget).matches;
}

/** @internal test-only */
export function matchesAppliesTo(path: string, pattern: string): boolean {
  return compileAppliesTo(pattern)(path);
}

export function appliesToStrength(pattern: string, path: string, budget?: AppliesToBudget): number {
  if (pattern.length > MAX_APPLIES_TO_ENTRY_LENGTH) {
    if (budget) budget.skippedEntries += 1;
    return 0;
  }
  const isGlob = chargedIsGlob(pattern, budget);
  if (isGlob === undefined) return 0;
  if (isGlob) return compileAppliesTo(pattern, budget)(path, budget) ? 0.8 : 0;
  if (!charge(budget, PAIR_UNITS)) return 0;
  return Math.max(plainStrength(pattern, path, budget), plainStrength(path, pattern, budget));
}

export type AppliesToStrengthMatcher = (path: string, budget?: AppliesToBudget) => number;

export function compileAppliesToStrength(pattern: string, budget?: AppliesToBudget): AppliesToStrengthMatcher {
  return compileAppliesToStrengthEntry(pattern, budget).strength;
}

export interface CompiledAppliesToStrength {
  strength: AppliesToStrengthMatcher;
  never: boolean;
  glob?: { prefix: string; suffix: string };
}

export function compileAppliesToStrengthEntry(pattern: string, budget?: AppliesToBudget): CompiledAppliesToStrength {
  const never: CompiledAppliesToStrength = { strength: () => 0, never: true };
  if (pattern.length > MAX_APPLIES_TO_ENTRY_LENGTH) {
    if (budget) budget.skippedEntries += 1;
    return never;
  }
  const isGlob = chargedIsGlob(pattern, budget);
  if (isGlob === undefined) return never;
  if (isGlob) {
    const compiled = compileAppliesToEntry(pattern, budget);
    return {
      strength: (path, pathBudget) => (compiled.matches(path, pathBudget) ? 0.8 : 0),
      never: compiled.never,
      glob: compiled.glob,
    };
  }
  return {
    strength: (path, pathBudget) =>
      charge(pathBudget, PAIR_UNITS)
        ? Math.max(plainStrength(pattern, path, pathBudget), plainStrength(path, pattern, pathBudget))
        : 0,
    never: false,
  };
}
