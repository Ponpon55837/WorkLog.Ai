import type { DatabaseSync } from "node:sqlite";
import type { KnowledgeAppliesToBreadth, KnowledgeWriteBreadth } from "@work-intelligence/core";
import {
  chargeAppliesTo,
  createAppliesToBudget,
  MAX_STORED_CHANGED_FILES_JSON_BYTES,
  normalizedAppliesTo,
  type AppliesToBudget,
} from "./applies-to-match.js";
import { LaterChangeIndex, stalenessUnitLimits, type PatternCoverage } from "./later-change-index.js";
import { CHANGED_FILES_NORMAL } from "./search-repository.js";
import type { PathContext } from "./search-text.js";

export interface AppliesToBreadthScan {
  /** Absent when appliesTo has no usable entry, the project has no Session to compare, or the scan was unchecked. */
  breadth?: KnowledgeWriteBreadth;
  /** The share is above BROAD_APPLIES_TO_SHARE over at least MIN_BREADTH_SESSIONS Sessions. */
  broad: boolean;
  /** The history or match budget ran out (or an entry was too large to compare), so nothing is reported. */
  unchecked: boolean;
}

/**
 * An appliesTo that touches more than this share of a project's ordinary Sessions (1 to CHANGED_FILES_NORMAL changed
 * files) is broad: it will be flagged possibly stale by almost any work and offered for tasks it does not describe.
 * Measured on one real project, 19% of appliesTo entries and 29% of Knowledge with appliesTo were this wide; the
 * threshold is the first value chosen from that, not a tuned one.
 */
export const BROAD_APPLIES_TO_SHARE = 0.15;

/**
 * Fewest compared Sessions before a share counts as broad. A share over a handful of Sessions is noise: one touch in
 * the three Sessions after a Knowledge was recorded is 33%, which says nothing about the Knowledge's scope.
 */
export const MIN_BREADTH_SESSIONS = 10;

/** Newest focused Sessions of the project that a write-time breadth check compares; it keeps that read bounded. */
export const BREADTH_SCAN_LIMIT = 200;

/**
 * Sessions with 1 to CHANGED_FILES_NORMAL stored changed files. A stored value that is not valid JSON, not an array,
 * or above the load bound counts as no files, so the filter never throws on damaged rows.
 */
export const FOCUSED_SESSION_SQL = `(CASE WHEN octet_length(changed_files_json) <= ${MAX_STORED_CHANGED_FILES_JSON_BYTES}
                                   AND json_valid(changed_files_json)
                              THEN (CASE WHEN json_type(changed_files_json) = 'array'
                                         THEN json_array_length(changed_files_json) ELSE 0 END)
                              ELSE 0 END) BETWEEN 1 AND ${CHANGED_FILES_NORMAL}`;

/** `touching` of `sessions` as a share rounded to 3 decimals; undefined when there is no Session to compare. */
export function appliesToBreadthOf(touching: number, sessions: number): KnowledgeAppliesToBreadth | undefined {
  if (sessions <= 0) return undefined;
  return { share: Math.round((touching / sessions) * 1000) / 1000, sessions };
}

/** Whether `touching` of `sessions` is above the broad threshold with enough Sessions to mean anything. */
export function isBroadAppliesTo(touching: number, sessions: number): boolean {
  return sessions >= MIN_BREADTH_SESSIONS && touching / sessions > BROAD_APPLIES_TO_SHARE;
}

/** The newest focused Sessions of an index that a breadth is measured over: from index `start`, `sessions` of them. */
export interface BreadthWindow {
  start: number;
  sessions: number;
}

/** The window of the newest BREADTH_SCAN_LIMIT focused Sessions of `index` (all of them when there are fewer). */
export function breadthWindowOf(index: LaterChangeIndex): BreadthWindow {
  return index.newestFocusedWindow(BREADTH_SCAN_LIMIT);
}

/**
 * How many Sessions of `window` the resolved patterns touch (the union over the patterns, focused Sessions only),
 * charged to `budget` like every other union; undefined when the budget ran out. The one definition both the
 * write-time scan and the staleness check use, so they cannot drift apart.
 */
export function touchedInWindow(
  index: LaterChangeIndex,
  coverage: readonly PatternCoverage[],
  window: BreadthWindow,
  budget: AppliesToBudget,
): number | undefined {
  const touched = new Set<number>();
  for (const { sessions } of coverage) {
    let low = 0;
    let high = sessions.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (sessions[middle]! >= window.start) high = middle;
      else low = middle + 1;
    }
    if (!chargeAppliesTo(budget, sessions.length - low + 1)) return undefined;
    for (let at = low; at < sessions.length; at += 1) if (index.isFocused(sessions[at]!)) touched.add(sessions[at]!);
  }
  return touched.size;
}

/** The English hint an Agent gets when the appliesTo it just wrote is broad. */
export function broadAppliesToWarning(breadth: KnowledgeWriteBreadth): string {
  const percent = Math.round(breadth.share * 100);
  const scope = breadth.truncated ? `the newest ${breadth.sessions}` : `${breadth.sessions}`;
  return (
    `appliesTo touches ${percent}% of this project's recent Sessions (${scope} with 1-${CHANGED_FILES_NORMAL} ` +
    `changed files), so it will often be flagged possibly stale and offered for unrelated tasks. ` +
    `Narrow it to the specific files or subdirectories this Knowledge is about.`
  );
}

/**
 * How much of the project's recent ordinary work `appliesTo` touches: one bounded, read-only scan of the newest
 * BREADTH_SCAN_LIMIT focused Sessions, resolved through the same index and budgets as the staleness check (so the
 * entries are matched by the same rule and a crafted entry stops at the same ceilings). `truncated` is set when the
 * project has more focused Sessions than were scanned. Run after the write commits, never inside its transaction.
 */
export function scanAppliesToBreadth(
  db: DatabaseSync,
  projectId: string,
  contexts: PathContext[],
  appliesTo: readonly string[],
): AppliesToBreadthScan {
  const limits = stalenessUnitLimits();
  const history = createAppliesToBudget(limits.history);
  const budget = createAppliesToBudget(limits.match);
  const skippedBefore = budget.skippedEntries;
  const patterns = [...new Set(normalizedAppliesTo([...appliesTo], contexts, budget).map((entry) => entry.pattern))];
  if (budget.exhausted || budget.skippedEntries > skippedBefore) return { broad: false, unchecked: true };
  if (patterns.length === 0) return { broad: false, unchecked: false };

  const rows = db
    .prepare(
      `SELECT id, title, completed_at, changed_files_json
       FROM sessions
       WHERE project_id = ? AND voided_at IS NULL AND ${FOCUSED_SESSION_SQL}
       ORDER BY completed_at DESC, id DESC
       LIMIT ?`,
    )
    .all(projectId, BREADTH_SCAN_LIMIT + 1) as unknown as Array<{
    id: string;
    title: string;
    completed_at: string;
    changed_files_json: string;
  }>;
  const truncated = rows.length > BREADTH_SCAN_LIMIT;
  const index = new LaterChangeIndex(contexts, history);
  // The index takes Sessions oldest first.
  for (const row of rows.slice(0, BREADTH_SCAN_LIMIT).reverse()) {
    if (!index.add(row.id, row.title, row.completed_at, row.changed_files_json))
      return { broad: false, unchecked: true };
  }
  const window = breadthWindowOf(index);
  if (window.sessions === 0) return { broad: false, unchecked: false };

  index.expect(patterns.length);
  const coverage: PatternCoverage[] = [];
  for (const pattern of patterns) {
    const covered = index.coverage(pattern, budget);
    if (!covered) return { broad: false, unchecked: true };
    coverage.push(covered);
  }
  const touched = touchedInWindow(index, coverage, window, budget);
  if (touched === undefined) return { broad: false, unchecked: true };
  const breadth = appliesToBreadthOf(touched, window.sessions)!;
  const broad = isBroadAppliesTo(touched, window.sessions);
  return { breadth: { ...breadth, truncated, broad }, broad, unchecked: false };
}
