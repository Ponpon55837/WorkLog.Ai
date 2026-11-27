import type { CompiledAppliesToStrength } from "./applies-to-match.js";

/*
 * Only narrows candidates: the caller still runs the entry's strength function on each, and a file left out is one
 * whose strength is provably 0 (a glob needs its literal prefix and suffix; a plain entry shares a whole segment).
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
