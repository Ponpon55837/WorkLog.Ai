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
import { CHANGED_FILES_NORMAL } from "./search-repository.js";
import { parseChangedFiles } from "./session-record-codecs.js";
import { normalizePath, type PathContext } from "./search-text.js";

export interface KnowledgeReviewFocus {
  projectId: string;
  sessionId: string;
  completedAt: string;
  changedFiles: readonly string[];
  project: PathContext;
}

export interface KnowledgeToReview {
  hints: KnowledgeReviewHint[];
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
type Decision = "open" | "touched" | "newly";
type OpenCandidate = {
  candidate: Candidate;
  since: string;
  own: Set<string | null>;
  decision: Decision;
};

const KNOWLEDGE_TO_REVIEW_LIMIT = 3;
const KNOWLEDGE_TO_REVIEW_TITLE_CHARS = 120;
const EXACT_STRENGTH = 1;
const GLOB_STRENGTH = 0.8;
const MIN_FRAGMENT_LENGTH = 3;
/** Any part of a required run is required too, so a shorter fragment still narrows correctly and bounds instr(). */
const MAX_FRAGMENT_LENGTH = 64;
/** Above this, narrowing in SQL costs more than it saves, so every later Session is parsed (and charged) instead. */
const MAX_SCAN_FRAGMENTS = 16;
const MAX_GRANTED_PATTERNS = 32;

function requiredFragment(pattern: string): string | undefined {
  const runs = pattern.match(/[a-z0-9._-]+/g) ?? [];
  const longest = runs.reduce((best, run) => (run.length > best.length ? run : best), "");
  return longest.length >= MIN_FRAGMENT_LENGTH ? longest.slice(0, MAX_FRAGMENT_LENGTH) : undefined;
}

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
    const since =
      row.last_confirmed_at && row.last_confirmed_at > row.created_at ? row.last_confirmed_at : row.created_at;
    // A backfilled Session that finished before the Knowledge was confirmed does not put it in doubt.
    if (focus.completedAt <= since) continue;
    for (const pattern of patterns) {
      if (!matchers.has(pattern)) matchers.set(pattern, compileAppliesTo(pattern, budget));
    }
    if (budget.exhausted) return { selected: [], truncated: true };
    open.push({ candidate, since, own: new Set([row.session_id, row.last_confirmed_session_id]), decision: "open" });
  }
  if (open.length === 0) return { selected: [], truncated: false };
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
           ? `AND CASE WHEN NOT ${LIST_SEARCH_CHARGE_FUNCTION}(octet_length(changed_files_json))
                  OR ${distinct.map(() => "instr(lower(changed_files_json), ?) > 0").join(" OR ")} THEN 1 ELSE 0 END`
           : ""
       }
     ORDER BY completed_at DESC, id DESC`,
  );
  const parameters = [focus.projectId, earliest, focus.sessionId, ...(narrowed ? (distinct as string[]) : [])];
  let incomplete = false;
  const settle = (completedAt: string): boolean => {
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
        grantAppliesTo(budget, APPLIES_TO_GRANT_FACTOR * open.length);
        if (!chargeAppliesTo(budget, open.length) || settle(session.completed_at)) return;
        if (session.changed_files_json === null) {
          // Above the load bound: its files cannot be compared, so open candidates stay open.
          incomplete = true;
          return;
        }
        if (!chargeStoredJson(budget, session.changed_files_json, true)) return;
        const files: string[] = [];
        const listed = parseChangedFiles(session.changed_files_json);
        // A broad Session never starts possiblyStale, so it cannot be the one that already did.
        if (listed.length > CHANGED_FILES_NORMAL) continue;
        for (const file of listed) {
          if (!chargeNormalizePath(budget, file, contexts, true)) return;
          const normalized = normalizePath(file, contexts);
          if (normalized) files.push(normalized);
        }
        const eligible = open.filter(
          (entry) => entry.decision === "open" && session.completed_at > entry.since && !entry.own.has(session.id),
        );
        if (eligible.length === 0) continue;
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

export function findKnowledgeToReview(db: DatabaseSync, focus: KnowledgeReviewFocus): KnowledgeToReview {
  const contexts = [focus.project];
  const files = new Map<string, string>();
  for (const file of focus.changedFiles) {
    const key = normalizePath(file, contexts);
    if (key && !files.has(key)) files.set(key, file);
  }
  if (files.size === 0) return { hints: [], truncated: false };
  // A broad Session does not set possiblyStale, so it puts nothing in doubt.
  if (focus.changedFiles.length > CHANGED_FILES_NORMAL) return { hints: [], truncated: false };
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
