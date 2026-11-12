import type { DatabaseSync } from "node:sqlite";
import type { KnowledgeReviewHint } from "@work-intelligence/core";
import { truncateText } from "@work-intelligence/shared";
import {
  APPLIES_TO_GRANT_FACTOR,
  APPLIES_TO_SCAN_LIMIT,
  appliesToColumnSql,
  appliesToPairEstimate,
  appliesToScanIncomplete,
  chargeAppliesTo,
  chargeNormalizePath,
  chargeStoredJson,
  classifyAppliesTo,
  compileAppliesTo,
  createAppliesToBudget,
  grantAppliesTo,
  MAX_STORED_CHANGED_FILES_JSON_BYTES,
  storedAppliesTo,
  type AppliesToBudget,
  type AppliesToMatcher,
} from "./applies-to-match.js";
import { LIST_SEARCH_CHARGE_FUNCTION, registerListSearchFunctions, runListSearchScan } from "./list-search-scan.js";
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
  /** NULL when the stored text is above MAX_STORED_APPLIES_TO_JSON_BYTES (not loaded). */
  applies_to_json: string | null;
  updated_at: string;
  created_at: string;
  session_id: string | null;
  last_confirmed_at: string | null;
  last_confirmed_session_id: string | null;
};
type Candidate = { row: KnowledgeAppliesToRow; strength: number; path: string; appliesTo: string; patterns: string[] };
/** Phase-two state of one candidate: still open, put in doubt by an earlier Session, or newly in doubt. */
type Decision = "open" | "touched" | "newly";
type OpenCandidate = {
  candidate: Candidate;
  since: string;
  own: Set<string | null>;
  decision: Decision;
};

const KNOWLEDGE_TO_REVIEW_LIMIT = 3;
const KNOWLEDGE_TO_REVIEW_TITLE_CHARS = 120;
/** An appliesTo entry equal to a changed path outranks a glob that matches it. */
const EXACT_STRENGTH = 1;
const GLOB_STRENGTH = 0.8;
const MIN_FRAGMENT_LENGTH = 3;
/**
 * Longest fragment the Session scan searches for: any part of a required run is required too, so a shorter one
 * narrows correctly, and SQLite's instr() then costs at most this many comparisons per stored character whatever
 * length the stored entry has.
 */
const MAX_FRAGMENT_LENGTH = 64;
/**
 * Most distinct fragments the one Session pass narrows by in SQL. Each costs one instr() per stored byte; with more (only many Knowledge items with different appliesTo can name the same changed
 * files) narrowing would cost more than it saves, so every later Session is parsed instead, also charged.
 */
const MAX_SCAN_FRAGMENTS = 16;
/** Distinct patterns per later Session whose ordinary comparisons are granted (see selectNewlyInDoubt). */
const MAX_GRANTED_PATTERNS = 32;

/**
 * The longest run of plain path characters in a normalized pattern. Every path the pattern covers contains it (a
 * plain entry's last segment survives every equal, suffix, and directory match; a glob matches its literals
 * verbatim), so it can narrow the Session scan in SQL. Plain characters keep the JSON text and ASCII-only lower()
 * identical to the normalized path. Short runs narrow too little and are not used.
 */
function requiredFragment(pattern: string): string | undefined {
  const runs = pattern.match(/[a-z0-9._-]+/g) ?? [];
  const longest = runs.reduce((best, run) => (run.length > best.length ? run : best), "");
  return longest.length >= MIN_FRAGMENT_LENGTH ? longest.slice(0, MAX_FRAGMENT_LENGTH) : undefined;
}

/**
 * Phase two: which candidates this Session newly puts in doubt, by the staleness rule of KnowledgeService (a later
 * Session since the last confirmation or creation, other than the Knowledge's own Sessions, whose changed files an
 * appliesTo entry covers), asked for "anyone but this Session". One pass reads the later Sessions newest first, shared
 * by every candidate (it used to run one SQL scan per candidate, uncharged for the rows it skipped): SQL keeps only
 * Sessions whose changed-files text contains a fragment some candidate requires (a row above the load bound is not
 * read), and each kept Session's list, its paths and its comparisons are charged before they run, after granting three
 * times their ordinary cost, so the pass is linear in the later Sessions and a crafted entry still runs out. A candidate
 * is decided when a Session touches it, or when the pass reaches Sessions not after its `since`; the pass stops once
 * the first KNOWLEDGE_TO_REVIEW_LIMIT undecided-or-newly candidates in order are all decided. Returns the hints'
 * candidates in order and whether either budget ran out (then only the candidates decided before it count).
 */
function selectNewlyInDoubt(
  db: DatabaseSync,
  focus: KnowledgeReviewFocus,
  contexts: PathContext[],
  candidates: Candidate[],
  budget: AppliesToBudget,
): { selected: Candidate[]; truncated: boolean } {
  const open: OpenCandidate[] = [];
  const matchers = new Map<string, AppliesToMatcher>();
  for (const candidate of candidates) {
    const { row, patterns } = candidate;
    const since = row.last_confirmed_at ?? row.created_at;
    // A backfilled Session that finished before the Knowledge was confirmed does not put it in doubt.
    if (focus.completedAt <= since) continue;
    for (const pattern of patterns) {
      if (!matchers.has(pattern)) matchers.set(pattern, compileAppliesTo(pattern, budget));
    }
    if (budget.exhausted) return { selected: [], truncated: true };
    open.push({ candidate, since, own: new Set([row.session_id, row.last_confirmed_session_id]), decision: "open" });
  }
  if (open.length === 0) return { selected: [], truncated: false };
  // requiredFragment reads each pattern once.
  const patternCharacters = open.reduce(
    (total, { candidate }) => total + candidate.patterns.reduce((sum, pattern) => sum + pattern.length, 0),
    0,
  );
  if (!chargeAppliesTo(budget, patternCharacters + 1)) return { selected: [], truncated: true };
  const fragments = open.flatMap(({ candidate }) => candidate.patterns.map(requiredFragment));
  const distinct = [...new Set(fragments)];
  const narrowed = fragments.every((fragment) => fragment !== undefined) && distinct.length <= MAX_SCAN_FRAGMENTS;
  const earliest = open.reduce((min, entry) => (entry.since < min ? entry.since : min), open[0]!.since);
  // A no-op on a store's connection, which defines it when it opens.
  registerListSearchFunctions(db);
  const statement = db.prepare(
    `SELECT id, completed_at,
            CASE WHEN octet_length(changed_files_json) <= ${MAX_STORED_CHANGED_FILES_JSON_BYTES}
                 THEN changed_files_json END AS changed_files_json
     FROM sessions
     WHERE project_id = ? AND voided_at IS NULL AND completed_at > ? AND id <> ?
       ${
         narrowed
           ? `AND CASE WHEN ${LIST_SEARCH_CHARGE_FUNCTION}(octet_length(changed_files_json))
                  THEN (${distinct.map(() => "instr(lower(changed_files_json), ?) > 0").join(" OR ")}) ELSE 1 END`
           : ""
       }
     ORDER BY completed_at DESC, id DESC`,
  );
  const parameters = [focus.projectId, earliest, focus.sessionId, ...(narrowed ? (distinct as string[]) : [])];
  let incomplete = false;
  const settle = (completedAt: string): boolean => {
    // Candidates whose window ends before this Session can no longer be touched; then check the first few in order.
    let newly = 0;
    for (const entry of open) {
      if (entry.decision === "open" && completedAt <= entry.since) entry.decision = "newly";
      if (entry.decision === "touched") continue;
      if (entry.decision === "open") return false;
      newly += 1;
      if (newly === KNOWLEDGE_TO_REVIEW_LIMIT) return true;
    }
    return true;
  };
  runListSearchScan(
    db,
    narrowed ? distinct.length : 1,
    () => {
      for (const session of statement.iterate(...parameters) as Iterable<{
        id: string;
        completed_at: string;
        changed_files_json: string | null;
      }>) {
        if (budget.exhausted) return;
        // Deciding the candidates in order is charged per open candidate and Session, after granting three times it:
        // the pass is linear in the later Sessions it reads (APPLIES_TO_GRANT_FACTOR).
        grantAppliesTo(budget, APPLIES_TO_GRANT_FACTOR * open.length);
        if (!chargeAppliesTo(budget, open.length) || settle(session.completed_at)) return;
        if (session.changed_files_json === null) {
          // Above the load (and per-row narrowing) bound: its files cannot be compared, so open candidates stay open.
          incomplete = true;
          return;
        }
        if (!chargeStoredJson(budget, session.changed_files_json, true)) return;
        const files: string[] = [];
        for (const file of parseJson<string[]>(session.changed_files_json, [])) {
          if (typeof file !== "string") continue;
          if (!chargeNormalizePath(budget, file, contexts, true)) return;
          const normalized = normalizePath(file, contexts);
          if (normalized) files.push(normalized);
        }
        const eligible = open.filter(
          (entry) => entry.decision === "open" && session.completed_at > entry.since && !entry.own.has(session.id),
        );
        if (eligible.length === 0) continue;
        // Each distinct pattern is compared with this Session's files once, however many candidates share it. The
        // grant covers ordinary pairs of at most MAX_GRANTED_PATTERNS distinct patterns per Session, so the pass stays
        // linear in the later Sessions; more distinct patterns spend the fixed part of the budget and then stop.
        const patterns = [...new Set(eligible.flatMap((entry) => entry.candidate.patterns))];
        const fileCharacters = files.reduce((total, file) => total + file.length, 0);
        grantAppliesTo(
          budget,
          APPLIES_TO_GRANT_FACTOR *
            patterns
              .slice(0, MAX_GRANTED_PATTERNS)
              .reduce(
                (total, pattern) => total + files.length * appliesToPairEstimate(0, pattern.length) + fileCharacters,
                0,
              ),
        );
        const touches = new Set<string>();
        for (const pattern of patterns) {
          const matches = matchers.get(pattern)!;
          if (files.some((file) => matches(file, budget))) touches.add(pattern);
          if (budget.exhausted) return;
        }
        for (const entry of eligible) {
          if (entry.candidate.patterns.some((pattern) => touches.has(pattern))) entry.decision = "touched";
        }
      }
      // Every later Session was read: the candidates still open were touched by none of them.
      for (const entry of open) if (entry.decision === "open") entry.decision = "newly";
    },
    MAX_STORED_CHANGED_FILES_JSON_BYTES,
  );
  const truncated = incomplete || budget.exhausted;
  const selected: Candidate[] = [];
  for (const entry of open) {
    if (selected.length === KNOWLEDGE_TO_REVIEW_LIMIT || entry.decision === "open") break;
    if (entry.decision === "newly") selected.push(entry.candidate);
  }
  return { selected, truncated };
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
      `SELECT k.id, k.title, ${appliesToColumnSql("k.applies_to_json")} AS applies_to_json, k.updated_at,
              k.created_at, k.session_id,
              k.last_confirmed_at, k.last_confirmed_session_id
       FROM knowledge k
       WHERE k.project_id = ? AND k.status = 'active' AND k.applies_to_json <> '[]'
         AND (k.session_id IS NULL OR k.session_id <> ?)
         AND NOT EXISTS (SELECT 1 FROM knowledge_feedback f WHERE f.knowledge_id = k.id AND f.session_id = ?)
       ORDER BY k.updated_at DESC, k.id ASC LIMIT ?`,
    )
    .iterate(
      focus.projectId,
      focus.sessionId,
      focus.sessionId,
      APPLIES_TO_SCAN_LIMIT,
    ) as Iterable<KnowledgeAppliesToRow>;
  const budget = createAppliesToBudget();
  const candidates: Candidate[] = [];
  for (const row of rows) {
    let best = { strength: 0, path: "", appliesTo: "" };
    const patterns: string[] = [];
    for (const { raw, pattern } of storedAppliesTo(row.applies_to_json, contexts, budget)) {
      patterns.push(pattern);
      // How the entry names a path: equal to it, or a glob that matches it. Directories and suffixes do not count.
      // The entry is classified and compiled once, not once per changed file.
      const isGlob = classifyAppliesTo(pattern, budget);
      if (isGlob === undefined) break;
      const matches = isGlob ? compileAppliesTo(pattern, budget) : undefined;
      for (const [key, path] of files) {
        let strength = 0;
        if (matches) strength = matches(key, budget) ? GLOB_STRENGTH : 0;
        else if (chargeAppliesTo(budget, 1 + pattern.length)) strength = pattern === key ? EXACT_STRENGTH : 0;
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
  const { selected, truncated } = selectNewlyInDoubt(db, focus, contexts, candidates, budget);
  const hints: KnowledgeReviewHint[] = selected.map((candidate) => ({
    id: candidate.row.id,
    title: truncateText(candidate.row.title, KNOWLEDGE_TO_REVIEW_TITLE_CHARS),
    path: candidate.path,
    ...(candidate.appliesTo === candidate.path ? {} : { appliesTo: candidate.appliesTo }),
  }));
  return { hints, truncated: truncated || appliesToScanIncomplete(budget) };
}
