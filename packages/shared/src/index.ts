export { commandName, STANDALONE_COMMAND_NAME } from "./command-name.js";

/**
 * The oldest Node.js whose built-in SQLite includes FTS5 (the search index). node:sqlite itself needs no flag from
 * 22.13, but 22.13–22.15 and every 23.x release ship SQLite without FTS5, so the migrations cannot create the index.
 */
export const MINIMUM_NODE_VERSION = "22.16.0";
/** The same requirement as an engines range: 22.16+ on the 22 line, then 24 and later; 23.x has no FTS5. */
export const SUPPORTED_NODE_RANGE = ">=22.16.0 <23 || >=24.0.0";

/** True for a Node.js version inside SUPPORTED_NODE_RANGE; false for anything unparsable. */
export function isSupportedNodeVersion(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major >= 24 || (major === 22 && minor >= 16);
}
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

/** The host clock for Agents, which do not know the current time: UTC now, the IANA zone, and its UTC offset. */
export function serverClock(now: Date = new Date()): { serverTime: string; timeZone: string; utcOffset: string } {
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const utcOffset = `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
  return { serverTime: now.toISOString(), timeZone: localTimeZone(), utcOffset };
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
