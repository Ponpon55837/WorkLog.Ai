export const APP_NAME = "Work Intelligence";
export const API_PREFIX = "/api";
export const DEFAULT_WEB_PORT = 5966;

export function nowIso(): string {
  return new Date().toISOString();
}

export function truncateText(value: string, maxLength = 240): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

/*
 * Calendar dates follow the host's local time zone: the server runs on the user's machine, so a
 * "day" in reports and filters is the day the user sees on their clock. Timestamps stay UTC ISO.
 */

/** IANA name of the host time zone, e.g. `Asia/Taipei`. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Local calendar date (YYYY-MM-DD) of a timestamp. */
export function toLocalCalendarDate(value: string | Date = new Date()): string {
  const date = typeof value === "string" ? new Date(value) : value;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** UTC ISO timestamp of local midnight at the start of a YYYY-MM-DD calendar date. */
export function localDayStartIso(date: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    return undefined;
  }
  const [, year, month, day] = match;
  const start = new Date(Number(year), Number(month) - 1, Number(day));
  return Number.isNaN(start.getTime()) ? undefined : start.toISOString();
}
