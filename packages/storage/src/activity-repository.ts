import type { DatabaseSync } from "node:sqlite";
import type { ActivityDay } from "@work-intelligence/core";
import { localDayStartIso, toLocalCalendarDate } from "@work-intelligence/shared";
import { nextCalendarDate } from "./session-repository.js";

export interface ActivityOptions {
  /** Tracked projects in scope. */
  projectIds: readonly string[];
  /** Inclusive calendar dates in the server's time zone. */
  from: string;
  to: string;
}

export class ActivityRepository {
  public constructor(private readonly db: DatabaseSync) {}

  /**
   * Non-voided Sessions completed in the range, counted per local calendar day (the server time zone, the same
   * day boundaries the reports use). SQLite cannot convert to the host zone, so the timestamps of the one query
   * are bucketed in memory. Only days with work are returned, oldest first.
   */
  public dailySessions(options: ActivityOptions): ActivityDay[] {
    const rows = this.db
      .prepare(
        `SELECT completed_at FROM sessions
         WHERE voided_at IS NULL AND project_id IN (SELECT value FROM json_each(?))
           AND completed_at >= ? AND completed_at < ?`,
      )
      .all(
        JSON.stringify(options.projectIds),
        localDayStartIso(options.from) ?? options.from,
        nextCalendarDate(options.to),
      ) as Array<{ completed_at: string }>;
    const counts = new Map<string, number>();
    for (const row of rows) {
      const date = toLocalCalendarDate(row.completed_at);
      counts.set(date, (counts.get(date) ?? 0) + 1);
    }
    return [...counts].map(([date, sessions]) => ({ date, sessions })).sort((a, b) => a.date.localeCompare(b.date));
  }
}
