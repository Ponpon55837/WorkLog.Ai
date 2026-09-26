import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { nowIso } from "@work-intelligence/shared";
import type {
  LinkSessionsInput,
  LinkSessionsResult,
  KnowledgeRecord,
  PolicyDecision,
  ProjectRecord,
  SessionDetail,
  SessionLinkRecord,
  SessionLinkRelation,
  SetEvidenceVoidInput,
  SetEvidenceVoidResult,
  SetSessionVoidInput,
  SetSessionVoidResult,
  UpdateSessionMetadataInput,
  UpdateSessionMetadataResult,
  UpdateSessionSummaryInput,
  UpdateSessionSummaryResult,
  UpdateSessionWorkSummaryInput,
  UpdateSessionWorkSummaryResult,
  UpdateSessionVerificationResult,
  VerificationSummary,
  VerificationUpdateSource,
  VoidTargetType,
  WorkSessionRecord,
} from "@work-intelligence/core";
import { isChangedFilesMetadataConfirmed } from "./changed-files-confirmation.js";
import {
  normalizeChangedFileChanges,
  changedFilePathsFromChanges,
  mergeChangedFileChanges,
  normalizeChangedFiles,
  mergeChangedFiles,
  normalizeVerification,
  parseJson,
  parseWorkSummarySections,
  normalizeWorkSummaryPatch,
  completeWorkSummary,
  mergeWorkSummary,
  sameVerification,
  requireVoidReason,
  toSession,
  toEvent,
  toSnapshot,
  toEvidence,
  toVoidAudit,
  toVerificationUpdate,
  toKnowledge,
} from "./session-record-codecs.js";
import type {
  EvidenceRow,
  EventRow,
  KnowledgeRow,
  SnapshotRow,
  VerificationUpdateRow,
  VoidAuditRow,
} from "./session-record-codecs.js";
import { createProjectPathResolver } from "@work-intelligence/project-policy";
import { runImmediateTransaction as runImmediateSqlTransaction } from "./sqlite-transaction.js";
import type { SessionRow } from "./session-repository.js";

export interface SessionRecordDependencies {
  checkProjectById(projectId: string): PolicyDecision;
  getSessionById(sessionId: string): WorkSessionRecord | undefined;
  getProjectById(projectId: string): ProjectRecord | undefined;
  withKnowledgeTrust(knowledge: KnowledgeRecord): KnowledgeRecord;
}

export class SessionRecordService {
  public constructor(
    private readonly db: DatabaseSync,
    private readonly dependencies: SessionRecordDependencies,
  ) {}

  public updateSessionVerification(
    sessionId: string,
    verification: VerificationSummary,
    source: VerificationUpdateSource = "agent",
  ): UpdateSessionVerificationResult {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as SessionRow | undefined;
    if (!row) {
      return { outcome: "not_found", sessionId };
    }

    const decision = this.dependencies.checkProjectById(row.project_id);
    if (!decision?.allowed || !decision.project) {
      return {
        outcome: "skipped",
        sessionId,
        projectStatus: decision?.projectStatus ?? "unregistered",
        reason: decision?.reason ?? "Project recording is not enabled.",
      };
    }

    const project = decision.project;
    const previous = parseJson<VerificationSummary | undefined>(row.verification_json, undefined);
    const next = normalizeVerification(verification);
    const unchanged = sameVerification(previous, next);
    if (!unchanged) {
      const updatedAt = nowIso();
      runImmediateSqlTransaction(this.db, () => {
        this.db.prepare("UPDATE sessions SET verification_json = ? WHERE id = ?").run(JSON.stringify(next), sessionId);
        this.touchSession(sessionId, updatedAt);
        this.insertVerificationUpdate(sessionId, source, previous, next, updatedAt);
        this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(updatedAt, project.id);
      });
    }

    const session = this.dependencies.getSessionById(sessionId);
    if (!session) {
      throw new Error("Session verification was updated but could not be loaded.");
    }
    return { outcome: "updated", session, previous, ...(unchanged ? { unchanged } : {}) };
  }

  public linkSessions(input: LinkSessionsInput, source: VerificationUpdateSource = "agent"): LinkSessionsResult {
    const row = this.db.prepare("SELECT project_id FROM sessions WHERE id = ?").get(input.sessionId) as
      { project_id: string } | undefined;
    if (!row) {
      return { outcome: "not_found", sessionId: input.sessionId };
    }
    const decision = this.dependencies.checkProjectById(row.project_id);
    if (!decision.allowed || !decision.project) {
      return {
        outcome: "skipped",
        sessionId: input.sessionId,
        projectStatus: decision.projectStatus,
        reason: decision.reason ?? "Project recording is not enabled.",
      };
    }
    const problem = this.linkProblem(input.sessionId, input.relatedSessionId);
    if (problem) {
      return { outcome: "invalid_link", sessionId: input.sessionId, reason: problem };
    }
    return runImmediateSqlTransaction(this.db, () => {
      const existing = this.db
        .prepare(
          `SELECT session_id, related_session_id, relation FROM session_links
           WHERE (session_id = ? AND related_session_id = ?) OR (session_id = ? AND related_session_id = ?)`,
        )
        .get(input.sessionId, input.relatedSessionId, input.relatedSessionId, input.sessionId) as
        { session_id: string; related_session_id: string; relation: SessionLinkRelation } | undefined;
      const same =
        existing?.session_id === input.sessionId &&
        existing.related_session_id === input.relatedSessionId &&
        existing.relation === input.relation;
      const duplicate = input.linked ? same : !existing;
      if (!duplicate) {
        this.db
          .prepare(
            `DELETE FROM session_links
             WHERE (session_id = ? AND related_session_id = ?) OR (session_id = ? AND related_session_id = ?)`,
          )
          .run(input.sessionId, input.relatedSessionId, input.relatedSessionId, input.sessionId);
        const changedAt = nowIso();
        if (input.linked) {
          this.writeSessionLink(input.sessionId, input.relatedSessionId, input.relation, source, changedAt);
        }
        this.touchSession(input.sessionId, changedAt);
        this.touchSession(input.relatedSessionId, changedAt);
      }
      return {
        outcome: "session_link_updated",
        duplicate,
        sessionId: input.sessionId,
        links: this.getSessionLinks(input.sessionId),
      };
    });
  }

  public linkProblem(sessionId: string, relatedSessionId: string): string | undefined {
    if (sessionId === relatedSessionId) {
      return "A Session cannot be linked to itself.";
    }
    const related = this.db.prepare("SELECT project_id FROM sessions WHERE id = ?").get(relatedSessionId) as
      { project_id: string } | undefined;
    if (!related) {
      return "The related Session does not exist.";
    }
    if (!this.dependencies.checkProjectById(related.project_id).allowed) {
      return "The related Session belongs to a project that is not tracked.";
    }
    return undefined;
  }

  public writeSessionLink(
    sessionId: string,
    relatedSessionId: string,
    relation: SessionLinkRelation,
    source: VerificationUpdateSource,
    createdAt: string,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO session_links (id, session_id, related_session_id, relation, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), sessionId, relatedSessionId, relation, source, createdAt);
  }

  public getSessionLinks(sessionId: string): SessionLinkRecord[] {
    const rows = this.db
      .prepare(
        `SELECT l.session_id, l.relation, s.id AS other_id, s.title, s.completed_at, s.voided_at, p.name AS project_name
         FROM session_links l
         JOIN sessions s ON s.id = CASE WHEN l.session_id = ? THEN l.related_session_id ELSE l.session_id END
         JOIN projects p ON p.id = s.project_id
         WHERE (l.session_id = ? OR l.related_session_id = ?) AND p.status = 'tracked'
         ORDER BY s.completed_at ASC, s.id ASC`,
      )
      .all(sessionId, sessionId, sessionId) as Array<{
      session_id: string;
      relation: SessionLinkRelation;
      other_id: string;
      title: string;
      completed_at: string;
      voided_at: string | null;
      project_name: string | null;
    }>;
    return rows.map((row) => ({
      sessionId: row.other_id,
      title: row.title,
      ...(row.project_name ? { projectName: row.project_name } : {}),
      completedAt: row.completed_at,
      relation: row.relation === "related" ? "related" : row.session_id === sessionId ? "continues" : "continued_by",
      ...(row.voided_at ? { voided: true } : {}),
    }));
  }

  public touchSession(sessionId: string, at: string): void {
    this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(at, sessionId);
  }

  public hasConfirmedChangedFilesForSession(sessionId: string): boolean {
    const row = this.db
      .prepare("SELECT changed_files_json, changed_files_confirmed FROM sessions WHERE id = ?")
      .get(sessionId) as { changed_files_json: string | null; changed_files_confirmed?: number } | undefined;
    return row ? isChangedFilesMetadataConfirmed(row.changed_files_json, row.changed_files_confirmed) : false;
  }

  private insertVerificationUpdate(
    sessionId: string,
    source: VerificationUpdateSource,
    previous: VerificationSummary | undefined,
    resulting: VerificationSummary,
    createdAt: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO session_verification_updates (id, session_id, source, previous_json, resulting_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        sessionId,
        source,
        previous ? JSON.stringify(previous) : null,
        JSON.stringify(resulting),
        createdAt,
      );
  }

  public updateSessionMetadata(input: UpdateSessionMetadataInput): UpdateSessionMetadataResult {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(input.sessionId) as SessionRow | undefined;
    if (!row) {
      return { outcome: "not_found", sessionId: input.sessionId };
    }

    const decision = this.dependencies.checkProjectById(row.project_id);
    if (!decision?.allowed || !decision.project) {
      return {
        outcome: "skipped",
        sessionId: input.sessionId,
        projectStatus: decision?.projectStatus ?? "unregistered",
        reason: decision?.reason ?? "Project recording is not enabled.",
      };
    }

    const project = decision.project;
    const current = toSession(row);
    const pathResolver = createProjectPathResolver(project.rootPath);
    const incomingChangedFileChanges = normalizeChangedFileChanges(
      project.rootPath,
      input.changedFileChanges,
      pathResolver,
    );
    const normalizedChangedFiles =
      input.changedFilesMode === "merge"
        ? mergeChangedFiles(
            project.rootPath,
            current,
            [...input.changedFiles, ...changedFilePathsFromChanges(incomingChangedFileChanges)],
            input.changedFilesProvenance,
            pathResolver,
          )
        : normalizeChangedFiles(
            project.rootPath,
            [...input.changedFiles, ...changedFilePathsFromChanges(incomingChangedFileChanges)],
            input.changedFilesProvenance,
            pathResolver,
          );
    const changedFileChanges =
      input.changedFilesMode === "merge"
        ? mergeChangedFileChanges(project.rootPath, current, incomingChangedFileChanges, pathResolver)
        : input.changedFileChanges === undefined
          ? current.changedFileChanges
          : incomingChangedFileChanges;
    const changedFilesConfirmed =
      normalizedChangedFiles.files.length > 0 ||
      input.changedFilesMode !== "merge" ||
      (input.changedFileChanges?.length ?? 0) > 0 ||
      isChangedFilesMetadataConfirmed(row.changed_files_json, row.changed_files_confirmed);
    const updatedAt = nowIso();
    const nextVerification = input.verification ? normalizeVerification(input.verification) : undefined;
    runImmediateSqlTransaction(this.db, () => {
      if (nextVerification && !sameVerification(current.verification, nextVerification)) {
        this.insertVerificationUpdate(input.sessionId, "agent", current.verification, nextVerification, updatedAt);
      }
      this.db
        .prepare(
          `UPDATE sessions
           SET changed_files_json = @changedFiles,
               changed_files_confirmed = @changedFilesConfirmed,
               changed_files_provenance_json = @changedFilesProvenance,
               changed_file_changes_json = @changedFileChanges,
               verification_json = @verification,
               commit_sha = @commitSha,
               git_branch = @gitBranch
           WHERE id = @id`,
        )
        .run({
          id: input.sessionId,
          changedFiles: JSON.stringify(normalizedChangedFiles.files),
          changedFilesConfirmed: changedFilesConfirmed ? 1 : 0,
          changedFilesProvenance: JSON.stringify(normalizedChangedFiles.provenance),
          changedFileChanges: JSON.stringify(changedFileChanges),
          verification: nextVerification
            ? JSON.stringify(nextVerification)
            : current.verification
              ? JSON.stringify(current.verification)
              : null,
          commitSha: input.git?.commitSha ?? current.commitSha ?? null,
          gitBranch: input.git?.branch ?? current.gitBranch ?? null,
        });
      if (input.startedAt && input.startedAt <= current.completedAt) {
        this.db.prepare("UPDATE sessions SET started_at = ? WHERE id = ?").run(input.startedAt, input.sessionId);
      }
      this.touchSession(input.sessionId, updatedAt);
      this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(updatedAt, project.id);
    });

    const session = this.dependencies.getSessionById(input.sessionId);
    if (!session) {
      throw new Error("Session metadata was updated but could not be loaded.");
    }
    return { outcome: "updated", session };
  }

  public updateSessionSummary(input: UpdateSessionSummaryInput): UpdateSessionSummaryResult {
    const row = this.db
      .prepare(
        `SELECT s.*, p.name AS project_name
         FROM sessions s
         JOIN projects p ON p.id = s.project_id
         WHERE s.id = ?`,
      )
      .get(input.sessionId) as SessionRow | undefined;
    if (!row) {
      return { outcome: "not_found", sessionId: input.sessionId };
    }

    const decision = this.dependencies.checkProjectById(row.project_id);
    if (!decision?.allowed || !decision.project) {
      return {
        outcome: "skipped",
        sessionId: input.sessionId,
        projectStatus: decision?.projectStatus ?? "unregistered",
        reason: decision?.reason ?? "Project recording is not enabled.",
      };
    }

    const project = decision.project;
    const mode = input.mode ?? "replace";
    const summary = input.summary.trim();
    if (!summary) {
      throw new Error("Session summary must not be empty.");
    }

    return runImmediateSqlTransaction(this.db, () => {
      const existingUpdate = this.db
        .prepare(
          "SELECT session_id, idempotency_key, mode, summary, previous_summary, resulting_summary FROM session_summary_updates WHERE idempotency_key = ?",
        )
        .get(input.idempotencyKey) as
        | {
            session_id: string;
            idempotency_key: string;
            mode: "replace" | "append";
            summary: string;
            previous_summary: string;
            resulting_summary: string;
          }
        | undefined;
      if (existingUpdate) {
        if (
          existingUpdate.session_id !== input.sessionId ||
          existingUpdate.mode !== mode ||
          existingUpdate.summary !== summary
        ) {
          return {
            outcome: "summary_update_idempotency_conflict",
            sessionId: input.sessionId,
            idempotencyKey: input.idempotencyKey,
            reason: "這個摘要更新 idempotencyKey 已經用於不同的 Session、模式或內容；請使用新的 idempotencyKey。",
          };
        }

        const session = this.dependencies.getSessionById(input.sessionId);
        if (!session) {
          return { outcome: "not_found", sessionId: input.sessionId };
        }
        return {
          outcome: "summary_updated",
          duplicate: true,
          session,
          idempotencyKey: input.idempotencyKey,
          mode,
          previousSummary: existingUpdate.previous_summary,
          appliedSummary: existingUpdate.resulting_summary,
        };
      }

      const currentRow = this.db.prepare("SELECT summary FROM sessions WHERE id = ?").get(input.sessionId) as
        { summary?: string } | undefined;
      if (!currentRow) {
        return { outcome: "not_found", sessionId: input.sessionId };
      }
      const previousSummary = currentRow.summary ?? "";
      const appliedSummary = mode === "append" ? `${previousSummary.trim()}\n\n${summary}` : summary;
      const createdAt = nowIso();
      this.db.prepare("UPDATE sessions SET summary = ? WHERE id = ?").run(appliedSummary, input.sessionId);
      this.touchSession(input.sessionId, createdAt);
      this.db
        .prepare(
          `INSERT INTO session_summary_updates (
             id, session_id, idempotency_key, mode, summary, previous_summary, resulting_summary, created_at
           ) VALUES (@id, @sessionId, @idempotencyKey, @mode, @summary, @previousSummary, @resultingSummary, @createdAt)`,
        )
        .run({
          id: randomUUID(),
          sessionId: input.sessionId,
          idempotencyKey: input.idempotencyKey,
          mode,
          summary,
          previousSummary,
          resultingSummary: appliedSummary,
          createdAt,
        });
      this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(createdAt, project.id);

      const session = this.dependencies.getSessionById(input.sessionId);
      if (!session) {
        throw new Error("Session summary was updated but could not be loaded.");
      }
      return {
        outcome: "summary_updated",
        duplicate: false,
        session,
        idempotencyKey: input.idempotencyKey,
        mode,
        previousSummary,
        appliedSummary,
      };
    });
  }

  public updateSessionWorkSummary(input: UpdateSessionWorkSummaryInput): UpdateSessionWorkSummaryResult {
    const row = this.db
      .prepare(
        `SELECT s.*, p.name AS project_name
         FROM sessions s
         JOIN projects p ON p.id = s.project_id
         WHERE s.id = ?`,
      )
      .get(input.sessionId) as SessionRow | undefined;
    if (!row) {
      return { outcome: "not_found", sessionId: input.sessionId };
    }

    const decision = this.dependencies.checkProjectById(row.project_id);
    if (!decision?.allowed || !decision.project) {
      return {
        outcome: "skipped",
        sessionId: input.sessionId,
        projectStatus: decision?.projectStatus ?? "unregistered",
        reason: decision?.reason ?? "Project recording is not enabled.",
      };
    }

    const mode = input.mode ?? "replace";
    const normalizedPatch = normalizeWorkSummaryPatch(input.workSummary);
    if (Object.keys(normalizedPatch).length === 0) {
      throw new Error("At least one workSummary section is required.");
    }
    const replacement = mode === "replace" ? completeWorkSummary(normalizedPatch) : undefined;
    if (mode === "replace" && !replacement) {
      throw new Error("replace mode requires all five workSummary sections.");
    }
    const requestJson = JSON.stringify(normalizedPatch);
    const project = decision.project;

    return runImmediateSqlTransaction(this.db, () => {
      const existingUpdate = this.db
        .prepare(
          `SELECT session_id, idempotency_key, mode, work_summary_json, previous_work_summary_json, resulting_work_summary_json
           FROM session_work_summary_updates
           WHERE idempotency_key = ?`,
        )
        .get(input.idempotencyKey) as
        | {
            session_id: string;
            idempotency_key: string;
            mode: "replace" | "patch";
            work_summary_json: string;
            previous_work_summary_json: string;
            resulting_work_summary_json: string;
          }
        | undefined;
      if (existingUpdate) {
        if (
          existingUpdate.session_id !== input.sessionId ||
          existingUpdate.mode !== mode ||
          existingUpdate.work_summary_json !== requestJson
        ) {
          return {
            outcome: "work_summary_update_idempotency_conflict",
            sessionId: input.sessionId,
            idempotencyKey: input.idempotencyKey,
            reason:
              "這個 workSummary 更新 idempotencyKey 已經用於不同的 Session、模式或內容；請使用新的 idempotencyKey。",
          };
        }

        const session = this.dependencies.getSessionById(input.sessionId);
        const appliedWorkSummary = parseWorkSummarySections(existingUpdate.resulting_work_summary_json);
        if (!session || !appliedWorkSummary) {
          return { outcome: "not_found", sessionId: input.sessionId };
        }
        const previousWorkSummary = parseWorkSummarySections(existingUpdate.previous_work_summary_json);
        return {
          outcome: "work_summary_updated",
          duplicate: true,
          session,
          idempotencyKey: input.idempotencyKey,
          mode,
          ...(previousWorkSummary ? { previousWorkSummary } : {}),
          appliedWorkSummary,
        };
      }

      const currentRow = this.db.prepare("SELECT work_summary_json FROM sessions WHERE id = ?").get(input.sessionId) as
        | {
            work_summary_json?: string | null;
          }
        | undefined;
      if (!currentRow) {
        return { outcome: "not_found", sessionId: input.sessionId };
      }
      const previousWorkSummary = parseWorkSummarySections(currentRow.work_summary_json ?? null);
      const appliedWorkSummary = replacement ?? mergeWorkSummary(previousWorkSummary, normalizedPatch);
      const createdAt = nowIso();
      this.db
        .prepare("UPDATE sessions SET work_summary_json = ? WHERE id = ?")
        .run(JSON.stringify(appliedWorkSummary), input.sessionId);
      this.touchSession(input.sessionId, createdAt);
      this.db
        .prepare(
          `INSERT INTO session_work_summary_updates (
             id, session_id, idempotency_key, mode, work_summary_json, previous_work_summary_json, resulting_work_summary_json, created_at
           ) VALUES (@id, @sessionId, @idempotencyKey, @mode, @workSummary, @previousWorkSummary, @resultingWorkSummary, @createdAt)`,
        )
        .run({
          id: randomUUID(),
          sessionId: input.sessionId,
          idempotencyKey: input.idempotencyKey,
          mode,
          workSummary: requestJson,
          previousWorkSummary: JSON.stringify(previousWorkSummary ?? {}),
          resultingWorkSummary: JSON.stringify(appliedWorkSummary),
          createdAt,
        });
      this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(createdAt, project.id);

      const session = this.dependencies.getSessionById(input.sessionId);
      if (!session) {
        throw new Error("Session workSummary was updated but could not be loaded.");
      }
      return {
        outcome: "work_summary_updated",
        duplicate: false,
        session,
        idempotencyKey: input.idempotencyKey,
        mode,
        ...(previousWorkSummary ? { previousWorkSummary } : {}),
        appliedWorkSummary,
      };
    });
  }

  public getSessionDetail(sessionId: string): SessionDetail | undefined {
    const row = this.db
      .prepare(
        `SELECT s.*, p.name AS project_name
         FROM sessions s
         JOIN projects p ON p.id = s.project_id
         WHERE s.id = ?`,
      )
      .get(sessionId) as SessionRow | undefined;
    if (!row) {
      return undefined;
    }

    const project = this.dependencies.getProjectById(row.project_id);
    if (!project || project.status !== "tracked") {
      return undefined;
    }

    const events = this.db
      .prepare("SELECT * FROM work_events WHERE session_id = ? ORDER BY occurred_at ASC")
      .all(sessionId) as EventRow[];
    const snapshots = this.db
      .prepare("SELECT * FROM raw_snapshots WHERE session_id = ? ORDER BY captured_at ASC")
      .all(sessionId) as SnapshotRow[];
    const evidence = this.db
      .prepare("SELECT * FROM evidence WHERE session_id = ? ORDER BY captured_at ASC, rowid ASC")
      .all(sessionId) as EvidenceRow[];
    const knowledge = this.db
      .prepare(
        `SELECT k.*, p.name AS project_name
         FROM knowledge k
         JOIN projects p ON p.id = k.project_id
         WHERE k.session_id = ?
         ORDER BY k.updated_at DESC, k.id ASC`,
      )
      .all(sessionId) as KnowledgeRow[];

    return {
      session: toSession(row),
      project,
      events: events.map(toEvent),
      rawSnapshots: snapshots.map(toSnapshot),
      evidence: evidence.map(toEvidence),
      knowledge: knowledge.map((row) => this.dependencies.withKnowledgeTrust(toKnowledge(row))),
      links: this.getSessionLinks(sessionId),
      verificationHistory: (
        this.db
          .prepare(
            "SELECT * FROM session_verification_updates WHERE session_id = ? ORDER BY created_at DESC, rowid DESC",
          )
          .all(sessionId) as VerificationUpdateRow[]
      ).map(toVerificationUpdate),
      voidHistory: (
        this.db
          .prepare("SELECT * FROM void_audit WHERE session_id = ? ORDER BY occurred_at DESC, rowid DESC")
          .all(sessionId) as VoidAuditRow[]
      ).map(toVoidAudit),
    };
  }

  public setSessionVoid(input: SetSessionVoidInput): SetSessionVoidResult {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(input.sessionId) as SessionRow | undefined;
    if (!row) {
      return { outcome: "not_found", sessionId: input.sessionId };
    }
    const decision = this.dependencies.checkProjectById(row.project_id);
    if (!decision.allowed || !decision.project) {
      return {
        outcome: "skipped",
        sessionId: input.sessionId,
        projectStatus: decision.projectStatus,
        reason: decision.reason ?? "Project recording is not enabled.",
      };
    }
    const projectId = decision.project.id;
    const reason = requireVoidReason(input.voided, input.reason);
    return runImmediateSqlTransaction(this.db, () => {
      const current = this.db.prepare("SELECT voided_at FROM sessions WHERE id = ?").get(input.sessionId) as {
        voided_at: string | null;
      };
      const duplicate = Boolean(current.voided_at) === input.voided;
      if (!duplicate) {
        const occurredAt = nowIso();
        this.db
          .prepare("UPDATE sessions SET voided_at = ?, void_reason = ? WHERE id = ?")
          .run(input.voided ? occurredAt : null, input.voided ? (reason ?? null) : null, input.sessionId);
        this.insertVoidAudit("session", input.sessionId, input.sessionId, projectId, input.voided, reason, occurredAt);
        this.touchSession(input.sessionId, occurredAt);
        this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(occurredAt, projectId);
      }
      const session = this.dependencies.getSessionById(input.sessionId);
      if (!session) {
        throw new Error("Session void state was updated but the Session could not be loaded.");
      }
      return { outcome: "session_void_updated", duplicate, session };
    });
  }

  public setEvidenceVoid(input: SetEvidenceVoidInput): SetEvidenceVoidResult {
    const row = this.db.prepare("SELECT * FROM evidence WHERE id = ?").get(input.evidenceId) as EvidenceRow | undefined;
    if (!row) {
      return { outcome: "not_found", evidenceId: input.evidenceId };
    }
    const decision = this.dependencies.checkProjectById(row.project_id);
    if (!decision.allowed || !decision.project) {
      return {
        outcome: "skipped",
        evidenceId: input.evidenceId,
        projectStatus: decision.projectStatus,
        reason: decision.reason ?? "Project recording is not enabled.",
      };
    }
    const projectId = decision.project.id;
    const reason = requireVoidReason(input.voided, input.reason);
    return runImmediateSqlTransaction(this.db, () => {
      const duplicate = Boolean(row.voided_at) === input.voided;
      if (!duplicate) {
        const occurredAt = nowIso();
        this.db
          .prepare("UPDATE evidence SET voided_at = ?, void_reason = ? WHERE id = ?")
          .run(input.voided ? occurredAt : null, input.voided ? (reason ?? null) : null, input.evidenceId);
        this.insertVoidAudit("evidence", input.evidenceId, row.session_id, projectId, input.voided, reason, occurredAt);
        this.touchSession(row.session_id, occurredAt);
        this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(occurredAt, projectId);
      }
      const updated = this.db.prepare("SELECT * FROM evidence WHERE id = ?").get(input.evidenceId) as EvidenceRow;
      return { outcome: "evidence_void_updated", duplicate, evidence: toEvidence(updated) };
    });
  }

  private insertVoidAudit(
    targetType: VoidTargetType,
    targetId: string,
    sessionId: string,
    projectId: string,
    voided: boolean,
    reason: string | undefined,
    occurredAt: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO void_audit (id, target_type, target_id, session_id, project_id, action, reason, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        targetType,
        targetId,
        sessionId,
        projectId,
        voided ? "voided" : "restored",
        reason ?? null,
        occurredAt,
      );
  }
}
