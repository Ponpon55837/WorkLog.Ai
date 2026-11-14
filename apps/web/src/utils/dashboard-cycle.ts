import type { KnowledgePageRecord, TimelineKnowledgeEvent } from "@work-intelligence/core";
import { toDateInputValue } from "./format";

export interface WeekCycleCounts {
  /** Knowledge saved this week. */
  created: number;
  /** Confirmations this week (applied by a Session or confirmed by hand). */
  confirmed: number;
  /** Contradictions this week. */
  contradicted: number;
}

/** Counts this week's Knowledge events as the timeline reports them; the server already limits them to the range. */
export function countKnowledgeEvents(events: readonly TimelineKnowledgeEvent[]): WeekCycleCounts {
  const counts: WeekCycleCounts = { created: 0, confirmed: 0, contradicted: 0 };
  for (const event of events) {
    if (event.kind === "created") counts.created += 1;
    else if (event.kind === "confirmed") counts.confirmed += 1;
    else if (event.kind === "contradicted") counts.contradicted += 1;
  }
  return counts;
}

/**
 * Knowledge pages written inside the inclusive local date range. A page counts once however many versions it
 * gained: the list carries only the last write, and reading every page's versions would cost one request each.
 */
export function countRevisedPages(pages: readonly KnowledgePageRecord[], from: string, to: string): number {
  return pages.filter((page) => {
    if (page.version <= 0 || !page.sourcedThrough) return false;
    const day = toDateInputValue(new Date(page.sourcedThrough));
    return day >= from && day <= to;
  }).length;
}
