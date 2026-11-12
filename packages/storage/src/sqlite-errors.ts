/** Why a database cannot take a write right now; each reason has its own stable code for MCP and REST. */
export type DatabaseUnavailableReason = "busy" | "read_only" | "disk_full";

type SqliteError = {
  code?: unknown;
  errcode?: unknown;
  errstr?: unknown;
  message?: unknown;
  cause?: unknown;
};

type ErrorClassifier = {
  primaryCodes: readonly number[];
  codes: readonly string[];
  text: RegExp;
};

export const DATABASE_BUSY_MESSAGE = "資料庫暫時忙碌，請稍後再試";
export const DATABASE_READ_ONLY_MESSAGE =
  "資料庫目前是唯讀狀態，這次寫入沒有保存；讀取仍可使用。請確認資料庫檔案與所在資料夾可以寫入（未設為唯讀、不在唯讀磁碟上）後再試。";
export const DATABASE_DISK_FULL_MESSAGE =
  "磁碟空間不足，這次寫入沒有保存；已保存的資料沒有變更。請釋放資料庫所在磁碟的空間後再試。";

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_READONLY = 8;
const SQLITE_FULL = 13;
const CLASSIFIERS: ReadonlyArray<readonly [DatabaseUnavailableReason, ErrorClassifier]> = [
  [
    "busy",
    {
      primaryCodes: [SQLITE_BUSY, SQLITE_LOCKED],
      codes: ["SQLITE_BUSY", "SQLITE_LOCKED"],
      text: /\b(?:SQLITE_BUSY|SQLITE_LOCKED|database (?:table |schema )?is (?:locked|busy))\b/i,
    },
  ],
  [
    "read_only",
    {
      primaryCodes: [SQLITE_READONLY],
      // EROFS comes from the file system (for example a backup staging file on a read-only volume), not SQLite.
      codes: ["SQLITE_READONLY", "EROFS"],
      text: /\b(?:SQLITE_READONLY\w*|attempt to write a readonly database)\b/i,
    },
  ],
  [
    "disk_full",
    {
      primaryCodes: [SQLITE_FULL],
      // SQLite reports a write that ran out of space as SQLITE_FULL; file-system writes carry ENOSPC.
      codes: ["SQLITE_FULL", "ENOSPC"],
      text: /\b(?:SQLITE_FULL|database or disk is full|ENOSPC|no space left on device)\b/i,
    },
  ],
];

function matches(candidate: SqliteError, classifier: ErrorClassifier): boolean {
  if (typeof candidate.errcode === "number" && classifier.primaryCodes.includes(candidate.errcode & 0xff)) {
    return true;
  }
  if (typeof candidate.code === "string" && classifier.codes.includes(candidate.code)) {
    return true;
  }
  return [candidate.errstr, candidate.message].some(
    (value) => typeof value === "string" && classifier.text.test(value),
  );
}

/** Tests an error and each of its causes once, so a cyclic cause chain cannot loop. */
function someInErrorChain(error: unknown, classifier: ErrorClassifier): boolean {
  const pending = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    const sqliteError = candidate as SqliteError;
    if (matches(sqliteError, classifier)) {
      return true;
    }
    if (sqliteError.cause !== undefined) pending.push(sqliteError.cause);
  }
  return false;
}

/**
 * Classifies a failure that left the stored data unchanged and that the user can resolve (wait, make the file
 * writable, free space). SQLite result codes are checked first; version-sensitive messages are only a fallback.
 * Busy wins over the others because waiting alone recovers from it.
 */
export function databaseUnavailableReason(error: unknown): DatabaseUnavailableReason | undefined {
  return CLASSIFIERS.find(([, classifier]) => someInErrorChain(error, classifier))?.[0];
}

/** Identifies SQLite lock contention without relying only on version-sensitive error messages. */
export function isDatabaseBusyError(error: unknown): boolean {
  return databaseUnavailableReason(error) === "busy";
}

/** The curated user-facing text for each reason; never the SQLite message itself. */
export function databaseUnavailableMessage(reason: DatabaseUnavailableReason): string {
  switch (reason) {
    case "busy":
      return DATABASE_BUSY_MESSAGE;
    case "read_only":
      return DATABASE_READ_ONLY_MESSAGE;
    case "disk_full":
      return DATABASE_DISK_FULL_MESSAGE;
  }
}
