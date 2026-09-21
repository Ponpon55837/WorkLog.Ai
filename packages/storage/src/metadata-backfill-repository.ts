import { DatabaseSync } from "node:sqlite";
import { runImmediateTransaction } from "./sqlite-transaction.js";

const METADATA_BACKFILL_PROCESSING_TIMEOUT_MS = 30 * 60 * 1000;

/** Owns recovery of metadata-backfill request state before facade operations read it. */
export class MetadataBackfillRepository {
  public constructor(private readonly db: DatabaseSync) {}

  public recoverStale(now = Date.now()): void {
    runImmediateTransaction(this.db, () => {
      const cutoff = now - METADATA_BACKFILL_PROCESSING_TIMEOUT_MS;
      const rows = this.db
        .prepare(
          `SELECT id, started_at
           FROM metadata_backfill_requests r
           WHERE r.status = 'processing'
             AND r.started_at IS NOT NULL
             AND (r.project_id IS NULL OR EXISTS (
               SELECT 1 FROM projects p WHERE p.id = r.project_id AND p.status = 'tracked'
             ))`
        )
        .all() as Array<{ id: string; started_at: string | null }>;
      const staleRows = rows.filter((row) => {
        const startedAt = row.started_at ? Date.parse(row.started_at) : Number.NaN;
        return Number.isFinite(startedAt) && startedAt <= cutoff;
      });

      if (staleRows.length === 0) {
        return;
      }

      const failureReason = "Metadata 回補超過 30 分鐘仍未完成，已標記為可重試；原有 Session 資料未被清除。";
      const update = this.db.prepare(
        `UPDATE metadata_backfill_requests
         SET status = 'failed', failure_reason = ?, completed_at = NULL
         WHERE id = ? AND status = 'processing'
           AND (project_id IS NULL OR EXISTS (
             SELECT 1 FROM projects p WHERE p.id = metadata_backfill_requests.project_id AND p.status = 'tracked'
           ))`
      );
      for (const row of staleRows) {
        update.run(failureReason, row.id);
      }
    });
  }
}
