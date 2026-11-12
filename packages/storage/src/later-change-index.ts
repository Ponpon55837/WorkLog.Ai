/*
 * The per-call index the Knowledge staleness check reads instead of comparing every appliesTo entry with every file
 * every later Session changed.
 *
 * What it answers. For one appliesTo pattern: which distinct normalized paths the later Sessions changed does it
 * match (compileAppliesToEntry's rule, unchanged), and which Sessions changed any of them. Each Knowledge item then
 * only unions the Session lists of its patterns after its own `since`. The old check tested every pattern against
 * every distinct path (items x patterns x paths); this one tests a pattern only against the paths that can match it.
 *
 * Why the candidates contain every match (the matcher still decides each one, so results are identical):
 *   - A path's segments are its maximal runs between `/` (or its ends). When the call resolves more than one or two
 *     patterns, every distinct path is filed under each of its non-empty segments once (fileSegments); with one or
 *     two, each is simply tested against every distinct path, which is faster than filing them (scansDirectly).
 *   - A plain entry P matches a path F when F equals P, F ends with `/P`, F starts with `P/`, F contains `/P/`, or P
 *     ends with `/F` (plainStrength). In the first four cases P sits in F starting at F's start or after a `/` and
 *     ending at F's end or before a `/`, so each non-empty segment of P (which has no `/` of its own) is a whole
 *     segment of F: every such F is filed under P's rarest segment. In the fifth case F is the text after one of
 *     P's `/`, which is looked up directly.
 *   - A glob matches the whole path and its literal prefix and suffix must be F's first and last code units
 *     (globMatches). A prefix segment followed by `/` inside the prefix starts at F's start or after a `/` and is
 *     followed by a `/`; a suffix segment preceded by `/` inside the suffix ends at F's end or before a `/`. Either
 *     is a whole segment of every matching F. A glob without such a segment is tested against every distinct path.
 * A pattern is resolved once per call, however many items share it, and the index is built for one project and one
 * call: it is never shared across calls or projects, so policy and project scope are decided by the caller as before.
 *
 * Why every Session per path is kept, not only the latest: possiblyStale reports the first later Session after the
 * item's `since` (other than its own) and how many there are, so a per-path latest time would answer "stale or not"
 * but not the count; the union below is linear in the matched paths' Sessions.
 *
 * Accounting (see applies-to-match.ts). Building the index is charged to the call's history budget before each step
 * runs: each Session row, its list's JSON text, hashing each stored path, normalizing a path not seen recently, hashing
 * the normalized path, and (when the segment index is built) splitting each distinct path and filing it under each
 * segment. Resolving patterns is charged to the
 * call's match budget: compiling the entry, splitting it and hashing its segments and suffixes, one unit per candidate
 * plus the matcher's own charges, and the union and sort of the Session lists. Both budgets have fixed limits (STALENESS_HISTORY_UNIT_LIMIT,
 * STALENESS_MATCH_UNIT_LIMIT); a call that reaches either stops and reports the affected items unchecked.
 */
import {
  appliesToPairEstimate,
  chargeAppliesTo,
  chargeNormalizePath,
  chargeStoredJson,
  compileAppliesToEntry,
  type AppliesToBudget,
  type CompiledAppliesTo,
} from "./applies-to-match.js";
import { normalizePath, type PathContext } from "./search-text.js";
import { parseJson } from "./session-record-codecs.js";

/** One later Session: its changed files as stored, and each one's distinct-path id (-1 when it normalizes to ""). */
export interface IndexedSession {
  id: string;
  title: string;
  completedAt: string;
  files: string[];
  pathIds: Int32Array;
}

/** What one appliesTo pattern covers: the distinct paths it matches and every indexed Session that changed one. */
export interface PatternCoverage {
  paths: Set<number>;
  /** Ascending, unique indexes into LaterChangeIndex.sessions. */
  sessions: Int32Array;
}

export interface StalenessUnitLimits {
  history: number;
  match: number;
}

/**
 * The paths a pattern can match: those filed under one segment (-1: under none, so no path) plus `extra`, or every
 * distinct path when `segment` is absent.
 */
interface Candidates {
  segment?: number;
  extra: number[];
}

/**
 * Units one staleness read may spend reading later Sessions into the index (all projects of the call together), set
 * from measurement. The largest legitimate history measured, 5,000 Sessions of 50 distinct 100-character files under a
 * 110-character project root, costs 708M units (0.48 s); 20,000 ordinary Sessions cost 53M. The limit leaves 3.1
 * times the first; reaching it took at most 2.4 s and 380 MB on the development machine (9,200 Sessions of 200
 * distinct two-character paths; 20,500 Sessions of the first shape took 1.7 s).
 */
export const STALENESS_HISTORY_UNIT_LIMIT = 2_200_000_000;

/**
 * Units one staleness read may spend resolving appliesTo patterns against the index. Ordinary reads spend about 1M (a
 * page of 50 over 20,000 ordinary Sessions 1.3M; 5,000 Sessions of 50 distinct files 0.4M), and 200 Sessions of 200
 * distinct 1,000-character files against 50 x 30 entries of 1,000 characters 12.7M. Directory entries that many paths
 * fall under cost far more: a page of 50 over 2,000 Sessions of 50 distinct files, with a directory entry of about
 * 8,000 candidates per item, needed between 50M and 150M in the release review, which is why the ceiling is 300M and
 * not the 50M first chosen. At about 4 ns per unit, reaching it is roughly 1.2 s (estimated from the unit cost).
 */
export const STALENESS_MATCH_UNIT_LIMIT = 300_000_000;

/**
 * Units for the constant work of each Session row, of each stored file, of a new distinct path (its map entries and
 * chain), and of each of its segments (a map lookup, perhaps a new entry), on top of their characters: measured so
 * that one-character paths, many distinct two-character paths, and paths of many distinct segments cost about as much
 * time per unit as ordinary paths (0.4-1.1 ns per unit on the development machine).
 */
const SESSION_UNITS = 2_000;
const FILE_UNITS = 80;
const NEW_PATH_UNITS = 1_000;
const SEGMENT_UNITS = 8;
const NEW_SEGMENT_UNITS = 1_200;
/** Stored paths remembered at a time (pathIdOf); a few hundred cover ordinary history. */
const RECENT_RAW_LIMIT = 4_096;
/** Patterns a call may test against every distinct path instead of building the segment index (scansDirectly). */
const DIRECT_SCAN_PATTERNS = 2;

let limitOverride: Partial<StalenessUnitLimits> | undefined;

/** The non-empty parts of `text` between `/`, from part `first` on, without the last part when `dropLast`. */
function segmentsOf(text: string, first: number, dropLast: boolean): string[] {
  const parts = text.split("/");
  const end = dropLast ? parts.length - 1 : parts.length;
  return parts.slice(first, Math.max(first, end)).filter(Boolean);
}

/** The limits a staleness read uses: the constants, unless a test lowered them. */
export function stalenessUnitLimits(): StalenessUnitLimits {
  return {
    history: limitOverride?.history ?? STALENESS_HISTORY_UNIT_LIMIT,
    match: limitOverride?.match ?? STALENESS_MATCH_UNIT_LIMIT,
  };
}

/** Test instrumentation only: lowers the staleness limits of later reads until called again without arguments. */
export function setStalenessUnitLimits(limits: Partial<StalenessUnitLimits> | undefined): void {
  limitOverride = limits;
}

/** A growable Int32Array. */
class IntList {
  public length = 0;
  public data = new Int32Array(64);

  public push(value: number): number {
    if (this.length === this.data.length) {
      const grown = new Int32Array(this.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data[this.length] = value;
    this.length += 1;
    return this.length - 1;
  }
}

/**
 * Many append-only lists of numbers in a few typed arrays (linked entries), so 100,000 distinct paths do not need
 * 200,000 small arrays. Appending the value a list ended with is a no-op, so each list stays unique when values
 * arrive in ascending order.
 */
class Chains {
  public readonly counts = new IntList();
  private readonly heads = new IntList();
  private readonly tails = new IntList();
  private readonly values = new IntList();
  private readonly nexts = new IntList();

  public create(): number {
    this.heads.push(-1);
    this.tails.push(-1);
    return this.counts.push(0);
  }

  public append(chain: number, value: number): void {
    const tail = this.tails.data[chain]!;
    if (tail >= 0 && this.values.data[tail] === value) return;
    const entry = this.values.push(value);
    this.nexts.push(-1);
    if (tail >= 0) this.nexts.data[tail] = entry;
    else this.heads.data[chain] = entry;
    this.tails.data[chain] = entry;
    this.counts.data[chain]! += 1;
  }

  /** Calls `visit` with each value in order until it returns false. */
  public each(chain: number, visit: (value: number) => boolean): boolean {
    for (let entry = this.heads.data[chain]!; entry >= 0; entry = this.nexts.data[entry]!) {
      if (!visit(this.values.data[entry]!)) return false;
    }
    return true;
  }
}

/** Later Sessions of one project, oldest first, indexed by the distinct paths they changed (see the top comment). */
export class LaterChangeIndex {
  public readonly sessions: IndexedSession[] = [];
  private readonly paths: string[] = [];
  private readonly pathIdByPath = new Map<string, number>();
  /** Recently seen stored paths -> distinct-path id (-1 for ""), so a path stored by many Sessions is normalized once. */
  private readonly recentRaw = new Map<string, number>();
  /** Chain per distinct-path id: the ascending, unique Session indexes that changed it. */
  private readonly sessionsByPath = new Chains();
  /** Chain per non-empty segment: the ascending distinct-path ids that have it as a whole segment. */
  private readonly pathsBySegment = new Chains();
  private readonly segmentIds = new Map<string, number>();
  private readonly coverageByPattern = new Map<string, PatternCoverage>();
  private sessionIndexById?: Map<string, number>;
  private marks?: Uint8Array;
  private pathCharacters = 0;
  private segmentsFiled = false;
  private expectedPatterns = Number.POSITIVE_INFINITY;

  public constructor(
    private readonly contexts: PathContext[],
    private readonly history: AppliesToBudget,
  ) {}

  /**
   * Adds the next later Session; callers add them in ascending completion order. False when its list cannot be read
   * (above the load bound: `changedFilesJson` is null) or the history budget ran out: the index is then incomplete.
   */
  public add(id: string, title: string, completedAt: string, changedFilesJson: string | null): boolean {
    if (changedFilesJson === null || !chargeAppliesTo(this.history, SESSION_UNITS)) return false;
    if (!chargeStoredJson(this.history, changedFilesJson)) return false;
    const index = this.sessions.length;
    const parsed = parseJson<unknown>(changedFilesJson, []);
    const list: unknown[] = Array.isArray(parsed) ? parsed : [];
    // The parsed array is kept as is when every entry is a string (the usual case), instead of copied.
    const files = list.every((file) => typeof file === "string")
      ? (list as string[])
      : list.filter((file): file is string => typeof file === "string");
    const pathIds = new Int32Array(files.length);
    for (let at = 0; at < files.length; at += 1) {
      const pathId = this.pathIdOf(files[at]!);
      if (pathId === undefined) return false;
      pathIds[at] = pathId;
      if (pathId >= 0) this.sessionsByPath.append(pathId, index);
    }
    this.sessions.push({ id, title, completedAt, files, pathIds });
    return true;
  }

  /** How many distinct patterns this call will resolve, so one or two can skip building the segment index. */
  public expect(patternCount: number): void {
    this.expectedPatterns = patternCount;
  }

  /** Index of the first Session completed strictly after `since` (the sessions are in ascending completion order). */
  public firstAfter(since: string): number {
    let low = 0;
    let high = this.sessions.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.sessions[middle]!.completedAt > since) {
        high = middle;
      } else {
        low = middle + 1;
      }
    }
    return low;
  }

  public indexOfSession(id: string): number | undefined {
    this.sessionIndexById ??= new Map(this.sessions.map((session, index) => [session.id, index]));
    return this.sessionIndexById.get(id);
  }

  /**
   * What a normalized pattern covers, resolved once per call; undefined when the match budget ran out first (the
   * answer would be partial). Only the candidates the top comment proves complete are tested.
   */
  public coverage(pattern: string, budget: AppliesToBudget): PatternCoverage | undefined {
    const cached = this.coverageByPattern.get(pattern);
    if (cached) return cached;
    const entry = compileAppliesToEntry(pattern, budget);
    if (budget.exhausted) return undefined;
    const paths = new Set<number>();
    if (!entry.never) {
      const direct = this.scansDirectly(pattern, budget);
      if (!direct && !this.fileSegments()) return undefined;
      const candidates = direct
        ? { extra: [] }
        : entry.glob
          ? this.globCandidates(entry, budget)
          : this.plainCandidates(pattern, budget);
      if (candidates === undefined) return undefined;
      const test = (pathId: number): boolean => {
        if (!paths.has(pathId) && entry.matches(this.paths[pathId]!, budget)) paths.add(pathId);
        return !budget.exhausted;
      };
      if (candidates.segment === undefined) {
        if (!chargeAppliesTo(budget, this.paths.length + 1)) return undefined;
        for (let pathId = 0; pathId < this.paths.length; pathId += 1) if (!test(pathId)) return undefined;
      } else {
        const count = candidates.segment < 0 ? 0 : this.pathsBySegment.counts.data[candidates.segment]!;
        if (!chargeAppliesTo(budget, count + candidates.extra.length + 1)) return undefined;
        if (candidates.segment >= 0 && !this.pathsBySegment.each(candidates.segment, test)) return undefined;
        for (const pathId of candidates.extra) if (!test(pathId)) return undefined;
      }
    }
    const sessions = this.sessionsOf(paths, budget);
    if (!sessions) return undefined;
    const result = { paths, sessions };
    this.coverageByPattern.set(pattern, result);
    return result;
  }

  /** A stored path's distinct-path id, charged to the history budget; undefined when it ran out. */
  private pathIdOf(raw: string): number | undefined {
    // The lookup hashes the stored string once; the constant covers the file's entry in its Session.
    if (!chargeAppliesTo(this.history, raw.length + FILE_UNITS)) return undefined;
    const known = this.recentRaw.get(raw);
    if (known !== undefined) return known;
    if (!chargeNormalizePath(this.history, raw, this.contexts)) return undefined;
    const path = normalizePath(raw, this.contexts);
    let pathId = -1;
    if (path) {
      // Hashing the path; a new one is read once more when its segments are filed (fileSegments charges them).
      if (!chargeAppliesTo(this.history, path.length + 1)) return undefined;
      pathId = this.pathIdByPath.get(path) ?? -1;
      if (pathId < 0) {
        if (!chargeAppliesTo(this.history, NEW_PATH_UNITS)) return undefined;
        pathId = this.addPath(path);
      }
    }
    // Bounded: ordinary history repeats a few hundred paths, which stay; distinct paths would only grow the map.
    if (this.recentRaw.size >= RECENT_RAW_LIMIT) this.recentRaw.clear();
    this.recentRaw.set(raw, pathId);
    return pathId;
  }

  private addPath(path: string): number {
    const pathId = this.sessionsByPath.create();
    this.paths.push(path);
    this.pathIdByPath.set(path, pathId);
    this.pathCharacters += path.length;
    return pathId;
  }

  /**
   * Whether `pattern` is cheaper to test against every distinct path than to resolve through the segment index, which
   * is then never built: only when the call resolves at most DIRECT_SCAN_PATTERNS patterns (a single Knowledge read
   * usually has one or two) and the scan's ordinary cost (a pair's constant work, the pattern, and twice each path for
   * a plain entry's segment search) stays under half of what the match budget has left. The scan is charged as it
   * runs either way.
   */
  private scansDirectly(pattern: string, budget: AppliesToBudget): boolean {
    if (this.segmentsFiled || this.expectedPatterns > DIRECT_SCAN_PATTERNS) return false;
    const estimate = this.paths.length * appliesToPairEstimate(0, pattern.length) + 2 * this.pathCharacters;
    return estimate <= (budget.limit - budget.units) / 2;
  }

  /** Files every distinct path under each of its segments, once per call; false when the history budget ran out. */
  private fileSegments(): boolean {
    if (this.segmentsFiled) return true;
    if (this.history.exhausted) return false;
    for (let pathId = 0; pathId < this.paths.length; pathId += 1) {
      const path = this.paths[pathId]!;
      let start = 0;
      for (let at = 0; at <= path.length; at += 1) {
        if (at < path.length && path.charCodeAt(at) !== 47) continue;
        if (at > start) {
          if (!chargeAppliesTo(this.history, at - start + SEGMENT_UNITS)) return false;
          const segment = path.slice(start, at);
          let segmentId = this.segmentIds.get(segment);
          if (segmentId === undefined) {
            if (!chargeAppliesTo(this.history, NEW_SEGMENT_UNITS)) return false;
            segmentId = this.pathsBySegment.create();
            this.segmentIds.set(segment, segmentId);
          }
          this.pathsBySegment.append(segmentId, pathId);
        }
        start = at + 1;
      }
    }
    this.segmentsFiled = true;
    return true;
  }

  /**
   * The rarest of `segments` (-1 when one of them is on no path: then nothing has them all), or no segment when
   * there is none to narrow by; undefined when unaffordable.
   */
  private rarest(segments: string[], budget: AppliesToBudget): { segment?: number } | undefined {
    let best: number | undefined;
    for (const segment of segments) {
      if (!chargeAppliesTo(budget, segment.length + 1)) return undefined;
      const segmentId = this.segmentIds.get(segment) ?? -1;
      if (segmentId < 0) return { segment: -1 };
      if (best === undefined || this.pathsBySegment.counts.data[segmentId]! < this.pathsBySegment.counts.data[best]!) {
        best = segmentId;
      }
    }
    return best === undefined ? {} : { segment: best };
  }

  /** Every path a plain entry can match: its rarest segment's paths, plus each text after one of its `/`. */
  private plainCandidates(pattern: string, budget: AppliesToBudget): Candidates | undefined {
    if (!chargeAppliesTo(budget, 2 * pattern.length + 1)) return undefined;
    const filed = this.rarest(segmentsOf(pattern, 0, false), budget);
    if (filed === undefined) return undefined;
    if (filed.segment === undefined) return { extra: [] };
    const extra: number[] = [];
    for (let at = pattern.indexOf("/"); at >= 0; at = pattern.indexOf("/", at + 1)) {
      const suffix = pattern.slice(at + 1);
      if (!chargeAppliesTo(budget, suffix.length + 1)) return undefined;
      const pathId = this.pathIdByPath.get(suffix);
      if (pathId !== undefined) extra.push(pathId);
    }
    return { segment: filed.segment, extra };
  }

  /** Every path a glob can match: the rarest whole segment of its literal prefix or suffix, else every path. */
  private globCandidates(entry: CompiledAppliesTo, budget: AppliesToBudget): Candidates | undefined {
    const { prefix, suffix } = entry.glob!;
    if (!chargeAppliesTo(budget, 2 * (prefix.length + suffix.length) + 1)) return undefined;
    // The prefix's last part runs into a wildcard and the suffix's first part comes out of one: neither is whole.
    const filed = this.rarest([...segmentsOf(prefix, 0, true), ...segmentsOf(suffix, 1, false)], budget);
    return filed && { ...filed, extra: [] };
  }

  /** The ascending union of the Sessions that changed `paths`, charged before it is built and sorted. */
  private sessionsOf(paths: Set<number>, budget: AppliesToBudget): Int32Array | undefined {
    if (!chargeAppliesTo(budget, paths.size + 1)) return undefined;
    let total = 0;
    for (const pathId of paths) total += this.sessionsByPath.counts.data[pathId]!;
    const sortUnits = total * Math.ceil(Math.log2(total + 2));
    if (!chargeAppliesTo(budget, 2 * total + sortUnits + 1)) return undefined;
    if (!this.marks || this.marks.length < this.sessions.length) this.marks = new Uint8Array(this.sessions.length);
    const marks = this.marks;
    const union: number[] = [];
    const visit = (sessionIndex: number): boolean => {
      if (!marks[sessionIndex]) {
        marks[sessionIndex] = 1;
        union.push(sessionIndex);
      }
      return true;
    };
    for (const pathId of paths) this.sessionsByPath.each(pathId, visit);
    for (const sessionIndex of union) marks[sessionIndex] = 0;
    return Int32Array.from(union).sort();
  }
}
