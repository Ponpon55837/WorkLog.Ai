import type { KnowledgePageSection } from "@work-intelligence/core";

export type LineDiffKind = "same" | "added" | "removed";

export interface LineDiffEntry {
  kind: LineDiffKind;
  text: string;
}

export type SectionDiffStatus = "added" | "removed" | "changed" | "unchanged";

export interface SectionDiff {
  status: SectionDiffStatus;
  heading: string;
  /** Line-level diff of the content; empty for unchanged sections. */
  lines: LineDiffEntry[];
  addedSourceIds: string[];
  removedSourceIds: string[];
}

export interface KnowledgePageDiff {
  sections: SectionDiff[];
  added: number;
  removed: number;
  changed: number;
}

/** Line diff by longest common subsequence; pages are small, so the quadratic table is fine. */
export function diffLines(before: string, after: string): LineDiffEntry[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const result: LineDiffEntry[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      result.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      result.push({ kind: "removed", text: a[i++]! });
    } else {
      result.push({ kind: "added", text: b[j++]! });
    }
  }
  while (i < a.length) result.push({ kind: "removed", text: a[i++]! });
  while (j < b.length) result.push({ kind: "added", text: b[j++]! });
  return result;
}

function sourceChanges(before: readonly string[], after: readonly string[]) {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    addedSourceIds: [...afterSet].filter((id) => !beforeSet.has(id)),
    removedSourceIds: [...beforeSet].filter((id) => !afterSet.has(id)),
  };
}

/** Compares two versions of a page section by section; sections pair up by heading, in order of occurrence. */
export function diffKnowledgePages(
  previous: readonly KnowledgePageSection[],
  current: readonly KnowledgePageSection[],
): KnowledgePageDiff {
  const unmatched = [...previous];
  const sections: SectionDiff[] = [];
  for (const section of current) {
    const index = unmatched.findIndex((item) => item.heading === section.heading);
    if (index < 0) {
      sections.push({
        status: "added",
        heading: section.heading,
        lines: diffLines("", section.content),
        addedSourceIds: [...new Set(section.sourceSessionIds)],
        removedSourceIds: [],
      });
      continue;
    }
    const [old] = unmatched.splice(index, 1);
    const sources = sourceChanges(old!.sourceSessionIds, section.sourceSessionIds);
    const contentChanged = old!.content !== section.content;
    const unchanged = !contentChanged && sources.addedSourceIds.length === 0 && sources.removedSourceIds.length === 0;
    sections.push({
      status: unchanged ? "unchanged" : "changed",
      heading: section.heading,
      lines: contentChanged ? diffLines(old!.content, section.content) : [],
      ...sources,
    });
  }
  for (const old of unmatched) {
    sections.push({
      status: "removed",
      heading: old.heading,
      lines: diffLines(old.content, ""),
      addedSourceIds: [],
      removedSourceIds: [...new Set(old.sourceSessionIds)],
    });
  }
  const count = (status: SectionDiffStatus) => sections.filter((item) => item.status === status).length;
  return { sections, added: count("added"), removed: count("removed"), changed: count("changed") };
}
