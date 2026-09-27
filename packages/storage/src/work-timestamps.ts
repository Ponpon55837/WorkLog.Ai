/**
 * Plausibility checks for timestamps an Agent supplies. The schema already rejects future times and stores UTC;
 * these warnings flag values that are allowed but usually mean an estimate or the wrong starting point.
 */
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** A supplied completedAt older than this is only expected when backfilling earlier work. */
export const BACKFILL_WARNING_HOURS = 24;
/** A segment longer than this usually took startedAt from the start of the whole conversation. */
export const LONG_SEGMENT_WARNING_DAYS = 7;

function hours(ms: number): string {
  return (ms / HOUR_MS).toFixed(1);
}

/** Warns when a completedAt the Agent supplied is far behind the server clock. */
export function suppliedCompletedAtWarnings(completedAt: string | undefined, now = Date.now()): string[] {
  if (!completedAt) {
    return [];
  }
  const behind = now - Date.parse(completedAt);
  return behind > BACKFILL_WARNING_HOURS * HOUR_MS
    ? [
        `completedAt ${completedAt} is ${hours(behind)} h before the server time; keep it only if this backfills earlier work from evidence. Omit completedAt for work that just finished.`,
      ]
    : [];
}

/** Warns when the recorded segment spans an implausibly long time. */
export function segmentLengthWarnings(startedAt: string | undefined, completedAt: string): string[] {
  if (!startedAt) {
    return [];
  }
  const span = Date.parse(completedAt) - Date.parse(startedAt);
  return span > LONG_SEGMENT_WARNING_DAYS * DAY_MS
    ? [
        `startedAt ${startedAt} is ${(span / DAY_MS).toFixed(1)} days before completedAt; use the first message of this segment, not of the whole conversation.`,
      ]
    : [];
}

/** The warning for a startedAt that cannot apply because it is after completedAt. */
export function startedAfterCompletedWarning(startedAt: string, completedAt: string): string {
  return `startedAt ${startedAt} is after completedAt ${completedAt} and was not applied.`;
}
