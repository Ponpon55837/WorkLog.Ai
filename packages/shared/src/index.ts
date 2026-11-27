export * from "./backup-name.js";
export { portFailureCode, type PortFailureCode } from "./port-failure.js";
export { commandName, STANDALONE_COMMAND_NAME } from "./command-name.js";

/** 22.13-22.15 and every 23.x ship SQLite without FTS5, so migrations cannot create the search index. */
export const MINIMUM_NODE_VERSION = "22.16.0";
export const SUPPORTED_NODE_RANGE = ">=22.16.0 <23 || >=24.0.0";

export function isSupportedNodeVersion(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major >= 24 || (major === 22 && minor >= 16);
}
export function nowIso(): string {
  return new Date().toISOString();
}

export function truncateText(value: string, maxLength = 240): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

export function truncateAtCodeUnitLimit(value: string, limit: number): { text: string; truncated: boolean } {
  if (value.length <= limit) return { text: value, truncated: false };
  if (limit <= 0) return { text: "", truncated: true };

  let prefixLength = limit - 1;
  const lastPrefixCodeUnit = value.charCodeAt(prefixLength - 1);
  const nextCodeUnit = value.charCodeAt(prefixLength);
  if (
    lastPrefixCodeUnit >= 0xd800 &&
    lastPrefixCodeUnit <= 0xdbff &&
    nextCodeUnit >= 0xdc00 &&
    nextCodeUnit <= 0xdfff
  ) {
    prefixLength -= 1;
  }
  return { text: `${value.slice(0, prefixLength)}…`, truncated: true };
}

/** Calendar dates use the host local time zone (the server runs on the user's machine); timestamps stay UTC ISO. */

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function serverClock(now: Date = new Date()): { serverTime: string; timeZone: string; utcOffset: string } {
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const utcOffset = `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
  return { serverTime: now.toISOString(), timeZone: localTimeZone(), utcOffset };
}

export function toLocalCalendarDate(value: string | Date = new Date()): string {
  const date = typeof value === "string" ? new Date(value) : value;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function localDayStartIso(date: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    return undefined;
  }
  const [, year, month, day] = match;
  const start = new Date(Number(year), Number(month) - 1, Number(day));
  return Number.isNaN(start.getTime()) ? undefined : start.toISOString();
}
