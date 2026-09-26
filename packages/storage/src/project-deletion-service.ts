import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DeleteProjectResult, ProjectDeletionAuditRecord, ProjectDeletionCounts } from "@work-intelligence/core";
import { nowIso } from "@work-intelligence/shared";
import { backupDatabaseBeforeProjectDeletion, type BackupRetentionOptions } from "./backup.js";
import { runImmediateTransaction } from "./sqlite-transaction.js";
import { SearchRepository } from "./search-repository.js";

export type ProjectDeletionErrorCode =
  "PROJECT_NOT_FOUND" | "PROJECT_NAME_MISMATCH" | "PROJECT_BACKUP_FAILED" | "PROJECT_DELETE_FAILED";

export class ProjectDeletionError extends Error {
  public constructor(public readonly code: ProjectDeletionErrorCode) {
    super(code);
    this.name = "ProjectDeletionError";
  }
}

type ProjectRow = { id: string; name: string };
type ProjectDeletionAuditRow = { deleted_at: string; project_id: string; deleted_counts_json: string };
type CountRow = { count: number };
type IdRow = { id: string };
type DeletableTable =
  | "knowledge_candidates"
  | "knowledge_candidate_requests"
  | "report_summaries"
  | "report_synthesis_requests"
  | "metadata_backfill_requests";

const projectDeletionCountKeys = [
  "projects",
  "sessions",
  "workEvents",
  "rawSnapshots",
  "evidence",
  "knowledge",
  "knowledgeAudit",
  "voidAudit",
  "sessionVerificationUpdates",
  "sessionLinks",
  "knowledgeCandidateRequests",
  "knowledgeCandidates",
  "reportSynthesisRequests",
  "reportSummaries",
  "metadataBackfillRequests",
  "sessionSummaryUpdates",
  "sessionWorkSummaryUpdates",
  "searchChunks",
  "searchFts",
  "searchPaths",
  "searchDirty",
] as const satisfies ReadonlyArray<keyof ProjectDeletionCounts>;

function parseProjectDeletionCounts(value: string): ProjectDeletionCounts {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid project deletion audit counts.");
  }

  const source = parsed as Record<string, unknown>;
  const counts = {} as ProjectDeletionCounts;
  for (const key of projectDeletionCountKeys) {
    const count = source[key];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw new Error("Invalid project deletion audit counts.");
    }
    counts[key] = count;
  }
  return counts;
}

const sourceSessionMatch = `EXISTS (
  SELECT 1
  FROM json_each(
    CASE WHEN json_valid(source_session_ids_json) THEN source_session_ids_json ELSE '[]' END
  ) AS source_session
  WHERE source_session.value IN (SELECT value FROM json_each(?))
)`;

function countRows(db: DatabaseSync, sql: string, ...parameters: Array<string | number>): number {
  return (db.prepare(sql).get(...parameters) as CountRow).count;
}

function ids(db: DatabaseSync, sql: string, ...parameters: Array<string | number>): string[] {
  return (db.prepare(sql).all(...parameters) as IdRow[]).map((row) => row.id);
}

function projectReportRequestIds(db: DatabaseSync, projectId: string, sessionIds: string[]): string[] {
  return ids(
    db,
    `SELECT id FROM report_synthesis_requests
     WHERE project_id = ? OR ${sourceSessionMatch}`,
    projectId,
    JSON.stringify(sessionIds),
  );
}

function projectMetadataRequestIds(db: DatabaseSync, projectId: string, sessionIds: string[]): string[] {
  return ids(
    db,
    `SELECT id FROM metadata_backfill_requests
     WHERE project_id = ? OR ${sourceSessionMatch}`,
    projectId,
    JSON.stringify(sessionIds),
  );
}

function projectCandidateRequestIds(db: DatabaseSync, projectId: string, sessionIds: string[]): string[] {
  return ids(
    db,
    `SELECT id FROM knowledge_candidate_requests
     WHERE project_id = ? OR ${sourceSessionMatch}`,
    projectId,
    JSON.stringify(sessionIds),
  );
}

function countProjectCandidates(
  db: DatabaseSync,
  projectId: string,
  sessionIds: string[],
  knowledgeIds: string[],
  requestIds: string[],
): number {
  return countRows(
    db,
    `SELECT COUNT(*) AS count FROM knowledge_candidates
     WHERE project_id = ?
       OR session_id IN (SELECT value FROM json_each(?))
       OR knowledge_id IN (SELECT value FROM json_each(?))
       OR request_id IN (SELECT value FROM json_each(?))`,
    projectId,
    JSON.stringify(sessionIds),
    JSON.stringify(knowledgeIds),
    JSON.stringify(requestIds),
  );
}

function countProjectReportSummaries(
  db: DatabaseSync,
  projectId: string,
  sessionIds: string[],
  requestIds: string[],
): number {
  return countRows(
    db,
    `SELECT COUNT(*) AS count FROM report_summaries
     WHERE project_id = ?
       OR EXISTS (
         SELECT 1 FROM json_each(
           CASE WHEN json_valid(report_summaries.source_session_ids_json)
             THEN report_summaries.source_session_ids_json ELSE '[]' END
         ) AS source_session
         WHERE source_session.value IN (SELECT value FROM json_each(?))
       )
       OR request_id IN (SELECT value FROM json_each(?))`,
    projectId,
    JSON.stringify(sessionIds),
    JSON.stringify(requestIds),
  );
}

function deleteByIds(db: DatabaseSync, table: DeletableTable, requestIds: string[]): void {
  if (requestIds.length === 0) {
    return;
  }
  // The table name is selected only from the service's static call sites; ids remain bound JSON values.
  db.prepare(`DELETE FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`).run(JSON.stringify(requestIds));
}

function makeDeletionCounts(
  db: DatabaseSync,
  projectId: string,
  sessionIds: string[],
  knowledgeIds: string[],
  candidateRequestIds: string[],
  reportRequestIds: string[],
  metadataRequestIds: string[],
): ProjectDeletionCounts {
  const sessionIdJson = JSON.stringify(sessionIds);
  return {
    projects: 1,
    sessions: countRows(db, "SELECT COUNT(*) AS count FROM sessions WHERE project_id = ?", projectId),
    workEvents: countRows(
      db,
      "SELECT COUNT(*) AS count FROM work_events WHERE session_id IN (SELECT value FROM json_each(?))",
      sessionIdJson,
    ),
    rawSnapshots: countRows(
      db,
      `SELECT COUNT(*) AS count FROM raw_snapshots
       WHERE project_id = ? OR session_id IN (SELECT value FROM json_each(?))`,
      projectId,
      sessionIdJson,
    ),
    evidence: countRows(
      db,
      `SELECT COUNT(*) AS count FROM evidence
       WHERE project_id = ? OR session_id IN (SELECT value FROM json_each(?))`,
      projectId,
      sessionIdJson,
    ),
    knowledge: countRows(db, "SELECT COUNT(*) AS count FROM knowledge WHERE project_id = ?", projectId),
    knowledgeAudit: countRows(db, "SELECT COUNT(*) AS count FROM knowledge_audit WHERE project_id = ?", projectId),
    voidAudit: countRows(
      db,
      `SELECT COUNT(*) AS count FROM void_audit
       WHERE project_id = ? OR session_id IN (SELECT value FROM json_each(?))`,
      projectId,
      sessionIdJson,
    ),
    sessionVerificationUpdates: countRows(
      db,
      "SELECT COUNT(*) AS count FROM session_verification_updates WHERE session_id IN (SELECT value FROM json_each(?))",
      sessionIdJson,
    ),
    sessionLinks: countRows(
      db,
      `SELECT COUNT(*) AS count FROM session_links
       WHERE session_id IN (SELECT value FROM json_each(?))
          OR related_session_id IN (SELECT value FROM json_each(?))`,
      sessionIdJson,
      sessionIdJson,
    ),
    knowledgeCandidateRequests: candidateRequestIds.length,
    knowledgeCandidates: countProjectCandidates(db, projectId, sessionIds, knowledgeIds, candidateRequestIds),
    reportSynthesisRequests: reportRequestIds.length,
    reportSummaries: countProjectReportSummaries(db, projectId, sessionIds, reportRequestIds),
    metadataBackfillRequests: metadataRequestIds.length,
    sessionSummaryUpdates: countRows(
      db,
      "SELECT COUNT(*) AS count FROM session_summary_updates WHERE session_id IN (SELECT value FROM json_each(?))",
      sessionIdJson,
    ),
    sessionWorkSummaryUpdates: countRows(
      db,
      "SELECT COUNT(*) AS count FROM session_work_summary_updates WHERE session_id IN (SELECT value FROM json_each(?))",
      sessionIdJson,
    ),
    searchChunks: 0,
    searchFts: 0,
    searchPaths: 0,
    searchDirty: 0,
  };
}

/** Owns the safety snapshot, comprehensive delete transaction, and content-free audit record. */
export class ProjectDeletionService {
  public constructor(
    private readonly db: DatabaseSync,
    private readonly databasePath: string,
    private readonly backupOptions: BackupRetentionOptions,
    private readonly searchIndex: SearchRepository,
  ) {}

  public listProjectDeletionAudits(): ProjectDeletionAuditRecord[] {
    const rows = this.db
      .prepare(
        `SELECT deleted_at, project_id, deleted_counts_json
         FROM project_deletion_audit
         ORDER BY deleted_at DESC, id DESC`,
      )
      .all() as ProjectDeletionAuditRow[];
    return rows.map((row) => ({
      deletedAt: row.deleted_at,
      projectId: row.project_id,
      deletedCounts: parseProjectDeletionCounts(row.deleted_counts_json),
    }));
  }

  public deleteProject(projectId: string, confirmationName: string): DeleteProjectResult {
    const project = this.findProject(projectId);
    if (!project) {
      throw new ProjectDeletionError("PROJECT_NOT_FOUND");
    }
    if (confirmationName !== project.name) {
      throw new ProjectDeletionError("PROJECT_NAME_MISMATCH");
    }
    if (this.databasePath === ":memory:") {
      throw new ProjectDeletionError("PROJECT_BACKUP_FAILED");
    }

    let backupFileName: string;
    try {
      backupFileName = backupDatabaseBeforeProjectDeletion(this.db, this.databasePath, this.backupOptions).created
        .fileName;
    } catch {
      throw new ProjectDeletionError("PROJECT_BACKUP_FAILED");
    }

    try {
      return runImmediateTransaction(this.db, () => {
        const currentProject = this.findProject(projectId);
        if (!currentProject) {
          throw new ProjectDeletionError("PROJECT_NOT_FOUND");
        }
        if (currentProject.name !== confirmationName) {
          throw new ProjectDeletionError("PROJECT_NAME_MISMATCH");
        }

        const sessionIds = ids(this.db, "SELECT id FROM sessions WHERE project_id = ?", projectId);
        const knowledgeIds = ids(this.db, "SELECT id FROM knowledge WHERE project_id = ?", projectId);
        const candidateRequestIds = projectCandidateRequestIds(this.db, projectId, sessionIds);
        const reportRequestIds = projectReportRequestIds(this.db, projectId, sessionIds);
        const metadataRequestIds = projectMetadataRequestIds(this.db, projectId, sessionIds);
        const counts = makeDeletionCounts(
          this.db,
          projectId,
          sessionIds,
          knowledgeIds,
          candidateRequestIds,
          reportRequestIds,
          metadataRequestIds,
        );

        deleteByIds(
          this.db,
          "knowledge_candidates",
          ids(
            this.db,
            `SELECT id FROM knowledge_candidates
           WHERE project_id = ?
             OR session_id IN (SELECT value FROM json_each(?))
             OR knowledge_id IN (SELECT value FROM json_each(?))
             OR request_id IN (SELECT value FROM json_each(?))`,
            projectId,
            JSON.stringify(sessionIds),
            JSON.stringify(knowledgeIds),
            JSON.stringify(candidateRequestIds),
          ),
        );
        deleteByIds(this.db, "knowledge_candidate_requests", candidateRequestIds);
        deleteByIds(
          this.db,
          "report_summaries",
          ids(
            this.db,
            `SELECT id FROM report_summaries
             WHERE project_id = ?
               OR request_id IN (SELECT value FROM json_each(?))
               OR EXISTS (
                 SELECT 1 FROM json_each(
                   CASE WHEN json_valid(report_summaries.source_session_ids_json)
                     THEN report_summaries.source_session_ids_json ELSE '[]' END
                 ) AS source_session
                 WHERE source_session.value IN (SELECT value FROM json_each(?))
               )`,
            projectId,
            JSON.stringify(reportRequestIds),
            JSON.stringify(sessionIds),
          ),
        );
        deleteByIds(this.db, "report_synthesis_requests", reportRequestIds);
        deleteByIds(this.db, "metadata_backfill_requests", metadataRequestIds);

        this.db
          .prepare(
            `DELETE FROM session_links
           WHERE session_id IN (SELECT value FROM json_each(?))
              OR related_session_id IN (SELECT value FROM json_each(?))`,
          )
          .run(JSON.stringify(sessionIds), JSON.stringify(sessionIds));
        this.db
          .prepare(
            `DELETE FROM void_audit
             WHERE project_id = ? OR session_id IN (SELECT value FROM json_each(?))`,
          )
          .run(projectId, JSON.stringify(sessionIds));
        this.db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);

        const searchCounts = this.searchIndex.deleteProjectDocuments(projectId, sessionIds, knowledgeIds);
        counts.searchChunks = searchCounts.chunks;
        counts.searchFts = searchCounts.fts;
        counts.searchPaths = searchCounts.paths;
        counts.searchDirty = searchCounts.dirty;

        const deletedAt = nowIso();
        this.db
          .prepare(
            `INSERT INTO project_deletion_audit (id, deleted_at, project_id, deleted_counts_json)
             VALUES (?, ?, ?, ?)`,
          )
          .run(randomUUID(), deletedAt, projectId, JSON.stringify(counts));

        return {
          outcome: "project_deleted",
          projectId,
          deletedAt,
          backupFileName,
          deletedCounts: counts,
        };
      });
    } catch (error) {
      if (error instanceof ProjectDeletionError) {
        throw error;
      }
      throw new ProjectDeletionError("PROJECT_DELETE_FAILED");
    }
  }

  private findProject(projectId: string): ProjectRow | undefined {
    return this.db.prepare("SELECT id, name FROM projects WHERE id = ?").get(projectId) as ProjectRow | undefined;
  }
}
