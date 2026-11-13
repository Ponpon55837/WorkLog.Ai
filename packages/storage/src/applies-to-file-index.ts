import type { CompiledAppliesToStrength } from "./applies-to-match.js";

/**
 * A per-call index over normalized file paths that answers "which files can this appliesTo entry cover at all", so a
 * scan tests each entry only against those instead of every file. It only narrows the candidates: the caller still
 * runs the entry's own strength function on each (so strengths and budget charges stay appliesToStrength's), and a
 * file left out here is one whose strength is provably 0. Every path is normalized (lower-cased, `/` separators), so
 * all comparisons are exact code-unit comparisons, as in the matcher.
 *
 * Why the candidates are complete:
 *   - a glob matches only paths that start with its literal prefix and end with its literal suffix (globMatches
 *     rejects the rest first), so the files in the sorted prefix range that also end with the suffix are all it can
 *     match; an empty prefix means every file;
 *   - a plain entry `p` has strength > 0 against file `f` only if `f` equals `p`, one is a path-segment suffix of the
 *     other, or one lies in a directory the other names (`f` starts with or contains `/p/`, or `p` starts with or
 *     contains `/f/`). Equality and both suffix cases make the last segments equal, and `f` being a run of segments
 *     of `p` makes `f`'s last segment one of `p`'s segments, so files indexed by last segment, looked up with each
 *     segment of `p`, cover them. `p` being a directory of `f` makes every non-empty segment of `p` a segment of
 *     `f`, so the files indexed by segment, looked up with the rarest segment of `p`, cover that case. A plain entry
 *     without a non-empty segment falls back to every file.
 *
 * Cost: building is O(F x d) for F files of depth d (plus one sort, O(F log F)); an entry then costs O(d + log F +
 * candidates), and the candidates are the files that can match, not F.
 */
function push(map: Map<string, number[]>, key: string, position: number): void {
  const list = map.get(key);
  if (list) list.push(position);
  else map.set(key, [position]);
}

function ascending(left: number, right: number): number {
  return left - right;
}

export class AppliesToFileIndex {
  private readonly files: readonly string[];
  /** File positions ordered by path, for prefix range lookup. */
  private readonly sorted: number[];
  private readonly byLastSegment = new Map<string, number[]>();
  private readonly bySegment = new Map<string, number[]>();
  private readonly all: number[];

  public constructor(files: readonly string[]) {
    this.files = files;
    this.all = files.map((_, position) => position);
    this.sorted = [...this.all].sort((left, right) => (files[left]! < files[right]! ? -1 : 1));
    for (const [position, file] of files.entries()) {
      const segments = file.split("/");
      push(this.byLastSegment, segments[segments.length - 1]!, position);
      for (const segment of new Set(segments)) if (segment) push(this.bySegment, segment, position);
    }
  }

  /** Positions (ascending, no duplicates) of the files `entry` can cover; `plain` is the entry's normalized text. */
  public candidates(entry: CompiledAppliesToStrength, plain: string): number[] {
    if (entry.never) return [];
    if (entry.glob) return this.globCandidates(entry.glob.prefix, entry.glob.suffix);
    return this.plainCandidates(plain);
  }

  private globCandidates(prefix: string, suffix: string): number[] {
    if (!prefix && !suffix) return this.all;
    const found: number[] = [];
    let low = 0;
    let high = this.sorted.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.files[this.sorted[middle]!]! < prefix) low = middle + 1;
      else high = middle;
    }
    for (let at = low; at < this.sorted.length; at += 1) {
      const position = this.sorted[at]!;
      const file = this.files[position]!;
      if (!file.startsWith(prefix)) break;
      if (!suffix || file.endsWith(suffix)) found.push(position);
    }
    return found.sort(ascending);
  }

  private plainCandidates(pattern: string): number[] {
    const segments = [...new Set(pattern.split("/"))].filter(Boolean);
    if (segments.length === 0) return this.all;
    const found = new Set<number>();
    for (const segment of segments) for (const position of this.byLastSegment.get(segment) ?? []) found.add(position);
    let rarest: number[] | undefined;
    for (const segment of segments) {
      const list = this.bySegment.get(segment);
      if (!list) {
        rarest = [];
        break;
      }
      if (!rarest || list.length < rarest.length) rarest = list;
    }
    for (const position of rarest ?? []) found.add(position);
    return [...found].sort(ascending);
  }
}
