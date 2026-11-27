import type { DatabaseSync } from "node:sqlite";
import type { ProjectDataRow } from "@work-intelligence/core";
import { hydrateRow } from "./project-data-spill.js";
import { parseWorkSummarySections } from "./session-record-codecs.js";

const POSITION_OFFSET = 1_000_000;
const REDACTION_MARKER = "[REDACTED:";

/**
 * A Session's decision rows are one set that replaceSessionDecisions rewrites as a whole, so the two machines' rows
 * are compared against the decisions of the effective Session summary instead of row by row.
 */
export interface DecisionSetPlan {
  /** Imported rows with an id no local row has that must not be written. */
  keepIds: Set<string>;
  /** Local rows that stay and take the imported position. */
  movedIds: Map<string, number>;
  /** Local rows whose (session, position) slot an imported row may take. */
  releasedLocalIds: Set<string>;
  removeIds: string[];
  repoints: Array<{ from: string; to: string }>;
  /** Imported rows that must end as add, update or skip for the Session's local rows to be removed. */
  landings: Array<{ sessionId: string; ids: string[] }>;
}

interface LocalDecision {
  id: string;
  session_id: string;
  position: number;
  text: string;
  review_status: string;
}

export function emptyDecisionSets(): DecisionSetPlan {
  return {
    keepIds: new Set(),
    movedIds: new Map(),
    releasedLocalIds: new Set(),
    removeIds: [],
    repoints: [],
    landings: [],
  };
}

export function decisionSetsWrite(plan: DecisionSetPlan): boolean {
  return plan.removeIds.length > 0 || plan.movedIds.size > 0;
}

/** `sessionSources` maps a Session id to its imported row when the import updates it, or to null when the local row stays. */
export function planDecisionSets(
  db: DatabaseSync,
  importedRows: readonly ProjectDataRow[],
  sessionSources: ReadonlyMap<string, ProjectDataRow | null>,
  issueOf: (row: ProjectDataRow) => string | undefined,
  filePreferenceIds: ReadonlySet<string>,
  abandonedSessionIds: ReadonlySet<string>,
): DecisionSetPlan {
  const plan = emptyDecisionSets();
  const importedBySession = new Map<string, ProjectDataRow[]>();
  for (const row of importedRows) {
    const sessionId = String(row.session_id);
    if (!sessionSources.has(sessionId) || abandonedSessionIds.has(sessionId)) continue;
    const list = importedBySession.get(sessionId);
    if (list) list.push(row);
    else importedBySession.set(sessionId, [row]);
  }
  if (importedBySession.size === 0) return plan;

  const sessionIds = JSON.stringify([...importedBySession.keys()]);
  const localSummaries = new Map(
    (
      db
        .prepare("SELECT id, work_summary_json FROM sessions WHERE id IN (SELECT value FROM json_each(?))")
        .all(sessionIds) as Array<{ id: string; work_summary_json: string | null }>
    ).map((session) => [session.id, session.work_summary_json]),
  );
  const localBySession = new Map<string, LocalDecision[]>();
  for (const decision of db
    .prepare(
      `SELECT id, session_id, position, text, review_status FROM session_decisions
       WHERE session_id IN (SELECT value FROM json_each(?)) ORDER BY position ASC, id ASC`,
    )
    .all(sessionIds) as unknown as LocalDecision[]) {
    const list = localBySession.get(decision.session_id);
    if (list) list.push(decision);
    else localBySession.set(decision.session_id, [decision]);
  }

  for (const [sessionId, imported] of importedBySession) {
    if (!localSummaries.has(sessionId)) continue;
    const local = localBySession.get(sessionId) ?? [];
    imported.sort((left, right) => Number(left.position) - Number(right.position));
    if (sameSlots(imported, local) || imported.some((row) => issueOf({ ...row }))) continue;
    const source = sessionSources.get(sessionId);
    const summary = source ? hydrateRow(source).work_summary_json : localSummaries.get(sessionId);
    const target = parseWorkSummarySections(typeof summary === "string" ? summary : null)?.decisions;
    if (target) planSession(plan, sessionId, imported, local, target, filePreferenceIds);
  }
  return plan;
}

/** Sessions whose imported rows did not all land are left to today's row-by-row planning. */
export function failedDecisionSessions(
  plan: DecisionSetPlan,
  planned: ReadonlyArray<{ row: ProjectDataRow; disposition: string }>,
): string[] {
  const dispositions = new Map(planned.map((entry) => [String(entry.row.id), entry.disposition]));
  return plan.landings
    .filter(({ ids }) => ids.some((id) => !["add", "update", "skip"].includes(dispositions.get(id) ?? "")))
    .map(({ sessionId }) => sessionId);
}

/** Re-points a removed row's attention preference to its replacement, then removes and moves rows. */
export function applyDecisionSets(db: DatabaseSync, plan: DecisionSetPlan): void {
  const repoint = db.prepare(
    "UPDATE OR IGNORE attention_preferences SET source_id = ? WHERE kind = 'decision' AND source_id = ?",
  );
  for (const { from, to } of plan.repoints) repoint.run(to, from);
  if (plan.removeIds.length > 0) {
    db.prepare("DELETE FROM session_decisions WHERE id IN (SELECT value FROM json_each(?))").run(
      JSON.stringify(plan.removeIds),
    );
  }
  if (plan.movedIds.size > 0) {
    db.prepare(
      `UPDATE session_decisions SET position = position + ${POSITION_OFFSET}
       WHERE id IN (SELECT value FROM json_each(?))`,
    ).run(JSON.stringify([...plan.movedIds.keys()]));
    const statement = db.prepare("UPDATE session_decisions SET position = ? WHERE id = ?");
    for (const [id, position] of plan.movedIds) statement.run(position, id);
  }
}

function sameSlots(imported: readonly ProjectDataRow[], local: readonly LocalDecision[]): boolean {
  if (imported.length !== local.length) return false;
  const positions = new Map(local.map((decision) => [decision.id, decision.position]));
  return imported.every((row) => positions.get(String(row.id)) === Number(row.position));
}

function sameTexts(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((text, index) => text === right[index]);
}

function planSession(
  plan: DecisionSetPlan,
  sessionId: string,
  imported: readonly ProjectDataRow[],
  local: readonly LocalDecision[],
  target: readonly string[],
  filePreferenceIds: ReadonlySet<string>,
): void {
  const importedTexts = imported.map((row) => String(hydrateRow(row).text));
  const importedMatches =
    sameTexts(importedTexts, target) && imported.every((row, index) => Number(row.position) === index);
  const localMatches = sameTexts(
    local.map((decision) => decision.text),
    target,
  );
  const localById = new Map(local.map((decision) => [decision.id, decision]));
  if (importedMatches && !localMatches) {
    replaceSet(plan, sessionId, imported, importedTexts, local, localById);
    return;
  }
  if (!localMatches) return;
  if (!importedMatches) {
    imported.forEach((row, index) => {
      const existing = localById.get(String(row.id));
      if (existing?.position !== Number(row.position) || existing.text !== importedTexts[index]) {
        plan.keepIds.add(String(row.id));
      }
    });
    return;
  }
  const importedIds = new Set(imported.map((row) => String(row.id)));
  const landing: string[] = [];
  imported.forEach((row, index) => {
    const id = String(row.id);
    if (localById.has(id)) return;
    const counterpart = local[index];
    if (
      counterpart &&
      counterpart.position === Number(row.position) &&
      counterpart.review_status === "pending" &&
      row.review_status !== "pending" &&
      !importedIds.has(counterpart.id)
    ) {
      plan.removeIds.push(counterpart.id);
      plan.releasedLocalIds.add(counterpart.id);
      if (!filePreferenceIds.has(id)) plan.repoints.push({ from: counterpart.id, to: id });
      landing.push(id);
      return;
    }
    plan.keepIds.add(id);
  });
  if (landing.length > 0) plan.landings.push({ sessionId, ids: landing });
}

function replaceSet(
  plan: DecisionSetPlan,
  sessionId: string,
  imported: readonly ProjectDataRow[],
  importedTexts: readonly string[],
  local: readonly LocalDecision[],
  localById: ReadonlyMap<string, LocalDecision>,
): void {
  const sharedTextsDiffer = imported.some((row, index) => {
    const existing = localById.get(String(row.id));
    return existing !== undefined && existing.text !== importedTexts[index];
  });
  const newlyRedacted = importedTexts.some(
    (text) => text.includes(REDACTION_MARKER) && !local.some((decision) => decision.text === text),
  );
  if (sharedTextsDiffer || newlyRedacted) return;
  const importedIds = new Set(imported.map((row) => String(row.id)));
  for (const decision of local) {
    plan.releasedLocalIds.add(decision.id);
    if (!importedIds.has(decision.id)) plan.removeIds.push(decision.id);
  }
  for (const row of imported) {
    const id = String(row.id);
    const position = Number(row.position);
    if (localById.has(id) && localById.get(id)?.position !== position) plan.movedIds.set(id, position);
  }
  plan.landings.push({ sessionId, ids: [...importedIds].filter((id) => !localById.has(id)) });
}
