import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DeleteSessionResult, SessionDeletionCounts } from "@work-intelligence/core";
import { nowIso } from "@work-intelligence/shared";
import { backupDatabaseBeforeSessionDeletion, type BackupRetentionOptions } from "./backup.js";
import { isDatabaseBusyError } from "./sqlite-errors.js";
import { runImmediateTransaction } from "./sqlite-transaction.js";
import type { SearchRepository } from "./search-repository.js";

export type SessionDeletionErrorCode =
  | "SESSION_NOT_FOUND"
  | "SESSION_NOT_VOIDED"
  | "SESSION_CITED_BY_PENDING_CLEANUP"
  | "SESSION_BACKUP_FAILED"
  | "SESSION_DELETE_FAILED";

export class SessionDeletionError extends Error {
  public constructor(public readonly code: SessionDeletionErrorCode) {
    super(code);
    this.name = "SessionDeletionError";
  }
}

type SessionStateRow = { id: string; project_id: string; voided_at: string | null };
type CountRow = { count: number };

/** Tables whose rows go with the Session, each counted by its `session_id` column. */
const SESSION_CHILD_TABLES = [
  ["workEvents", "work_events"],
  ["rawSnapshots", "raw_snapshots"],
  ["evidence", "evidence"],
  ["voidAudit", "void_audit"],
  ["sessionDecisions", "session_decisions"],
  ["sessionDiagrams", "session_diagrams"],
  ["sessionSummaryUpdates", "session_summary_updates"],
  ["sessionWorkSummaryUpdates", "session_work_summary_updates"],
  ["sessionVerificationUpdates", "session_verification_updates"],
  ["knowledgeFeedback", "knowledge_feedback"],
] as const satisfies ReadonlyArray<readonly [keyof SessionDeletionCounts, string]>;

function countRows(db: DatabaseSync, sql: string, ...parameters: string[]): number {
  return (db.prepare(sql).get(...parameters) as CountRow).count;
}

function makeDeletionCounts(db: DatabaseSync, sessionId: string): SessionDeletionCounts {
  const counts = {
    sessions: 1,
    sessionLinks: countRows(
      db,
      "SELECT COUNT(*) AS count FROM session_links WHERE session_id = ? OR related_session_id = ?",
      sessionId,
      sessionId,
    ),
    outstandingItems: countRows(
      db,
      "SELECT COUNT(*) AS count FROM outstanding_items WHERE source_session_id = ?",
      sessionId,
    ),
    agentReadRecords: countRows(
      db,
      "SELECT COUNT(*) AS count FROM agent_read_audit_records WHERE record_type = 'session' AND record_id = ?",
      sessionId,
    ),
  } as SessionDeletionCounts;
  for (const [key, table] of SESSION_CHILD_TABLES) {
    // Table names come only from the static list above; the Session id stays a bound value.
    counts[key] = countRows(db, `SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`, sessionId);
  }
  return counts;
}

/**
 * Permanently deletes one voided Session after a checked snapshot. Only the Web UI and REST reach this;
 * Agents can void and restore but never delete. Rows that only cite the Session by id (report and request
 * source lists, Agent read summaries, item events it resolved) keep the id; readers already treat a missing
 * Session like a voided one.
 */
export class SessionDeletionService {
  public constructor(
    private readonly db: DatabaseSync,
    private readonly databasePath: string,
    private readonly backupOptions: BackupRetentionOptions,
    private readonly searchIndex: SearchRepository,
  ) {}

  public deleteSession(sessionId: string): DeleteSessionResult {
    this.assertDeletable(sessionId);
    if (this.databasePath === ":memory:") {
      throw new SessionDeletionError("SESSION_BACKUP_FAILED");
    }

    let backupFileName: string;
    try {
      backupFileName = backupDatabaseBeforeSessionDeletion(this.db, this.databasePath, this.backupOptions).created
        .fileName;
    } catch (error) {
      if (isDatabaseBusyError(error)) {
        throw error;
      }
      throw new SessionDeletionError("SESSION_BACKUP_FAILED");
    }

    let result: DeleteSessionResult;
    try {
      result = runImmediateTransaction(this.db, () => {
        const session = this.assertDeletable(sessionId);
        const counts = makeDeletionCounts(this.db, sessionId);

        this.db
          .prepare("DELETE FROM agent_read_audit_records WHERE record_type = 'session' AND record_id = ?")
          .run(sessionId);
        this.db.prepare("DELETE FROM void_audit WHERE session_id = ?").run(sessionId);
        // Clear references that keep their rows here, not through ON DELETE SET NULL: inside an FK action SQLite
        // drops the search triggers' OR IGNORE, so an already-dirty Knowledge row would abort the delete.
        this.db
          .prepare("UPDATE knowledge SET last_confirmed_session_id = NULL WHERE last_confirmed_session_id = ?")
          .run(sessionId);
        this.db.prepare("UPDATE knowledge SET session_id = NULL WHERE session_id = ?").run(sessionId);
        this.db.prepare("UPDATE knowledge_candidates SET session_id = NULL WHERE session_id = ?").run(sessionId);
        this.db
          .prepare("UPDATE knowledge_pages SET checked_through_session_id = NULL WHERE checked_through_session_id = ?")
          .run(sessionId);
        // Items go first so their append-only events cascade only after the item itself is gone.
        this.db.prepare("DELETE FROM outstanding_items WHERE source_session_id = ?").run(sessionId);
        // Everything else is owned by the Session row and cascades with it.
        this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);

        const deletedAt = nowIso();
        this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(deletedAt, session.project_id);
        this.db
          .prepare(
            `INSERT INTO session_deletion_audit (id, deleted_at, session_id, project_id, deleted_counts_json)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(randomUUID(), deletedAt, sessionId, session.project_id, JSON.stringify(counts));

        return {
          outcome: "session_deleted" as const,
          sessionId,
          projectId: session.project_id,
          deletedAt,
          backupFileName,
          deletedCounts: counts,
        };
      });
    } catch (error) {
      if (error instanceof SessionDeletionError || isDatabaseBusyError(error)) {
        throw error;
      }
      throw new SessionDeletionError("SESSION_DELETE_FAILED");
    }

    // The delete triggers marked the Session dirty; syncing now drops it from search right away.
    this.searchIndex.syncIndex();
    return result;
  }

  /** Re-run inside the transaction: the Session may have been restored or cited since the first check. */
  private assertDeletable(sessionId: string): SessionStateRow {
    const session = this.db.prepare("SELECT id, project_id, voided_at FROM sessions WHERE id = ?").get(sessionId) as
      SessionStateRow | undefined;
    if (!session) {
      throw new SessionDeletionError("SESSION_NOT_FOUND");
    }
    if (!session.voided_at) {
      throw new SessionDeletionError("SESSION_NOT_VOIDED");
    }
    // A pending cleanup proposal for another Session's item would silently lose part of its evidence.
    const cited = this.db
      .prepare(
        `SELECT 1 AS found
         FROM outstanding_cleanup_proposal_evidence e
         JOIN outstanding_cleanup_proposals p ON p.id = e.proposal_id
         JOIN outstanding_cleanup_requests r ON r.id = p.request_id
         JOIN outstanding_cleanup_request_items ri ON ri.id = p.request_item_id
         WHERE e.session_id = ?
           AND p.review_status = 'pending'
           AND r.status <> 'cancelled'
           AND ri.source_session_id <> e.session_id
         LIMIT 1`,
      )
      .get(sessionId);
    if (cited) {
      throw new SessionDeletionError("SESSION_CITED_BY_PENDING_CLEANUP");
    }
    return session;
  }
}
