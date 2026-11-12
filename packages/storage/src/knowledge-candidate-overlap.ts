import type { DatabaseSync } from "node:sqlite";
import type { KnowledgeCandidateOverlap } from "@work-intelligence/core";
import {
  storedKnowledgeCandidateOverlapsSchema,
  type StoredKnowledgeCandidateOverlap,
} from "@work-intelligence/schema";
import { truncateText } from "@work-intelligence/shared";
import { tokenize } from "./search-text.js";

export interface OverlapCandidate {
  title: string;
  body: string;
}

export interface OverlapScope {
  projectId: string;
  /** Candidates of this request and the Knowledge accepted from them are the submission itself, never a match. */
  requestId: string;
  /** Only records that existed at the submission compare, so a replayed submission gets the same advisories. */
  createdAtOrBefore: string;
}

type ExistingRow = {
  type: "knowledge" | "candidate";
  id: string;
  title: string;
  body: string;
  status: "active" | "archived" | "proposed" | "rejected";
};

type Tokens = { title: Set<string>; text: Set<string> };

/** One candidate's stored advisory and the project it belongs to; matches are only ever looked up in that project. */
export interface StoredOverlapEntry {
  projectId: string;
  overlaps: readonly StoredKnowledgeCandidateOverlap[];
}

/**
 * Scores at or above this flag an overlap. On a real project's 72 Knowledge items and candidates (2,556 pairs), the
 * one confirmed near-duplicate pair scored 0.33 and the highest unrelated pair 0.23.
 */
export const KNOWLEDGE_OVERLAP_THRESHOLD = 0.3;
const OVERLAPS_PER_CANDIDATE = 3;
const OVERLAP_TITLE_CHARS = 120;
/** Body text beyond this adds tokens but rarely changes the score; bounding it bounds the work. */
const OVERLAP_BODY_CHARS = 4_000;
/** Newest rows compared per kind; real projects hold tens, the bound keeps a submit proportional to it. */
const OVERLAP_SCAN_LIMIT = 1_000;
const TITLE_TABLES = { knowledge: "knowledge", candidate: "knowledge_candidates" } as const;

function tokensOf(title: string, body: string): Tokens {
  const titleTokens = new Set(tokenize(title));
  const text = new Set(titleTokens);
  for (const token of tokenize(body.slice(0, OVERLAP_BODY_CHARS))) text.add(token);
  return { title: titleTokens, text };
}

/** Shared tokens over the smaller set: a short title fully contained in a longer one still counts. */
function overlapCoefficient(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let shared = 0;
  for (const token of small) if (large.has(token)) shared += 1;
  return shared / small.size;
}

function relationFor(status: ExistingRow["status"]): KnowledgeCandidateOverlap["relation"] {
  if (status === "archived") return "overlaps_archived";
  if (status === "rejected") return "overlaps_rejected";
  return "possible_duplicate";
}

/**
 * Advisory overlaps of submitted candidates with the same project's Knowledge (active and archived) and with
 * candidates of its earlier requests that are still proposed or were rejected. Accepted candidates are represented
 * by their Knowledge. Each existing record is tokenized once; the result never changes stored data.
 */
export function findKnowledgeCandidateOverlaps(
  db: DatabaseSync,
  scope: OverlapScope,
  candidates: readonly OverlapCandidate[],
): KnowledgeCandidateOverlap[][] {
  if (candidates.length === 0) return [];
  const rows = [
    ...(db
      .prepare(
        `SELECT 'knowledge' AS type, k.id, k.title, k.body, k.status FROM knowledge k
         WHERE k.project_id = ? AND k.status IN ('active', 'archived') AND k.created_at <= ?
           AND NOT EXISTS (
             SELECT 1 FROM knowledge_candidates c WHERE c.request_id = ? AND c.knowledge_id = k.id
           )
         ORDER BY k.updated_at DESC, k.id ASC LIMIT ?`,
      )
      .all(scope.projectId, scope.createdAtOrBefore, scope.requestId, OVERLAP_SCAN_LIMIT) as ExistingRow[]),
    ...(db
      .prepare(
        `SELECT 'candidate' AS type, id, title, body, status FROM knowledge_candidates
         WHERE project_id = ? AND status IN ('proposed', 'rejected') AND request_id <> ? AND created_at <= ?
         ORDER BY created_at DESC, id ASC LIMIT ?`,
      )
      .all(scope.projectId, scope.requestId, scope.createdAtOrBefore, OVERLAP_SCAN_LIMIT) as ExistingRow[]),
  ];
  const existing = rows.map((row) => ({ row, tokens: tokensOf(row.title, row.body) }));
  return candidates.map((candidate) => {
    const tokens = tokensOf(candidate.title, candidate.body);
    return existing
      .flatMap(({ row, tokens: other }) => {
        // Titles and bodies weigh the same: titles alone tie unrelated items that share a module name.
        const score =
          0.5 * overlapCoefficient(tokens.title, other.title) + 0.5 * overlapCoefficient(tokens.text, other.text);
        return score >= KNOWLEDGE_OVERLAP_THRESHOLD ? [{ row, score }] : [];
      })
      .sort((left, right) => right.score - left.score || left.row.id.localeCompare(right.row.id))
      .slice(0, OVERLAPS_PER_CANDIDATE)
      .map(({ row, score }) => ({
        relation: relationFor(row.status),
        type: row.type,
        id: row.id,
        title: truncateText(row.title, OVERLAP_TITLE_CHARS),
        status: row.status,
        score: Math.round(score * 100) / 100,
      }));
  });
}

/** The stored form of one candidate's advisories: ids, statuses and scores, never a title or other text. */
export function storedOverlapsJson(overlaps: readonly KnowledgeCandidateOverlap[]): string {
  return JSON.stringify(
    storedKnowledgeCandidateOverlapsSchema.parse(
      overlaps.map(({ relation, type, id, status, score }) => ({ relation, type, id, status, score })),
    ),
  );
}

/**
 * Reads a stored advisory without trusting it: undefined when none was stored (candidates submitted before schema
 * 33) or the value is not the stored form, so a damaged value is never shown and never throws.
 */
export function parseStoredOverlaps(value: string | null): StoredKnowledgeCandidateOverlap[] | undefined {
  if (value === null) return undefined;
  try {
    const parsed = storedKnowledgeCandidateOverlapsSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Adds the current title of each matched record, looked up by id within the candidate's own project, in one query
 * per record type. A record that no longer exists there keeps its stored relation and status without a title.
 */
export function resolveStoredOverlaps(
  db: DatabaseSync,
  entries: readonly StoredOverlapEntry[],
): KnowledgeCandidateOverlap[][] {
  const titles = new Map<string, string>();
  for (const type of ["knowledge", "candidate"] as const) {
    const pairs = entries.flatMap((entry) =>
      entry.overlaps.filter((overlap) => overlap.type === type).map((overlap) => [entry.projectId, overlap.id]),
    );
    if (pairs.length === 0) continue;
    const rows = db
      .prepare(
        `SELECT t.project_id AS projectId, t.id, t.title FROM json_each(?) pair
         CROSS JOIN ${TITLE_TABLES[type]} t ON t.id = json_extract(pair.value, '$[1]')
         WHERE t.project_id = json_extract(pair.value, '$[0]')`,
      )
      .all(JSON.stringify(pairs)) as Array<{ projectId: string; id: string; title: string }>;
    for (const row of rows) titles.set(`${type}:${row.projectId}:${row.id}`, row.title);
  }
  return entries.map((entry) =>
    entry.overlaps.map((overlap) => {
      const title = titles.get(`${overlap.type}:${entry.projectId}:${overlap.id}`);
      return {
        relation: overlap.relation,
        type: overlap.type,
        id: overlap.id,
        ...(title === undefined ? {} : { title: truncateText(title, OVERLAP_TITLE_CHARS) }),
        status: overlap.status,
        score: overlap.score,
      };
    }),
  );
}
