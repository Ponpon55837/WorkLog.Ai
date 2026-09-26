export const DATABASE_BUSY_MESSAGE = "資料庫暫時忙碌，請稍後再試";

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

type SqliteError = {
  code?: unknown;
  errcode?: unknown;
  errstr?: unknown;
  message?: unknown;
};

/** Identifies SQLite lock contention without relying only on version-sensitive error messages. */
export function isDatabaseBusyError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const sqliteError = error as SqliteError;
  if (typeof sqliteError.errcode === "number") {
    const primaryCode = sqliteError.errcode & 0xff;
    if (primaryCode === SQLITE_BUSY || primaryCode === SQLITE_LOCKED) {
      return true;
    }
  }

  const code = typeof sqliteError.code === "string" ? sqliteError.code : "";
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
    return true;
  }

  return [sqliteError.errstr, sqliteError.message].some(
    (value) =>
      typeof value === "string" &&
      /\b(?:SQLITE_BUSY|SQLITE_LOCKED|database (?:table |schema )?is (?:locked|busy))\b/i.test(value),
  );
}
