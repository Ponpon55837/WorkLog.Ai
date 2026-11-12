import type { DatabaseSync } from "node:sqlite";
import { isAppliesToGlob, type KnowledgeReviewHint } from "@work-intelligence/core";
import { truncateText } from "@work-intelligence/shared";
import {
  APPLIES_TO_SCAN_LIMIT,
  compileAppliesTo,
  createAppliesToBudget,
  type AppliesToBudget,
} from "./applies-to-match.js";
import { parseJson } from "./session-record-codecs.js";
import { normalizePath, type PathContext } from "./search-text.js";

export interface KnowledgeReviewFocus {
  projectId: string;
  /** The finalized Session: Knowledge it recorded or already gave feedback on is not suggested again. */
  sessionId: string;
  completedAt: string;
  /** The Session's stored changed files. */
  changedFiles: readonly string[];
  project: PathContext;
}

export interface KnowledgeToReview {
  hints: KnowledgeReviewHint[];
  /** The appliesTo match budget ran out before every candidate was checked. */
  truncated: boolean;
}

type KnowledgeAppliesToRow = {
  id: string;
  title: string;
  applies_to_json: string;
  updated_at: string;
  created_at: string;
  session_id: string | null;
  last_confirmed_at: string | null;
  last_confirmed_session_id: string | null;
};
type Candidate = { row: KnowledgeAppliesToRow; strength: number; path: string; appliesTo: string; patterns: string[] };

const KNOWLEDGE_TO_REVIEW_LIMIT = 3;
const KNOWLEDGE_TO_REVIEW_TITLE_CHARS = 120;
/** An appliesTo entry equal to a changed path outranks a glob that matches it. */
const EXACT_STRENGTH = 1;
const GLOB_STRENGTH = 0.8;
const MIN_FRAGMENT_LENGTH = 3;

/** How the entry names the path: equal to it, or a glob that matches it. Directories and suffixes do not count. */
function namedStrength(pattern: string, path: string, budget: AppliesToBudget): number {
  if (isAppliesToGlob(pattern)) return compileAppliesTo(pattern)(path, budget) ? GLOB_STRENGTH : 0;
  return pattern === path ? EXACT_STRENGTH : 0;
}

/**
 * The longest run of plain path characters in a normalized pattern. Every path the pattern covers contains it (a
 * plain entry's last segment survives every equal, suffix, and directory match; a glob matches its literals
 * verbatim), so it can narrow the Session scan in SQL. Plain characters keep the JSON text and ASCII-only lower()
 * identical to the normalized path. Short runs narrow too little and are not used.
 */
function requiredFragment(pattern: string): string | undefined {
  const runs = pattern.match(/[a-z0-9._-]+/g) ?? [];
  const longest = runs.reduce((best, run) => (run.length > best.length ? run : best), "");
  return longest.length >= MIN_FRAGMENT_LENGTH ? longest : undefined;
}

/**
 * The staleness rule of KnowledgeService (later Sessions since the last confirmation or creation, other than the
 * Knowledge's own Sessions, whose changed files an appliesTo entry covers), asked for "anyone but this Session".
 * SQL keeps only Sessions whose changed-files text contains a fragment every covered path has; newer Sessions are
 * read first and the scan stops at the first one that touches the Knowledge.
 */
function newlyInDoubtCheck(
  db: DatabaseSync,
  focus: KnowledgeReviewFocus,
  contexts: PathContext[],
  budget: AppliesToBudget,
): (candidate: Candidate) => boolean {
  const filesBySession = new Map<string, string[]>();
  return ({ row, patterns }) => {
    const since = row.last_confirmed_at ?? row.created_at;
    // A backfilled Session that finished before the Knowledge was confirmed does not put it in doubt.
    if (focus.completedAt <= since) return false;
    const matchers = patterns.map(compileAppliesTo);
    const fragments = patterns.map(requiredFragment);
    const narrowed = fragments.every((fragment) => fragment !== undefined);
    const own = new Set([row.session_id, row.last_confirmed_session_id]);
    const laterSessions = db.prepare(
      `SELECT id, changed_files_json FROM sessions
       WHERE project_id = ? AND voided_at IS NULL AND completed_at > ? AND id <> ?
         ${narrowed ? `AND (${fragments.map(() => "instr(lower(changed_files_json), ?) > 0").join(" OR ")})` : ""}
       ORDER BY completed_at DESC, id DESC`,
    );
    const parameters = [focus.projectId, since, focus.sessionId, ...(narrowed ? (fragments as string[]) : [])];
    for (const session of laterSessions.iterate(...parameters) as Iterable<{
      id: string;
      changed_files_json: string;
    }>) {
      if (own.has(session.id)) continue;
      let sessionFiles = filesBySession.get(session.id);
      if (!sessionFiles) {
        sessionFiles = parseJson<string[]>(session.changed_files_json, []).map((file) => normalizePath(file, contexts));
        filesBySession.set(session.id, sessionFiles);
      }
      if (sessionFiles.some((file) => file && matchers.some((matches) => matches(file, budget)))) return false;
      if (budget.exhausted) return false;
    }
    return true;
  };
}

/**
 * Up to three active Knowledge items of the Session's own project that this Session newly puts in doubt: an appliesTo
 * entry names a changed file (the exact path, or a glob that matches it), and no other Session changed a file the
 * Knowledge covers since it was recorded or last confirmed, so the possiblyStale marker starts with this Session.
 * Knowledge that is already possiblyStale is shown on every read and is not repeated here. Exact matches come first,
 * then the newest. Reads the same newest-first bounded rows as the other appliesTo scans and changes nothing. Both
 * phases share one match budget; when it runs out the hints found so far are returned and `truncated` is set.
 */
export function findKnowledgeToReview(db: DatabaseSync, focus: KnowledgeReviewFocus): KnowledgeToReview {
  const contexts = [focus.project];
  const files = new Map<string, string>();
  for (const file of focus.changedFiles) {
    const key = normalizePath(file, contexts);
    if (key && !files.has(key)) files.set(key, file);
  }
  if (files.size === 0) return { hints: [], truncated: false };
  const rows = db
    .prepare(
      `SELECT k.id, k.title, k.applies_to_json, k.updated_at, k.created_at, k.session_id,
              k.last_confirmed_at, k.last_confirmed_session_id
       FROM knowledge k
       WHERE k.project_id = ? AND k.status = 'active' AND k.applies_to_json <> '[]'
         AND (k.session_id IS NULL OR k.session_id <> ?)
         AND NOT EXISTS (SELECT 1 FROM knowledge_feedback f WHERE f.knowledge_id = k.id AND f.session_id = ?)
       ORDER BY k.updated_at DESC, k.id ASC LIMIT ?`,
    )
    .all(focus.projectId, focus.sessionId, focus.sessionId, APPLIES_TO_SCAN_LIMIT) as KnowledgeAppliesToRow[];
  const budget = createAppliesToBudget();
  const candidates: Candidate[] = [];
  for (const row of rows) {
    let best = { strength: 0, path: "", appliesTo: "" };
    const patterns: string[] = [];
    for (const raw of parseJson<unknown[]>(row.applies_to_json, [])) {
      if (typeof raw !== "string") continue;
      const pattern = normalizePath(raw, contexts);
      if (!pattern) continue;
      patterns.push(pattern);
      for (const [key, path] of files) {
        const strength = namedStrength(pattern, key, budget);
        if (strength > best.strength) best = { strength, path, appliesTo: raw };
      }
    }
    if (budget.exhausted) break;
    if (best.strength > 0) candidates.push({ row, patterns, ...best });
  }
  candidates.sort(
    (left, right) =>
      right.strength - left.strength ||
      right.row.updated_at.localeCompare(left.row.updated_at) ||
      left.row.id.localeCompare(right.row.id),
  );
  const isNewlyInDoubt = newlyInDoubtCheck(db, focus, contexts, budget);
  const hints: KnowledgeReviewHint[] = [];
  for (const candidate of candidates) {
    if (hints.length === KNOWLEDGE_TO_REVIEW_LIMIT) break;
    if (!isNewlyInDoubt(candidate)) {
      if (budget.exhausted) break;
      continue;
    }
    hints.push({
      id: candidate.row.id,
      title: truncateText(candidate.row.title, KNOWLEDGE_TO_REVIEW_TITLE_CHARS),
      path: candidate.path,
      ...(candidate.appliesTo === candidate.path ? {} : { appliesTo: candidate.appliesTo }),
    });
  }
  return { hints, truncated: budget.exhausted };
}
