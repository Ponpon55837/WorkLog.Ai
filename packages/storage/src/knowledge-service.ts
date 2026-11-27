import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  APPLIES_TO_GLOB_STARS_FIX,
  isOverComplexAppliesToGlob,
  KNOWLEDGE_CONVENTION_LIMIT,
} from "@work-intelligence/core";
import { nowIso } from "@work-intelligence/shared";
import type {
  AgentReviewLaterSession,
  FinalizeSessionInput,
  KnowledgeAuditAction,
  KnowledgeAuditRecord,
  KnowledgeConventionActor,
  KnowledgeConventionWithdrawalReason,
  KnowledgeEvidence,
  KnowledgeFeedbackCounts,
  KnowledgeFeedbackKind,
  KnowledgeFeedbackRecord,
  KnowledgeHistoryQuery,
  KnowledgeHistoryResult,
  KnowledgeQuery,
  KnowledgeQueryResult,
  KnowledgeRecord,
  KnowledgeSkippedResult,
  KnowledgeStaleness,
  PolicyDecision,
  ProjectRecord,
  RecordedKnowledgeResult,
  RecordKnowledgeInput,
  RecordKnowledgeResult,
  SetKnowledgeConventionResult,
  UpdatedKnowledgeResult,
  UpdateKnowledgeInput,
  UpdateKnowledgeResult,
} from "@work-intelligence/core";
import {
  chargeAppliesTo,
  createAppliesToBudget,
  MAX_STORED_CHANGED_FILES_JSON_BYTES,
  normalizedAppliesTo,
  type AppliesToBudget,
} from "./applies-to-match.js";
import { DataRevisionCache } from "./data-revision-cache.js";
import {
  appliesToBreadthOf,
  BREADTH_SCAN_LIMIT,
  breadthWindowOf,
  broadAppliesToWarning,
  FOCUSED_SESSION_SQL,
  isBroadAppliesTo,
  scanAppliesToBreadth,
  touchedInWindow,
  type BreadthWindow,
} from "./knowledge-breadth.js";
import { LaterChangeIndex, stalenessUnitLimits, type PatternCoverage } from "./later-change-index.js";
import type { PathContext } from "./search-text.js";
import {
  runAfterImmediateTransaction,
  runImmediateTransaction as runImmediateSqlTransaction,
} from "./sqlite-transaction.js";
import { cleanList, toKnowledge, toKnowledgeAudit } from "./session-record-codecs.js";
import type { KnowledgeAuditRow, KnowledgeRow } from "./session-record-codecs.js";
import { combineRedactionSummaries, redactValue } from "./secret-redaction.js";

export interface KnowledgeFeedbackResult {
  warnings: string[];
  counts?: KnowledgeFeedbackCounts;
}

export interface WithdrawnConfirmation {
  knowledge: KnowledgeRecord;
  withdrawn: boolean;
}

export interface KnowledgeServiceDependencies {
  checkProjectRoot(projectRoot: string): PolicyDecision;
  getProjectById(projectId: string): ProjectRecord | undefined;
  searchKnowledge(options: KnowledgeQuery): KnowledgeQueryResult | KnowledgeSkippedResult;
}

interface ItemPatterns {
  patterns: string[];
  skipped: boolean;
}

interface StalenessSignals {
  possiblyStale?: KnowledgeStaleness;
  broadChangesSince?: number;
}

interface EvidenceRow {
  knowledge_id: string;
  confirmed: number;
  contradicted: number;
  last_confirmed_at: string | null;
  last_contradicted_at: string | null;
}

interface AppliedKnowledgeRow {
  session_id: string;
  knowledge_id: string;
}

interface FeedbackTargetRow extends KnowledgeRow {
  reported_applied: number;
  reported_contradicted: number;
}

const FEEDBACK_HISTORY_LIMIT = 100;

export const CONVENTION_WITHDRAWN_WARNING =
  "This Knowledge was a user-confirmed project convention and this change withdrew it. Tell the user; they can confirm it again in the Web UI.";

function withdrawConvention(
  record: KnowledgeRecord,
  reason: KnowledgeConventionWithdrawalReason,
  by: KnowledgeConventionActor,
  at: string,
): boolean {
  if (!record.conventionConfirmedAt) return false;
  delete record.conventionConfirmedAt;
  record.conventionWithdrawal = { at, by, reason };
  return true;
}

/** A confirmation recorded for a Session that finished before the Knowledge existed does not move the baseline back. */
function stalenessSince(knowledge: KnowledgeRecord): string {
  return knowledge.lastConfirmedAt && knowledge.lastConfirmedAt > knowledge.createdAt
    ? knowledge.lastConfirmedAt
    : knowledge.createdAt;
}

function itemPatterns(knowledge: KnowledgeRecord, contexts: PathContext[], budget: AppliesToBudget): ItemPatterns {
  const skippedBefore = budget.skippedEntries;
  const patterns = [
    ...new Set(normalizedAppliesTo(knowledge.appliesTo, contexts, budget).map((entry) => entry.pattern)),
  ];
  return { patterns, skipped: budget.skippedEntries > skippedBefore };
}

function lowerBound(values: Int32Array, target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! >= target) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low;
}

function laterChanges(
  knowledge: KnowledgeRecord,
  patterns: readonly string[],
  later: LaterChangeIndex,
  budget: AppliesToBudget,
): { coverage: PatternCoverage[]; touched: Set<number> } | undefined {
  const start = later.firstAfter(stalenessSince(knowledge));
  const coverage: PatternCoverage[] = [];
  for (const pattern of patterns) {
    const covered = later.coverage(pattern, budget);
    if (!covered) return undefined;
    coverage.push(covered);
  }
  const touched = new Set<number>();
  for (const { sessions } of coverage) {
    const from = lowerBound(sessions, start);
    if (!chargeAppliesTo(budget, sessions.length - from + 1)) return undefined;
    for (let at = from; at < sessions.length; at += 1) {
      touched.add(sessions[at]!);
    }
  }
  for (const id of [knowledge.sessionId, knowledge.lastConfirmedSessionId]) {
    const excludedIndex = id ? later.indexOfSession(id) : undefined;
    if (excludedIndex !== undefined) touched.delete(excludedIndex);
  }
  return { coverage, touched };
}

function coveredPaths(
  later: LaterChangeIndex,
  sessionIndex: number,
  coverage: readonly PatternCoverage[],
  budget: AppliesToBudget,
): string[] | undefined {
  const session = later.sessions[sessionIndex]!;
  if (!chargeAppliesTo(budget, session.files.length * coverage.length + 1)) return undefined;
  return session.files.filter((_, index) => {
    const pathId = session.pathIds[index]!;
    return pathId >= 0 && coverage.some(({ paths: covered }) => covered.has(pathId));
  });
}

/** "unchecked" when the budget ran out: a partial comparison can neither prove nor rule out staleness. */
function knowledgeStaleness(
  knowledge: KnowledgeRecord,
  { patterns, skipped }: ItemPatterns,
  later: LaterChangeIndex,
  window: BreadthWindow,
  budget: AppliesToBudget,
): StalenessSignals | "unchecked" | undefined {
  if (skipped || budget.exhausted) {
    return "unchecked";
  }
  if (patterns.length === 0) {
    return undefined;
  }
  const changes = laterChanges(knowledge, patterns, later, budget);
  if (!changes) return "unchecked";
  const { coverage, touched } = changes;
  let broadSessions = 0;
  let focusedTouched = 0;
  let firstIndex = Number.POSITIVE_INFINITY;
  for (const sessionIndex of touched) {
    if (later.isBroad(sessionIndex)) {
      broadSessions += 1;
    } else {
      focusedTouched += 1;
      if (sessionIndex < firstIndex) {
        firstIndex = sessionIndex;
      }
    }
  }
  const broadChangesSince = broadSessions > 0 ? { broadChangesSince: broadSessions } : {};
  if (focusedTouched === 0) {
    return broadSessions > 0 ? broadChangesSince : undefined;
  }
  const session = later.sessions[firstIndex]!;
  const paths = coveredPaths(later, firstIndex, coverage, budget);
  if (!paths) return "unchecked";
  const windowTouched = touchedInWindow(later, coverage, window, budget);
  if (windowTouched === undefined) return "unchecked";
  const appliesToBreadth = appliesToBreadthOf(windowTouched, window.sessions);
  return {
    possiblyStale: {
      sessionId: session.id,
      sessionTitle: session.title,
      completedAt: session.completedAt,
      paths: paths.slice(0, 5),
      sessionCount: focusedTouched,
      reason: isBroadAppliesTo(windowTouched, window.sessions) ? "broad_applies_to" : "applies_to_changed",
      ...(appliesToBreadth ? { appliesToBreadth } : {}),
    },
    ...broadChangesSince,
  };
}

const STALENESS_CACHE_KEYS = 512;

export class KnowledgeService {
  private readonly stalenessResults: DataRevisionCache<StalenessSignals | null>;

  public constructor(
    private readonly db: DatabaseSync,
    private readonly dependencies: KnowledgeServiceDependencies,
  ) {
    this.stalenessResults = new DataRevisionCache(db, STALENESS_CACHE_KEYS);
  }

  public applyKnowledgeFeedback(
    projectId: string,
    sessionId: string,
    completedAt: string,
    input: Pick<FinalizeSessionInput, "appliedKnowledgeIds" | "contradictedKnowledgeIds">,
  ): KnowledgeFeedbackResult {
    const warnings: string[] = [];
    const contradicted = new Set(input.contradictedKnowledgeIds ?? []);
    const feedback = [
      ...[...new Set(input.appliedKnowledgeIds ?? [])]
        .filter((id) => {
          if (contradicted.has(id)) {
            warnings.push(`${id}: listed as both applied and contradicted; kept as contradicted.`);
            return false;
          }
          return true;
        })
        .map((id) => ({ id, applied: true })),
      ...[...contradicted].map((id) => ({ id, applied: false })),
    ];
    if (feedback.length === 0) return { warnings };

    const rows = this.db
      .prepare(
        `SELECT k.*, p.name AS project_name,
           EXISTS (SELECT 1 FROM knowledge_feedback f
                   WHERE f.knowledge_id = k.id AND f.session_id = @sessionId AND f.kind = 'applied') AS reported_applied,
           EXISTS (SELECT 1 FROM knowledge_feedback f
                   WHERE f.knowledge_id = k.id AND f.session_id = @sessionId AND f.kind = 'contradicted')
             AS reported_contradicted
         FROM knowledge k JOIN projects p ON p.id = k.project_id
         WHERE k.project_id = @projectId AND k.id IN (SELECT value FROM json_each(@ids))`,
      )
      .all({
        sessionId,
        projectId,
        ids: JSON.stringify(feedback.map(({ id }) => id)),
      }) as unknown as FeedbackTargetRow[];
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    const counts: KnowledgeFeedbackCounts = { applied: 0, contradicted: 0 };
    for (const { id, applied } of feedback) {
      const row = rowsById.get(id);
      if (!row) {
        warnings.push(`${id}: Knowledge was not found in this project.`);
        continue;
      }
      counts[applied ? "applied" : "contradicted"] += 1;
      if (applied ? row.reported_applied : row.reported_contradicted) continue;
      const before = toKnowledge(row);
      // A backfilled Session can predate the last confirmation: the feedback is recorded, but the baseline only moves
      // forward and an older contradiction does not put the Knowledge in doubt; on a tie the confirmation stands.
      const confirmationMoves = applied && (!before.lastConfirmedAt || completedAt > before.lastConfirmedAt);
      const reviewClears = applied && before.review !== undefined && completedAt >= before.review.at;
      const reviewMoves =
        !applied &&
        (!before.lastConfirmedAt || completedAt > before.lastConfirmedAt) &&
        (!before.review || completedAt >= before.review.at);
      const after: KnowledgeRecord = {
        ...before,
        ...(confirmationMoves ? { lastConfirmedAt: completedAt, lastConfirmedSessionId: sessionId } : {}),
        ...(reviewMoves ? { review: { reason: "contradicted" as const, sessionId, at: completedAt } } : {}),
      };
      if (reviewClears) {
        delete after.review;
      }
      const conventionWithdrawn = reviewMoves && withdrawConvention(after, "needs_review", "system", completedAt);
      this.db
        .prepare(
          `UPDATE knowledge SET last_confirmed_at = ?, last_confirmed_session_id = ?, review_json = ?,
             convention_confirmed_at = ?, convention_withdrawal_json = ?
           WHERE id = ?`,
        )
        .run(
          after.lastConfirmedAt ?? null,
          after.lastConfirmedSessionId ?? null,
          after.review ? JSON.stringify(after.review) : null,
          after.conventionConfirmedAt ?? null,
          after.conventionWithdrawal ? JSON.stringify(after.conventionWithdrawal) : null,
          id,
        );
      const auditId = this.insertKnowledgeAudit({
        knowledge: after,
        before,
        action: "updated",
        changedFields: [
          ...(confirmationMoves ? ["lastConfirmedAt"] : []),
          ...(reviewClears || reviewMoves ? ["review"] : []),
          ...(conventionWithdrawn ? ["convention"] : []),
        ],
        occurredAt: completedAt,
      });
      this.insertFeedback(auditId, after, applied ? "applied" : "contradicted", completedAt, sessionId);
    }
    return { warnings, counts };
  }

  public appliedKnowledgeIdsBySessions(sessionIds: readonly string[]): Map<string, string[]> {
    const uniqueSessionIds = [...new Set(sessionIds)];
    if (uniqueSessionIds.length === 0) return new Map();

    const rows = this.db
      .prepare(
        `SELECT DISTINCT f.session_id, f.knowledge_id
         FROM knowledge_feedback f
         JOIN sessions s ON s.id = f.session_id AND s.project_id = f.project_id
         JOIN projects p ON p.id = f.project_id AND p.status = 'tracked'
         JOIN knowledge k ON k.id = f.knowledge_id AND k.project_id = f.project_id
         WHERE f.kind = 'applied' AND s.voided_at IS NULL AND k.status = 'active'
           AND f.session_id IN (SELECT value FROM json_each(?))
           AND NOT EXISTS (
             SELECT 1 FROM knowledge successor
             WHERE successor.supersedes_id = k.id AND successor.status = 'active'
           )
         ORDER BY f.session_id, f.occurred_at DESC, f.knowledge_id ASC`,
      )
      .all(JSON.stringify(uniqueSessionIds)) as unknown as AppliedKnowledgeRow[];
    const knowledgeBySession = new Map<string, string[]>();
    for (const row of rows) {
      const knowledgeIds = knowledgeBySession.get(row.session_id);
      if (knowledgeIds) knowledgeIds.push(row.knowledge_id);
      else knowledgeBySession.set(row.session_id, [row.knowledge_id]);
    }
    return knowledgeBySession;
  }

  public withKnowledgeTrust(knowledge: KnowledgeRecord): KnowledgeRecord {
    return this.withKnowledgeTrustMany([knowledge])[0] ?? knowledge;
  }

  public withKnowledgeTrustMany(items: KnowledgeRecord[]): KnowledgeRecord[] {
    const evidence = this.evidenceFor(items.map((item) => item.id));
    const byProject = new Map<string, KnowledgeRecord[]>();
    for (const item of items) {
      if (item.appliesTo.length === 0) {
        continue;
      }
      const group = byProject.get(item.projectId);
      if (group) {
        group.push(item);
      } else {
        byProject.set(item.projectId, [item]);
      }
    }

    const staleness = this.stalenessOf(byProject);
    return items.map((item) => {
      const result = staleness.get(item.id);
      const counts = evidence.get(item.id);
      return {
        ...item,
        ...(result === "unchecked" ? { stalenessUnchecked: true as const } : (result ?? {})),
        ...(counts ? { evidence: counts } : {}),
      };
    });
  }

  public laterSessionsOf(items: readonly KnowledgeRecord[], limit: number): Map<string, AgentReviewLaterSession[]> {
    const result = new Map<string, AgentReviewLaterSession[]>();
    const byProject = new Map<string, KnowledgeRecord[]>();
    for (const item of items) {
      if (item.appliesTo.length === 0) continue;
      const group = byProject.get(item.projectId);
      if (group) group.push(item);
      else byProject.set(item.projectId, [item]);
    }
    const limits = stalenessUnitLimits();
    const history = createAppliesToBudget(limits.history);
    const budget = createAppliesToBudget(limits.match);
    for (const [projectId, group] of byProject) {
      const project = this.dependencies.getProjectById(projectId);
      const contexts = project ? [{ name: project.name, rootPath: project.rootPath }] : [];
      const earliest = group.map(stalenessSince).reduce((min, since) => (since < min ? since : min));
      const later = this.loadLaterSessions(projectId, earliest, contexts, history);
      if (!later) continue;
      const prepared = group.map((item) => itemPatterns(item, contexts, budget));
      later.expect(new Set(prepared.flatMap(({ patterns }) => patterns)).size);
      group.forEach((item, index) => {
        const { patterns, skipped } = prepared[index]!;
        if (skipped || budget.exhausted || patterns.length === 0) return;
        const changes = laterChanges(item, patterns, later, budget);
        if (!changes) return;
        const newest = [...changes.touched]
          .filter((at) => !later.isBroad(at))
          .sort((left, right) => right - left)
          .slice(0, limit);
        const sessions: AgentReviewLaterSession[] = [];
        for (const at of newest) {
          const paths = coveredPaths(later, at, changes.coverage, budget);
          if (!paths) return;
          const session = later.sessions[at]!;
          sessions.push({
            id: session.id,
            title: session.title,
            completedAt: session.completedAt,
            paths: paths.slice(0, 5),
          });
        }
        result.set(item.id, sessions);
      });
    }
    return result;
  }

  /** Nothing is remembered from a call whose budget ran out: such answers depend on which records shared the budget. */
  private stalenessOf(byProject: Map<string, KnowledgeRecord[]>): Map<string, StalenessSignals | "unchecked"> {
    const limits = stalenessUnitLimits();
    const keyOf = (id: string): string => `${limits.history}:${limits.match}:${id}`;
    const items = new Map<string, KnowledgeRecord>();
    for (const group of byProject.values()) for (const item of group) items.set(keyOf(item.id), item);
    const results = this.stalenessResults.getMany([...items.keys()], (missing) => {
      const missingByProject = new Map<string, KnowledgeRecord[]>();
      for (const key of missing) {
        const item = items.get(key)!;
        const group = missingByProject.get(item.projectId);
        if (group) group.push(item);
        else missingByProject.set(item.projectId, [item]);
      }
      const computed = this.computeStaleness(missingByProject, limits);
      const values = new Map<string, StalenessSignals | null>();
      for (const key of missing) {
        const result = computed.results.get(items.get(key)!.id);
        if (result !== "unchecked") values.set(key, result ?? null);
      }
      return { values, cacheable: computed.complete };
    });
    const staleness = new Map<string, StalenessSignals | "unchecked">();
    for (const item of items.values()) {
      const result = results.get(keyOf(item.id));
      if (result) staleness.set(item.id, result);
      else if (result === undefined) staleness.set(item.id, "unchecked");
    }
    return staleness;
  }

  private computeStaleness(
    byProject: Map<string, KnowledgeRecord[]>,
    limits: ReturnType<typeof stalenessUnitLimits>,
  ): { results: Map<string, StalenessSignals | "unchecked">; complete: boolean } {
    const staleness = new Map<string, StalenessSignals | "unchecked">();
    const history = createAppliesToBudget(limits.history);
    const budget = createAppliesToBudget(limits.match);
    for (const [projectId, group] of byProject) {
      const project = this.dependencies.getProjectById(projectId);
      const contexts = project ? [{ name: project.name, rootPath: project.rootPath }] : [];
      const earliest = group.map(stalenessSince).reduce((min, since) => (since < min ? since : min));
      const later = this.loadLaterSessions(projectId, earliest, contexts, history);
      if (!later) {
        for (const item of group) staleness.set(item.id, "unchecked");
        continue;
      }
      // Patterns first, so the index knows how many it will resolve (one or two skip the segment index).
      const prepared = group.map((item) => itemPatterns(item, contexts, budget));
      const window = breadthWindowOf(later);
      later.expect(new Set(prepared.flatMap(({ patterns }) => patterns)).size);
      group.forEach((item, index) => {
        const result = knowledgeStaleness(item, prepared[index]!, later, window, budget);
        if (result) {
          staleness.set(item.id, result);
        }
      });
    }
    const complete =
      !history.exhausted &&
      !budget.exhausted &&
      budget.skippedEntries === 0 &&
      ![...staleness.values()].includes("unchecked");
    return { results: staleness, complete };
  }

  public evidenceFor(knowledgeIds: readonly string[]): Map<string, KnowledgeEvidence> {
    const evidence = new Map<string, KnowledgeEvidence>();
    if (knowledgeIds.length === 0) {
      return evidence;
    }
    const rows = this.db
      .prepare(
        `SELECT knowledge_id,
                SUM(kind <> 'contradicted') AS confirmed,
                SUM(kind = 'contradicted') AS contradicted,
                MAX(CASE WHEN kind <> 'contradicted' THEN occurred_at END) AS last_confirmed_at,
                MAX(CASE WHEN kind = 'contradicted' THEN occurred_at END) AS last_contradicted_at
         FROM knowledge_feedback
         WHERE knowledge_id IN (SELECT value FROM json_each(?))
         GROUP BY knowledge_id`,
      )
      .all(JSON.stringify([...new Set(knowledgeIds)])) as unknown as EvidenceRow[];
    for (const row of rows) {
      evidence.set(row.knowledge_id, {
        confirmed: row.confirmed,
        contradicted: row.contradicted,
        ...(row.last_confirmed_at ? { lastConfirmedAt: row.last_confirmed_at } : {}),
        ...(row.last_contradicted_at ? { lastContradictedAt: row.last_contradicted_at } : {}),
      });
    }
    return evidence;
  }

  /** Read one row at a time: one .all() of 5,000 Sessions of 50 x 100 characters took 433 ms and 235 MB. */
  private loadLaterSessions(
    projectId: string,
    since: string,
    contexts: PathContext[],
    history: AppliesToBudget,
  ): LaterChangeIndex | undefined {
    const floor = this.db
      .prepare(
        `SELECT completed_at, id FROM sessions
         WHERE project_id = ? AND voided_at IS NULL AND ${FOCUSED_SESSION_SQL}
         ORDER BY completed_at DESC, id DESC
         LIMIT 1 OFFSET ?`,
      )
      .get(projectId, BREADTH_SCAN_LIMIT - 1) as { completed_at: string; id: string } | undefined;
    const rows = this.db
      .prepare(
        `SELECT id, title, completed_at,
                CASE WHEN octet_length(changed_files_json) <= ${MAX_STORED_CHANGED_FILES_JSON_BYTES}
                     THEN changed_files_json END AS changed_files_json
         FROM sessions
         WHERE project_id = ? AND voided_at IS NULL
           AND (completed_at > ? OR (${FOCUSED_SESSION_SQL} AND (completed_at, id) >= (?, ?)))
         ORDER BY completed_at ASC, id ASC`,
      )
      .iterate(projectId, since, floor?.completed_at ?? "", floor?.id ?? "") as Iterable<{
      id: string;
      title: string;
      completed_at: string;
      changed_files_json: string | null;
    }>;
    const index = new LaterChangeIndex(contexts, history);
    for (const row of rows) {
      if (!index.add(row.id, row.title, row.completed_at, row.changed_files_json)) return undefined;
    }
    return index;
  }

  public recordKnowledge(input: RecordKnowledgeInput): RecordKnowledgeResult {
    const decision = this.dependencies.checkProjectRoot(input.projectRoot);
    if (!decision.allowed || !decision.project) {
      return {
        outcome: "skipped",
        projectRoot: decision.canonicalRoot,
        projectStatus: decision.projectStatus,
        reason: decision.reason ?? "Project recording is not enabled.",
      };
    }

    const project = decision.project;
    const sanitizedContent = redactValue({
      title: input.title.trim(),
      body: input.body.trim(),
      tags: [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))],
      references: [...new Set((input.references ?? []).map((reference) => reference.trim()).filter(Boolean))],
      appliesTo: cleanList(input.appliesTo),
    });
    return runImmediateSqlTransaction(this.db, () => {
      if (input.sessionId) {
        const session = this.db.prepare("SELECT project_id FROM sessions WHERE id = ?").get(input.sessionId) as
          { project_id?: string } | undefined;
        if (!session || session.project_id !== project.id) {
          return { outcome: "not_found", sessionId: input.sessionId };
        }
      }

      const existing = this.db
        .prepare(
          `SELECT k.*, p.name AS project_name
           FROM knowledge k
           JOIN projects p ON p.id = k.project_id
           WHERE k.project_id = ? AND k.idempotency_key = ?`,
        )
        .get(project.id, input.idempotencyKey) as KnowledgeRow | undefined;
      if (existing) {
        return {
          outcome: "knowledge_recorded",
          duplicate: true,
          knowledge: this.withKnowledgeTrust(toKnowledge(existing)),
          redactions: sanitizedContent.redactions,
        };
      }

      const createdAt = nowIso();
      const knowledge: KnowledgeRecord = {
        id: randomUUID(),
        projectId: project.id,
        projectName: project.name,
        sessionId: input.sessionId,
        idempotencyKey: input.idempotencyKey,
        kind: input.kind,
        title: sanitizedContent.value.title,
        body: sanitizedContent.value.body,
        tags: sanitizedContent.value.tags,
        references: sanitizedContent.value.references,
        status: "active",
        createdAt,
        updatedAt: createdAt,
        appliesTo: sanitizedContent.value.appliesTo,
      };
      const warnings: string[] = [];
      const superseded = input.supersedesId
        ? (this.db
            .prepare(
              `SELECT k.*, p.name AS project_name FROM knowledge k JOIN projects p ON p.id = k.project_id
               WHERE k.id = ? AND k.project_id = ?`,
            )
            .get(input.supersedesId, project.id) as KnowledgeRow | undefined)
        : undefined;
      if (input.supersedesId && !superseded) {
        warnings.push(`supersedesId ${input.supersedesId} was not found in this project.`);
      }
      if (superseded) {
        knowledge.supersedesId = superseded.id;
      }

      this.db
        .prepare(
          `INSERT INTO knowledge (
             id, project_id, session_id, idempotency_key, kind, title, body,
             tags_json, references_json, status, created_at, updated_at, applies_to_json, supersedes_id
           ) VALUES (
             @id, @projectId, @sessionId, @idempotencyKey, @kind, @title, @body,
             @tags, @references, @status, @createdAt, @updatedAt, @appliesTo, @supersedesId
           )`,
        )
        .run({
          id: knowledge.id,
          projectId: knowledge.projectId,
          sessionId: knowledge.sessionId ?? null,
          idempotencyKey: knowledge.idempotencyKey,
          kind: knowledge.kind,
          title: knowledge.title,
          body: knowledge.body,
          tags: JSON.stringify(knowledge.tags),
          references: JSON.stringify(knowledge.references),
          status: knowledge.status,
          createdAt: knowledge.createdAt,
          updatedAt: knowledge.updatedAt,
          appliesTo: JSON.stringify(knowledge.appliesTo),
          supersedesId: knowledge.supersedesId ?? null,
        });
      this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(createdAt, project.id);
      this.insertKnowledgeAudit({
        knowledge,
        action: "created",
        changedFields: [
          "kind",
          "title",
          "body",
          "tags",
          "references",
          "status",
          ...(knowledge.appliesTo.length > 0 ? ["appliesTo"] : []),
          ...(knowledge.supersedesId ? ["supersedesId"] : []),
        ],
        occurredAt: createdAt,
      });
      if (superseded && superseded.status === "active") {
        const before = toKnowledge(superseded);
        const after: KnowledgeRecord = { ...before, status: "archived", updatedAt: createdAt };
        const conventionWithdrawn = withdrawConvention(after, "superseded", "system", createdAt);
        if (conventionWithdrawn) warnings.push(CONVENTION_WITHDRAWN_WARNING);
        this.db
          .prepare(
            `UPDATE knowledge SET status = 'archived', updated_at = ?,
               convention_confirmed_at = ?, convention_withdrawal_json = ?
             WHERE id = ?`,
          )
          .run(
            createdAt,
            after.conventionConfirmedAt ?? null,
            after.conventionWithdrawal ? JSON.stringify(after.conventionWithdrawal) : null,
            before.id,
          );
        this.insertKnowledgeAudit({
          knowledge: after,
          before,
          action: "archived",
          changedFields: ["status", ...(conventionWithdrawn ? ["convention"] : [])],
          occurredAt: createdAt,
        });
      }

      const recorded: RecordedKnowledgeResult = {
        outcome: "knowledge_recorded",
        duplicate: false,
        knowledge: this.withKnowledgeTrust(knowledge),
        ...(warnings.length > 0 ? { warnings } : {}),
        redactions: sanitizedContent.redactions,
      };
      this.addBreadthAfterCommit(recorded, project, knowledge.appliesTo);
      return recorded;
    });
  }

  public updateKnowledge(
    input: UpdateKnowledgeInput,
    actor: KnowledgeConventionActor = "agent",
  ): UpdateKnowledgeResult {
    const decision = this.dependencies.checkProjectRoot(input.projectRoot);
    if (!decision.allowed || !decision.project) {
      return {
        outcome: "skipped",
        projectRoot: decision.canonicalRoot,
        projectStatus: decision.projectStatus,
        reason: decision.reason ?? "Project recording is not enabled.",
      };
    }

    const project = decision.project;
    return runImmediateSqlTransaction(this.db, (): UpdateKnowledgeResult => {
      const row = this.db
        .prepare(
          `SELECT k.*, p.name AS project_name
           FROM knowledge k
           JOIN projects p ON p.id = k.project_id
           WHERE k.id = ? AND k.project_id = ?`,
        )
        .get(input.knowledgeId, project.id) as KnowledgeRow | undefined;
      if (!row) {
        return { outcome: "not_found", knowledgeId: input.knowledgeId };
      }

      // Restoring a replaced item would leave two active versions of one rule. Checked here, under the write lock,
      // because the successor may have been recorded since the caller last looked.
      if (input.status === "active" && row.status !== "active") {
        const successor = this.db
          .prepare(
            "SELECT id FROM knowledge WHERE supersedes_id = ? AND project_id = ? AND status = 'active' ORDER BY created_at DESC, id ASC LIMIT 1",
          )
          .get(input.knowledgeId, project.id) as { id: string } | undefined;
        if (successor) {
          return {
            outcome: "rejected",
            reason: "superseded_by_active",
            knowledgeId: input.knowledgeId,
            successorId: successor.id,
          };
        }
      }

      const current = toKnowledge(row);
      const currentSanitized = redactValue({
        title: current.title,
        body: current.body,
        tags: current.tags,
        references: current.references,
        appliesTo: current.appliesTo,
      });
      const inputSanitized = redactValue({
        title: input.title?.trim(),
        body: input.body?.trim(),
        tags: input.tags?.map((tag) => tag.trim()).filter(Boolean),
        references: input.references?.map((reference) => reference.trim()).filter(Boolean),
        appliesTo: input.appliesTo ? cleanList(input.appliesTo) : undefined,
      });
      const redactions = combineRedactionSummaries(currentSanitized.redactions, inputSanitized.redactions);
      const cleanCurrent = { ...current, ...currentSanitized.value };
      const updatedAt = nowIso();
      const next: KnowledgeRecord = {
        ...cleanCurrent,
        kind: input.kind ?? current.kind,
        title: inputSanitized.value.title || cleanCurrent.title,
        body: inputSanitized.value.body || cleanCurrent.body,
        tags: input.tags ? [...new Set(inputSanitized.value.tags ?? [])] : cleanCurrent.tags,
        references: input.references ? [...new Set(inputSanitized.value.references ?? [])] : cleanCurrent.references,
        status: input.status ?? current.status,
        updatedAt,
        appliesTo: input.appliesTo ? (inputSanitized.value.appliesTo ?? []) : cleanCurrent.appliesTo,
        ...(input.confirm ? { lastConfirmedAt: updatedAt } : {}),
      };
      if (input.confirm) {
        delete next.lastConfirmedSessionId;
        delete next.review;
      }
      const textEdited =
        (input.title !== undefined && next.title !== cleanCurrent.title) ||
        (input.body !== undefined && next.body !== cleanCurrent.body);
      const conventionReason: KnowledgeConventionWithdrawalReason | undefined =
        next.status === "archived" && current.status !== "archived"
          ? "archived"
          : actor === "agent" && textEdited
            ? "agent_edit"
            : undefined;
      const conventionWithdrawn = conventionReason
        ? withdrawConvention(next, conventionReason, actor, updatedAt)
        : false;
      const changedFields = [
        ...(current.kind !== next.kind ? ["kind"] : []),
        ...(current.title !== next.title ? ["title"] : []),
        ...(current.body !== next.body ? ["body"] : []),
        ...(JSON.stringify(current.tags) !== JSON.stringify(next.tags) ? ["tags"] : []),
        ...(JSON.stringify(current.references) !== JSON.stringify(next.references) ? ["references"] : []),
        ...(current.status !== next.status ? ["status"] : []),
        ...(JSON.stringify(current.appliesTo) !== JSON.stringify(next.appliesTo) ? ["appliesTo"] : []),
        ...(input.confirm ? ["lastConfirmedAt"] : []),
        ...(input.confirm && current.review ? ["review"] : []),
        ...(conventionWithdrawn ? ["convention"] : []),
      ];
      const action: KnowledgeAuditAction =
        current.status !== next.status ? (next.status === "archived" ? "archived" : "restored") : "updated";

      this.db
        .prepare(
          `UPDATE knowledge
           SET kind = @kind,
               title = @title,
               body = @body,
               tags_json = @tags,
               references_json = @references,
               status = @status,
               updated_at = @updatedAt,
               applies_to_json = @appliesTo,
               last_confirmed_at = @lastConfirmedAt,
               last_confirmed_session_id = @lastConfirmedSessionId,
               review_json = @review,
               convention_confirmed_at = @conventionConfirmedAt,
               convention_withdrawal_json = @conventionWithdrawal
           WHERE id = @id AND project_id = @projectId`,
        )
        .run({
          id: next.id,
          projectId: next.projectId,
          kind: next.kind,
          title: next.title,
          body: next.body,
          tags: JSON.stringify(next.tags),
          references: JSON.stringify(next.references),
          status: next.status,
          updatedAt: next.updatedAt,
          appliesTo: JSON.stringify(next.appliesTo),
          lastConfirmedAt: next.lastConfirmedAt ?? null,
          lastConfirmedSessionId: next.lastConfirmedSessionId ?? null,
          review: next.review ? JSON.stringify(next.review) : null,
          conventionConfirmedAt: next.conventionConfirmedAt ?? null,
          conventionWithdrawal: next.conventionWithdrawal ? JSON.stringify(next.conventionWithdrawal) : null,
        });
      this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(updatedAt, project.id);
      const auditId = this.insertKnowledgeAudit({
        knowledge: next,
        before: cleanCurrent,
        action,
        changedFields,
        occurredAt: updatedAt,
      });
      if (input.confirm) {
        this.insertFeedback(auditId, next, "manual_confirm", updatedAt);
      }

      // The schema lets an update keep entries above the star bound; say they never match and how to fix them.
      const overComplex = input.appliesTo
        ? next.appliesTo.flatMap((pattern, index) => (isOverComplexAppliesToGlob(pattern) ? [index] : []))
        : [];
      const updated: UpdatedKnowledgeResult = {
        outcome: "knowledge_updated",
        knowledge: this.withKnowledgeTrust(next),
        redactions,
        ...(overComplex.length > 0 || (conventionWithdrawn && actor === "agent")
          ? {
              warnings: [
                ...(overComplex.length > 0
                  ? [
                      `appliesTo entries at positions ${overComplex.join(", ")} (from 0) never match. ${APPLIES_TO_GLOB_STARS_FIX}`,
                    ]
                  : []),
                ...(conventionWithdrawn && actor === "agent" ? [CONVENTION_WITHDRAWN_WARNING] : []),
              ],
            }
          : {}),
      };
      if (changedFields.includes("appliesTo") && next.status === "active") {
        this.addBreadthAfterCommit(updated, project, next.appliesTo);
      }
      return updated;
    });
  }

  public setKnowledgeConvention(input: {
    projectRoot: string;
    knowledgeId: string;
    confirmed: boolean;
  }): SetKnowledgeConventionResult {
    const decision = this.dependencies.checkProjectRoot(input.projectRoot);
    if (!decision.allowed || !decision.project) {
      return {
        outcome: "skipped",
        projectRoot: decision.canonicalRoot,
        projectStatus: decision.projectStatus,
        reason: decision.reason ?? "Project recording is not enabled.",
      };
    }

    const project = decision.project;
    return runImmediateSqlTransaction(this.db, (): Exclude<SetKnowledgeConventionResult, KnowledgeSkippedResult> => {
      const row = this.db
        .prepare(
          `SELECT k.*, p.name AS project_name
           FROM knowledge k JOIN projects p ON p.id = k.project_id
           WHERE k.id = ? AND k.project_id = ?`,
        )
        .get(input.knowledgeId, project.id) as KnowledgeRow | undefined;
      if (!row) return { outcome: "not_found", knowledgeId: input.knowledgeId };

      const before = toKnowledge(row);
      const countConventions = () =>
        (
          this.db
            .prepare(
              `SELECT COUNT(*) AS total FROM knowledge
               WHERE project_id = ? AND convention_confirmed_at IS NOT NULL AND convention_confirmed_at <> ''
                 AND status = 'active' AND review_json IS NULL`,
            )
            .get(project.id) as { total: number }
        ).total;
      if (input.confirmed === Boolean(before.conventionConfirmedAt)) {
        return {
          outcome: "knowledge_updated",
          knowledge: this.withKnowledgeTrust(before),
          conventionCount: countConventions(),
        };
      }
      if (input.confirmed) {
        if (before.status !== "active") {
          return { outcome: "rejected", reason: "not_active", knowledgeId: before.id };
        }
        if (before.review) {
          return { outcome: "rejected", reason: "needs_review", knowledgeId: before.id };
        }
        if (countConventions() >= KNOWLEDGE_CONVENTION_LIMIT) {
          return { outcome: "rejected", reason: "convention_limit_reached", knowledgeId: before.id };
        }
      }

      const at = nowIso();
      const after: KnowledgeRecord = { ...before };
      if (input.confirmed) {
        after.conventionConfirmedAt = at;
        delete after.conventionWithdrawal;
      } else {
        withdrawConvention(after, "unmarked", "user", at);
      }
      this.db
        .prepare(
          "UPDATE knowledge SET convention_confirmed_at = ?, convention_withdrawal_json = ? WHERE id = ? AND project_id = ?",
        )
        .run(
          after.conventionConfirmedAt ?? null,
          after.conventionWithdrawal ? JSON.stringify(after.conventionWithdrawal) : null,
          after.id,
          project.id,
        );
      this.insertKnowledgeAudit({
        knowledge: after,
        before,
        action: "updated",
        changedFields: ["convention"],
        occurredAt: at,
      });
      return {
        outcome: "knowledge_updated",
        knowledge: this.withKnowledgeTrust(after),
        conventionCount: countConventions(),
      };
    });
  }

  public listConventionPointers(projectId: string): Array<{ id: string; title: string }> {
    return this.db
      .prepare(
        `SELECT id, title FROM knowledge
         WHERE project_id = ? AND convention_confirmed_at IS NOT NULL AND convention_confirmed_at <> ''
           AND status = 'active' AND review_json IS NULL
         ORDER BY convention_confirmed_at ASC, id ASC LIMIT ?`,
      )
      .all(projectId, KNOWLEDGE_CONVENTION_LIMIT) as Array<{ id: string; title: string }>;
  }

  /** Only while it is still the record's latest confirmation: a later one by a person or a Session stands. */
  public withdrawConfirmation(
    projectId: string,
    knowledgeId: string,
    confirmedSince: string,
  ): WithdrawnConfirmation | undefined {
    return runImmediateSqlTransaction(this.db, (): WithdrawnConfirmation | undefined => {
      const row = this.db
        .prepare(
          `SELECT k.*, p.name AS project_name FROM knowledge k JOIN projects p ON p.id = k.project_id
           WHERE k.id = ? AND k.project_id = ?`,
        )
        .get(knowledgeId, projectId) as KnowledgeRow | undefined;
      if (!row) return undefined;
      const current = toKnowledge(row);
      const confirmation = this.db
        .prepare(
          `SELECT f.id, f.occurred_at, a.before_json,
                  EXISTS (SELECT 1 FROM knowledge_feedback later
                          WHERE later.knowledge_id = f.knowledge_id AND later.kind = 'manual_confirm'
                            AND later.rowid > f.rowid) AS confirmed_again
           FROM knowledge_feedback f JOIN knowledge_audit a ON a.id = f.id
           WHERE f.knowledge_id = ? AND f.kind = 'manual_confirm' AND f.occurred_at >= ?
           ORDER BY f.occurred_at ASC, f.rowid ASC LIMIT 1`,
        )
        .get(knowledgeId, confirmedSince) as
        { id: string; occurred_at: string; before_json: string | null; confirmed_again: number } | undefined;
      const stillLatest =
        confirmation?.before_json &&
        !confirmation.confirmed_again &&
        !current.lastConfirmedSessionId &&
        current.lastConfirmedAt === confirmation.occurred_at;
      if (!confirmation?.before_json || !stillLatest) {
        return { knowledge: this.withKnowledgeTrust(current), withdrawn: false };
      }
      const before = JSON.parse(confirmation.before_json) as KnowledgeRecord;
      const baselineSession = before.lastConfirmedSessionId
        ? this.db
            .prepare("SELECT 1 AS found FROM sessions WHERE id = ? AND project_id = ?")
            .get(before.lastConfirmedSessionId, projectId)
        : undefined;
      const updatedAt = nowIso();
      const next: KnowledgeRecord = { ...current, updatedAt };
      delete next.lastConfirmedAt;
      delete next.lastConfirmedSessionId;
      if (before.lastConfirmedAt) next.lastConfirmedAt = before.lastConfirmedAt;
      if (baselineSession) next.lastConfirmedSessionId = before.lastConfirmedSessionId;
      if (!current.review && before.review) next.review = before.review;
      const conventionWithdrawn =
        !current.review && next.review !== undefined && withdrawConvention(next, "needs_review", "system", updatedAt);
      this.db
        .prepare(
          `UPDATE knowledge SET updated_at = ?, last_confirmed_at = ?, last_confirmed_session_id = ?, review_json = ?,
             convention_confirmed_at = ?, convention_withdrawal_json = ?
           WHERE id = ? AND project_id = ?`,
        )
        .run(
          updatedAt,
          next.lastConfirmedAt ?? null,
          next.lastConfirmedSessionId ?? null,
          next.review ? JSON.stringify(next.review) : null,
          next.conventionConfirmedAt ?? null,
          next.conventionWithdrawal ? JSON.stringify(next.conventionWithdrawal) : null,
          knowledgeId,
          projectId,
        );
      this.db.prepare("DELETE FROM knowledge_feedback WHERE id = ?").run(confirmation.id);
      this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(updatedAt, projectId);
      this.insertKnowledgeAudit({
        knowledge: next,
        before: current,
        action: "updated",
        changedFields: [
          "lastConfirmedAt",
          ...(!current.review && next.review ? ["review"] : []),
          ...(conventionWithdrawn ? ["convention"] : []),
        ],
        occurredAt: updatedAt,
      });
      return { knowledge: this.withKnowledgeTrust(next), withdrawn: true };
    });
  }

  public getKnowledgeHistory(input: KnowledgeHistoryQuery): KnowledgeHistoryResult {
    const decision = this.dependencies.checkProjectRoot(input.projectRoot);
    if (!decision.allowed || !decision.project) {
      return {
        outcome: "skipped",
        knowledgeId: input.knowledgeId,
        projectRoot: decision.canonicalRoot,
        projectStatus: decision.projectStatus,
        reason: decision.reason ?? "Project recording is not enabled.",
      };
    }

    const row = this.db
      .prepare(
        `SELECT k.*, p.name AS project_name
         FROM knowledge k
         JOIN projects p ON p.id = k.project_id
         WHERE k.id = ? AND k.project_id = ?`,
      )
      .get(input.knowledgeId, decision.project.id) as KnowledgeRow | undefined;
    if (!row) {
      return { outcome: "not_found", knowledgeId: input.knowledgeId };
    }

    const limit = Math.min(Math.max(input.limit ?? 100, 1), 200);
    const auditRows = this.db
      .prepare(
        `SELECT *
         FROM knowledge_audit
         WHERE knowledge_id = ? AND project_id = ?
         ORDER BY occurred_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(input.knowledgeId, decision.project.id, limit) as KnowledgeAuditRow[];

    const feedback = (
      this.db
        .prepare(
          `SELECT f.id, f.kind, f.session_id, s.title AS session_title, f.occurred_at
           FROM knowledge_feedback f
           LEFT JOIN sessions s ON s.id = f.session_id
           WHERE f.knowledge_id = ?
           ORDER BY f.occurred_at DESC, f.rowid DESC
           LIMIT ?`,
        )
        .all(input.knowledgeId, FEEDBACK_HISTORY_LIMIT) as Array<{
        id: string;
        kind: KnowledgeFeedbackKind;
        session_id: string | null;
        session_title: string | null;
        occurred_at: string;
      }>
    ).map((item): KnowledgeFeedbackRecord => ({
      id: item.id,
      kind: item.kind,
      ...(item.session_id ? { sessionId: item.session_id } : {}),
      ...(item.session_title ? { sessionTitle: item.session_title } : {}),
      occurredAt: item.occurred_at,
    }));

    return {
      outcome: "knowledge_history",
      project: decision.project,
      knowledge: this.withKnowledgeTrust(toKnowledge(row)),
      history: auditRows.map(toKnowledgeAudit),
      feedback,
    };
  }

  public searchKnowledge(options: KnowledgeQuery = {}): KnowledgeQueryResult | KnowledgeSkippedResult {
    const result = this.dependencies.searchKnowledge(options);
    return result.outcome === "knowledge" ? { ...result, items: this.withKnowledgeTrustMany(result.items) } : result;
  }

  /** After the commit and outside the write lock; any failure leaves the result as it is. */
  private addBreadthAfterCommit(
    result: RecordedKnowledgeResult | UpdatedKnowledgeResult,
    project: ProjectRecord,
    appliesTo: readonly string[],
  ): void {
    if (appliesTo.length === 0) return;
    runAfterImmediateTransaction(this.db, () => {
      try {
        const scan = scanAppliesToBreadth(
          this.db,
          project.id,
          [{ name: project.name, rootPath: project.rootPath }],
          appliesTo,
        );
        const warnings = [...(result.warnings ?? [])];
        if (scan.breadth) result.appliesToBreadth = scan.breadth;
        if (scan.broad && scan.breadth) warnings.push(broadAppliesToWarning(scan.breadth));
        if (scan.unchecked) {
          warnings.push("appliesTo breadth was not checked: the entries were too large or too many to compare.");
        }
        if (warnings.length > 0) result.warnings = warnings;
      } catch {
        // The hint is advice; a failed read must not fail a committed write.
      }
    });
  }

  private insertKnowledgeAudit(input: {
    knowledge: KnowledgeRecord;
    before?: KnowledgeRecord;
    action: KnowledgeAuditAction;
    changedFields: string[];
    occurredAt: string;
  }): string {
    const audit: KnowledgeAuditRecord = {
      id: randomUUID(),
      knowledgeId: input.knowledge.id,
      projectId: input.knowledge.projectId,
      action: input.action,
      ...(input.before ? { before: input.before } : {}),
      after: input.knowledge,
      changedFields: [...new Set(input.changedFields)],
      occurredAt: input.occurredAt,
    };

    this.db
      .prepare(
        `INSERT INTO knowledge_audit (
           id, knowledge_id, project_id, action, before_json, after_json,
           changed_fields_json, occurred_at
         ) VALUES (
           @id, @knowledgeId, @projectId, @action, @before, @after,
           @changedFields, @occurredAt
         )`,
      )
      .run({
        id: audit.id,
        knowledgeId: audit.knowledgeId,
        projectId: audit.projectId,
        action: audit.action,
        before: audit.before ? JSON.stringify(audit.before) : null,
        after: JSON.stringify(audit.after),
        changedFields: JSON.stringify(audit.changedFields),
        occurredAt: audit.occurredAt,
      });
    return audit.id;
  }

  private insertFeedback(
    auditId: string,
    knowledge: KnowledgeRecord,
    kind: KnowledgeFeedbackKind,
    occurredAt: string,
    sessionId?: string,
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO knowledge_feedback (id, knowledge_id, project_id, session_id, kind, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(auditId, knowledge.id, knowledge.projectId, sessionId ?? null, kind, occurredAt);
  }
}
