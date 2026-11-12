/*
 * Matching normalized paths against normalized appliesTo entries. A glob must match the whole path; a plain entry
 * matches by path segments. Stored patterns come from Agents and imports, so the cost of one match is bounded in
 * three layers: exact rejections that never run the matcher, a star bound above which a glob never matches, and a
 * step budget that a whole scan shares.
 */
import {
  appliesToGlobStarCount,
  isAppliesToGlob,
  MAX_APPLIES_TO_GLOB_STARS,
  tokenizeAppliesToGlob,
  type AppliesToGlobToken,
} from "@work-intelligence/core";
import { pathMatchStrength } from "./search-text.js";

/**
 * Work one scan may spend on appliesTo matching, counted in deterministic steps rather than time: each pattern and
 * path pair costs one step, and every path character the glob simulation reads costs one step per pattern token.
 * When the next charge would pass `limit`, `exhausted` is set and that match and every later one report no match,
 * so the scan stops and says it was cut short.
 */
export interface AppliesToBudget {
  readonly limit: number;
  steps: number;
  exhausted: boolean;
}

/** Tests a normalized path; with a budget, the match is charged to it and is false once the budget is spent. */
export type AppliesToMatcher = (path: string, budget?: AppliesToBudget) => boolean;

/** A glob split around its wildcards, so the exact rejections run before the simulation. */
interface CompiledGlob {
  /** Over MAX_APPLIES_TO_GLOB_STARS: never matches. */
  overComplex: boolean;
  /** Literal code units before the first wildcard and after the last one. */
  prefix: string;
  suffix: string;
  /** The tokens from the first wildcard to the last, inclusive. */
  middle: AppliesToGlobToken[];
  /** Maximal literal runs inside `middle`, in pattern order. */
  literals: string[];
  /** Code units every match has: one per literal and per `?`. */
  minLength: number;
}

/**
 * Knowledge rows one appliesTo scan reads at most, newest first: the scans run in memory on caller-supplied paths,
 * so their cost stays bounded however many Knowledge items the tracked projects hold.
 */
export const APPLIES_TO_SCAN_LIMIT = 2_000;

/**
 * Steps one caller-path scan may spend. On a copy of real data the heaviest one (20 changed paths against every stored
 * entry) spent 4,332 steps; this allows about 460 times that, roughly 20 ms of simulation, and stops a crafted pattern
 * long before it can hold the event loop (30 such patterns against 20 long paths took over 3 s unbounded).
 */
export const APPLIES_TO_MATCH_STEP_LIMIT = 2_000_000;

// Staleness checks test the same few appliesTo globs against every changed file of every later Session,
// so compile each glob once. The bound only guards against unbounded growth; real projects use a handful.
const GLOB_CACHE_LIMIT = 512;
const globCache = new Map<string, CompiledGlob>();

function isStar(token: AppliesToGlobToken): boolean {
  return token.kind === "segment" || token.kind === "any";
}

function literalRun(tokens: readonly AppliesToGlobToken[]): string {
  return tokens.map((token) => (token.kind === "literal" ? token.char : "")).join("");
}

function compileGlob(pattern: string): CompiledGlob {
  const cached = globCache.get(pattern);
  if (cached) {
    return cached;
  }
  const tokens = tokenizeAppliesToGlob(pattern);
  const first = tokens.findIndex((token) => token.kind !== "literal");
  let last = tokens.length - 1;
  while (tokens[last]?.kind === "literal") last -= 1;
  const middle = tokens.slice(first, last + 1);
  const literals: string[] = [];
  let run = "";
  for (const token of middle) {
    if (token.kind === "literal") {
      run += token.char;
    } else if (run) {
      literals.push(run);
      run = "";
    }
  }
  const compiled: CompiledGlob = {
    overComplex: appliesToGlobStarCount(tokens) > MAX_APPLIES_TO_GLOB_STARS,
    prefix: literalRun(tokens.slice(0, first)),
    suffix: literalRun(tokens.slice(last + 1)),
    middle,
    literals,
    minLength: tokens.filter((token) => !isStar(token)).length,
  };
  if (globCache.size >= GLOB_CACHE_LIMIT) {
    globCache.clear();
  }
  globCache.set(pattern, compiled);
  return compiled;
}

/** Charges `cost` steps; false (and the budget marked spent) when that would pass its limit. */
function charge(budget: AppliesToBudget | undefined, cost: number): boolean {
  if (!budget) return true;
  if (budget.exhausted || budget.steps + cost > budget.limit) {
    budget.exhausted = true;
    return false;
  }
  budget.steps += cost;
  return true;
}

/** Characters `.` in a JavaScript RegExp without the `s` flag does not match; `**` has always excluded them. */
function isLineTerminator(char: string): boolean {
  return char === "\n" || char === "\r" || char === " " || char === " ";
}

/**
 * Whether `path[start, end)` matches `tokens` whole, by simulating every pattern position at once (a Thompson-style
 * NFA walk), so a pattern full of stars costs O(tokens x characters) instead of exponential regex backtracking.
 * Works on UTF-16 code units, like the anchored RegExp it replaced.
 */
function simulate(
  tokens: readonly AppliesToGlobToken[],
  path: string,
  start: number,
  end: number,
  budget: AppliesToBudget | undefined,
): boolean {
  const accept = tokens.length;
  let active = new Uint8Array(accept + 1);
  let next = new Uint8Array(accept + 1);
  // A star may match nothing, so each active star also activates the position after it.
  const close = (states: Uint8Array): void => {
    for (let index = 0; index < accept; index += 1) {
      if (states[index] && isStar(tokens[index]!)) states[index + 1] = 1;
    }
  };
  active[0] = 1;
  close(active);
  for (let offset = start; offset < end; offset += 1) {
    if (!charge(budget, accept)) return false;
    const char = path[offset]!;
    next.fill(0);
    let alive = false;
    for (let index = 0; index < accept; index += 1) {
      if (!active[index]) continue;
      const token = tokens[index]!;
      if (token.kind === "literal") {
        if (token.char === char) next[index + 1] = 1;
      } else if (token.kind === "one") {
        if (char !== "/") next[index + 1] = 1;
      } else if (token.kind === "segment") {
        if (char !== "/") next[index] = 1;
      } else if (!isLineTerminator(char)) {
        next[index] = 1;
      }
    }
    close(next);
    for (let index = 0; index <= accept; index += 1) alive ||= next[index] === 1;
    if (!alive) return false;
    [active, next] = [next, active];
  }
  return active[accept] === 1;
}

/**
 * Whole-path glob match. The rejections before the simulation are exact, never heuristics: every literal and `?`
 * consumes one code unit and stars consume zero or more, so a shorter path cannot match; the tokens before the first
 * wildcard and after the last are literals that must be the path's first and last code units (minLength keeps the
 * two apart); and the middle tokens must match the code units between them, which contain each literal run of the
 * middle in pattern order without overlap. A leftmost search for each run, starting where the previous one ended,
 * finds such a placement whenever one exists, so a failed search proves there is no match.
 */
function globMatches(glob: CompiledGlob, path: string, budget: AppliesToBudget | undefined): boolean {
  if (glob.overComplex || path.length < glob.minLength) return false;
  if (!path.startsWith(glob.prefix) || !path.endsWith(glob.suffix)) return false;
  const start = glob.prefix.length;
  const end = path.length - glob.suffix.length;
  let from = start;
  for (const literal of glob.literals) {
    const at = path.indexOf(literal, from);
    if (at < 0 || at + literal.length > end) return false;
    from = at + literal.length;
  }
  return simulate(glob.middle, path, start, end, budget);
}

/** A budget for one scan; see AppliesToBudget. */
export function createAppliesToBudget(limit = APPLIES_TO_MATCH_STEP_LIMIT): AppliesToBudget {
  return { limit, steps: 0, exhausted: false };
}

/** Precompiles a normalized appliesTo entry into a matcher, for checking one pattern against many paths. */
export function compileAppliesTo(pattern: string): AppliesToMatcher {
  if (!pattern) {
    return () => false;
  }
  if (isAppliesToGlob(pattern)) {
    const glob = compileGlob(pattern);
    return (path, budget) => Boolean(path) && charge(budget, 1) && globMatches(glob, path, budget);
  }
  return (path, budget) => Boolean(path) && charge(budget, 1) && pathMatchStrength(path, pattern) > 0;
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
  if (isAppliesToGlob(pattern)) {
    return compileAppliesTo(pattern)(path, budget) ? 0.8 : 0;
  }
  if (!charge(budget, 1)) return 0;
  return Math.max(pathMatchStrength(pattern, path), pathMatchStrength(path, pattern));
}
