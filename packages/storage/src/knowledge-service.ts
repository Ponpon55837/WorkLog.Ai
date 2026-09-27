import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { nowIso } from "@work-intelligence/shared";
import type {
  FinalizeSessionInput,
  KnowledgeAuditAction,
  KnowledgeAuditRecord,
  KnowledgeEvidence,
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
  RecordKnowledgeInput,
  RecordKnowledgeResult,
  UpdateKnowledgeInput,
  UpdateKnowledgeResult,
} from "@work-intelligence/core";
import { compileAppliesTo, normalizePath, type PathContext } from "./search-text.js";
import { runImmediateTransaction as runImmediateSqlTransaction } from "./sqlite-transaction.js";
import { cleanList, parseJson, toKnowledge, toKnowledgeAudit } from "./session-record-codecs.js";
import type { KnowledgeAuditRow, KnowledgeRow } from "./session-record-codecs.js";
import { combineRedactionSummaries, redactValue } from "./secret-redaction.js";

export interface KnowledgeServiceDependencies {
  checkProjectRoot(projectRoot: string): PolicyDecision;
  getProjectById(projectId: string): ProjectRecord | undefined;
  searchKnowledge(options: KnowledgeQuery): KnowledgeQueryResult | KnowledgeSkippedResult;
}

interface LaterSession {
  id: string;
  title: string;
  completedAt: string;
  files: Array<{ raw: string; normalized: string }>;
}

interface EvidenceRow {
  knowledge_id: string;
  confirmed: number;
  contradicted: number;
  last_confirmed_at: string | null;
  last_contradicted_at: string | null;
}

const FEEDBACK_HISTORY_LIMIT = 100;

/** Knowledge goes possibly stale when a Session after its last confirmation (or creation) touches appliesTo. */
function stalenessSince(knowledge: KnowledgeRecord): string {
  return knowledge.lastConfirmedAt ?? knowledge.createdAt;
}

/** Index of the first Session completed strictly after `since` (upper bound; `sessions` is sorted ascending). */
function firstSessionAfter(sessions: LaterSession[], since: string): number {
  let low = 0;
  let high = sessions.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sessions[middle]!.completedAt > since) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low;
}

function knowledgeStaleness(
  knowledge: KnowledgeRecord,
  sessions: LaterSession[],
  contexts: PathContext[],
): KnowledgeStaleness | undefined {
  const matchers = knowledge.appliesTo
    .map((pattern) => normalizePath(pattern, contexts))
    .filter(Boolean)
    .map(compileAppliesTo);
  const excluded = new Set([knowledge.sessionId, knowledge.lastConfirmedSessionId].filter(Boolean));
  let first: KnowledgeStaleness | undefined;
  let sessionCount = 0;
  for (let index = firstSessionAfter(sessions, stalenessSince(knowledge)); index < sessions.length; index += 1) {
    const session = sessions[index]!;
    if (excluded.has(session.id)) {
      continue;
    }
    const paths = session.files
      .filter((file) => matchers.some((matches) => matches(file.normalized)))
      .map((file) => file.raw);
    if (paths.length === 0) {
      continue;
    }
    sessionCount += 1;
    first ??= {
      sessionId: session.id,
      sessionTitle: session.title,
      completedAt: session.completedAt,
      paths: paths.slice(0, 5),
      sessionCount: 0,
    };
  }
  return first ? { ...first, sessionCount } : undefined;
}

export class KnowledgeService {
  public constructor(
    private readonly db: DatabaseSync,
    private readonly dependencies: KnowledgeServiceDependencies,
  ) {}

  public applyKnowledgeFeedback(
    projectId: string,
    sessionId: string,
    completedAt: string,
    input: Pick<FinalizeSessionInput, "appliedKnowledgeIds" | "contradictedKnowledgeIds">,
  ): string[] {
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
    for (const { id, applied } of feedback) {
      const row = this.db
        .prepare(
          `SELECT k.*, p.name AS project_name FROM knowledge k JOIN projects p ON p.id = k.project_id
           WHERE k.id = ? AND k.project_id = ?`,
        )
        .get(id, projectId) as KnowledgeRow | undefined;
      if (!row) {
        warnings.push(`${id}: Knowledge was not found in this project.`);
        continue;
      }
      const before = toKnowledge(row);
      const after: KnowledgeRecord = applied
        ? { ...before, lastConfirmedAt: completedAt, lastConfirmedSessionId: sessionId }
        : { ...before, review: { reason: "contradicted", sessionId, at: completedAt } };
      if (applied) {
        delete after.review;
      }
      this.db
        .prepare(
          "UPDATE knowledge SET last_confirmed_at = ?, last_confirmed_session_id = ?, review_json = ? WHERE id = ?",
        )
        .run(
          after.lastConfirmedAt ?? null,
          after.lastConfirmedSessionId ?? null,
          after.review ? JSON.stringify(after.review) : null,
          id,
        );
      const auditId = this.insertKnowledgeAudit({
        knowledge: after,
        before,
        action: "updated",
        changedFields: applied ? ["lastConfirmedAt", ...(before.review ? ["review"] : [])] : ["review"],
        occurredAt: completedAt,
      });
      this.insertFeedback(auditId, after, applied ? "applied" : "contradicted", completedAt, sessionId);
    }
    return warnings;
  }

  public withKnowledgeTrust(knowledge: KnowledgeRecord): KnowledgeRecord {
    return this.withKnowledgeTrustMany([knowledge])[0] ?? knowledge;
  }

  /**
   * Adds the possiblyStale marker and evidence counts to many Knowledge records at once. Each project's later
   * Sessions are read and their changed files normalized once, and evidence is one grouped query, instead of
   * once per Knowledge record.
   */
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

    const staleness = new Map<string, KnowledgeStaleness>();
    for (const [projectId, group] of byProject) {
      const project = this.dependencies.getProjectById(projectId);
      const contexts = project ? [{ name: project.name, rootPath: project.rootPath }] : [];
      const earliest = group.map(stalenessSince).reduce((min, since) => (since < min ? since : min));
      const sessions = this.loadLaterSessions(projectId, earliest, contexts);
      for (const item of group) {
        const result = knowledgeStaleness(item, sessions, contexts);
        if (result) {
          staleness.set(item.id, result);
        }
      }
    }
    return items.map((item) => {
      const result = staleness.get(item.id);
      const counts = evidence.get(item.id);
      return {
        ...item,
        ...(result ? { possiblyStale: result } : {}),
        ...(counts ? { evidence: counts } : {}),
      };
    });
  }

  /** Confirmation and contradiction counts per Knowledge id, from one grouped query. */
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

  /** A project's non-voided Sessions completed after `since`, oldest first, with changed files normalized once. */
  private loadLaterSessions(projectId: string, since: string, contexts: PathContext[]): LaterSession[] {
    const rows = this.db
      .prepare(
        `SELECT id, title, completed_at, changed_files_json FROM sessions
         WHERE project_id = ? AND voided_at IS NULL AND completed_at > ?
         ORDER BY completed_at ASC, id ASC`,
      )
      .all(projectId, since) as Array<{ id: string; title: string; completed_at: string; changed_files_json: string }>;
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      completedAt: row.completed_at,
      files: parseJson<string[]>(row.changed_files_json, []).map((file) => ({
        raw: file,
        normalized: normalizePath(file, contexts),
      })),
    }));
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
        this.db
          .prepare("UPDATE knowledge SET status = 'archived', updated_at = ? WHERE id = ?")
          .run(createdAt, before.id);
        this.insertKnowledgeAudit({
          knowledge: after,
          before,
          action: "archived",
          changedFields: ["status"],
          occurredAt: createdAt,
        });
      }

      return {
        outcome: "knowledge_recorded",
        duplicate: false,
        knowledge: this.withKnowledgeTrust(knowledge),
        ...(warnings.length > 0 ? { warnings } : {}),
        redactions: sanitizedContent.redactions,
      };
    });
  }

  public updateKnowledge(input: UpdateKnowledgeInput): UpdateKnowledgeResult {
    const decision = this.dependencies.checkProjectRoot(input.projectRoot);
    if (!decision.allowed || !decision.project) {
      return {
        outcome: "skipped",
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
             review_json = @review
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
      });
    this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(updatedAt, decision.project.id);
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

    return { outcome: "knowledge_updated", knowledge: this.withKnowledgeTrust(next), redactions };
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

  /** One confirmation or contradiction; it shares the id of the audit row written with it. */
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
