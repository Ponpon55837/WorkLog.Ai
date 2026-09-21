import { DatabaseSync } from "node:sqlite";
import { runImmediateTransaction } from "./sqlite-transaction.js";

const REPORT_SYNTHESIS_PROCESSING_TIMEOUT_MS = 30 * 60 * 1000;

/** Owns recovery of report-synthesis request state before facade operations read it. */
export class ReportSynthesisRequestRepository {
  public constructor(private readonly db: DatabaseSync) {}

  public recoverStale(now = Date.now()): void {
    runImmediateTransaction(this.db, () => {
      const cutoff = now - REPORT_SYNTHESIS_PROCESSING_TIMEOUT_MS;
      const rows = this.db
        .prepare(
          `SELECT id, started_at
           FROM report_synthesis_requests
           WHERE status = 'processing' AND started_at IS NOT NULL`
        )
        .all() as Array<{ id: string; started_at: string | null }>;
      const staleRows = rows.filter((row) => {
        const startedAt = row.started_at ? Date.parse(row.started_at) : Number.NaN;
        return Number.isFinite(startedAt) && startedAt <= cutoff;
      });

      if (staleRows.length === 0) {
        return;
      }

      const failureReason = "報告提煉超過 30 分鐘仍未完成，已標記為可重試；原始報告與既有摘要未受影響。";
      const update = this.db.prepare(
        `UPDATE report_synthesis_requests
         SET status = 'failed', failure_reason = ?, completed_at = NULL
         WHERE id = ? AND status = 'processing'`
      );
      for (const row of staleRows) {
        update.run(failureReason, row.id);
      }
    });
  }
}
