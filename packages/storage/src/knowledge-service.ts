import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { nowIso } from "@work-intelligence/shared";
import type {
  FinalizeSessionInput,
  KnowledgeAuditAction,
  KnowledgeAuditRecord,
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
import { matchesAppliesTo, normalizePath } from "./search-text.js";
import { runImmediateTransaction as runImmediateSqlTransaction } from "./sqlite-transaction.js";
import { cleanList, parseJson, toKnowledge, toKnowledgeAudit } from "./session-record-codecs.js";
import type { KnowledgeAuditRow, KnowledgeRow } from "./session-record-codecs.js";

export interface KnowledgeServiceDependencies {
  checkProjectRoot(projectRoot: string): PolicyDecision;
  getProjectById(projectId: string): ProjectRecord | undefined;
  searchKnowledge(options: KnowledgeQuery): KnowledgeQueryResult | KnowledgeSkippedResult;
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
      this.insertKnowledgeAudit({
        knowledge: after,
        before,
        action: "updated",
        changedFields: applied ? ["lastConfirmedAt", ...(before.review ? ["review"] : [])] : ["review"],
        occurredAt: completedAt,
      });
    }
    return warnings;
  }

  public withKnowledgeTrust(knowledge: KnowledgeRecord): KnowledgeRecord {
    const staleness = this.knowledgeStaleness(knowledge);
    return staleness ? { ...knowledge, possiblyStale: staleness } : knowledge;
  }

  private knowledgeStaleness(knowledge: KnowledgeRecord): KnowledgeStaleness | undefined {
    if (knowledge.appliesTo.length === 0) {
      return undefined;
    }
    const project = this.dependencies.getProjectById(knowledge.projectId);
    const contexts = project ? [{ name: project.name, rootPath: project.rootPath }] : [];
    const patterns = knowledge.appliesTo.map((pattern) => normalizePath(pattern, contexts)).filter(Boolean);
    const excluded = new Set([knowledge.sessionId, knowledge.lastConfirmedSessionId].filter(Boolean));
    const rows = this.db
      .prepare(
        `SELECT id, title, completed_at, changed_files_json FROM sessions
         WHERE project_id = ? AND voided_at IS NULL AND completed_at > ?
         ORDER BY completed_at ASC, id ASC`,
      )
      .all(knowledge.projectId, knowledge.lastConfirmedAt ?? knowledge.createdAt) as Array<{
      id: string;
      title: string;
      completed_at: string;
      changed_files_json: string;
    }>;
    let first: KnowledgeStaleness | undefined;
    let sessionCount = 0;
    for (const row of rows) {
      if (excluded.has(row.id)) {
        continue;
      }
      const paths = parseJson<string[]>(row.changed_files_json, []).filter((file) => {
        const normalized = normalizePath(file, contexts);
        return patterns.some((pattern) => matchesAppliesTo(normalized, pattern));
      });
      if (paths.length === 0) {
        continue;
      }
      sessionCount += 1;
      first ??= {
        sessionId: row.id,
        sessionTitle: row.title,
        completedAt: row.completed_at,
        paths: paths.slice(0, 5),
        sessionCount: 0,
      };
    }
    return first ? { ...first, sessionCount } : undefined;
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
        title: input.title.trim(),
        body: input.body.trim(),
        tags: [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))],
        references: [...new Set((input.references ?? []).map((reference) => reference.trim()).filter(Boolean))],
        status: "active",
        createdAt,
        updatedAt: createdAt,
        appliesTo: cleanList(input.appliesTo),
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
    const updatedAt = nowIso();
    const next: KnowledgeRecord = {
      ...current,
      kind: input.kind ?? current.kind,
      title: input.title?.trim() || current.title,
      body: input.body?.trim() || current.body,
      tags: input.tags ? [...new Set(input.tags.map((tag) => tag.trim()).filter(Boolean))] : current.tags,
      references: input.references
        ? [...new Set(input.references.map((reference) => reference.trim()).filter(Boolean))]
        : current.references,
      status: input.status ?? current.status,
      updatedAt,
      appliesTo: input.appliesTo ? cleanList(input.appliesTo) : current.appliesTo,
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
    this.insertKnowledgeAudit({ knowledge: next, before: current, action, changedFields, occurredAt: updatedAt });

    return { outcome: "knowledge_updated", knowledge: this.withKnowledgeTrust(next) };
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

    return {
      outcome: "knowledge_history",
      project: decision.project,
      knowledge: toKnowledge(row),
      history: auditRows.map(toKnowledgeAudit),
    };
  }

  public searchKnowledge(options: KnowledgeQuery = {}): KnowledgeQueryResult | KnowledgeSkippedResult {
    const result = this.dependencies.searchKnowledge(options);
    return result.outcome === "knowledge"
      ? { ...result, items: result.items.map((item) => this.withKnowledgeTrust(item)) }
      : result;
  }

  private insertKnowledgeAudit(input: {
    knowledge: KnowledgeRecord;
    before?: KnowledgeRecord;
    action: KnowledgeAuditAction;
    changedFields: string[];
    occurredAt: string;
  }): void {
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
  }
}
