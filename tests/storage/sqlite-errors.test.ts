import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  DATABASE_BUSY_MESSAGE,
  DATABASE_DISK_FULL_MESSAGE,
  DATABASE_READ_ONLY_MESSAGE,
  databaseUnavailableMessage,
  databaseUnavailableReason,
  isDatabaseBusyError,
} from "../../packages/storage/src/index.js";

// Constructed errors stand in for conditions a test cannot cause on every platform (a full disk above all).
const SQLITE_IOERR_WRITE = 10 | (3 << 8);
const SQLITE_READONLY_DBMOVED = 8 | (4 << 8);
const SQLITE_BUSY_SNAPSHOT = 5 | (2 << 8);

function sqliteError(errcode: number, errstr: string): Error {
  return Object.assign(new Error(errstr), { code: "ERR_SQLITE_ERROR", errcode, errstr });
}

describe("database unavailable classification", () => {
  it("classifies primary and extended SQLite result codes", () => {
    expect(databaseUnavailableReason(sqliteError(5, "database is locked"))).toBe("busy");
    expect(databaseUnavailableReason(sqliteError(6, "database table is locked"))).toBe("busy");
    expect(databaseUnavailableReason(sqliteError(SQLITE_BUSY_SNAPSHOT, "unrelated text"))).toBe("busy");
    expect(databaseUnavailableReason(sqliteError(8, "attempt to write a readonly database"))).toBe("read_only");
    expect(databaseUnavailableReason(sqliteError(SQLITE_READONLY_DBMOVED, "unrelated text"))).toBe("read_only");
    expect(databaseUnavailableReason(sqliteError(13, "database or disk is full"))).toBe("disk_full");
  });

  it("classifies string codes from SQLite bindings and the file system", () => {
    expect(databaseUnavailableReason({ code: "SQLITE_BUSY" })).toBe("busy");
    expect(databaseUnavailableReason({ code: "SQLITE_LOCKED" })).toBe("busy");
    expect(databaseUnavailableReason({ code: "SQLITE_READONLY" })).toBe("read_only");
    expect(databaseUnavailableReason(Object.assign(new Error("write failed"), { code: "EROFS" }))).toBe("read_only");
    expect(databaseUnavailableReason({ code: "SQLITE_FULL" })).toBe("disk_full");
    expect(databaseUnavailableReason(Object.assign(new Error("write failed"), { code: "ENOSPC" }))).toBe("disk_full");
  });

  it("falls back to the message text when no code is present", () => {
    expect(databaseUnavailableReason(new Error("SQLITE_BUSY: database is busy"))).toBe("busy");
    expect(databaseUnavailableReason({ errstr: "database schema is locked" })).toBe("busy");
    expect(databaseUnavailableReason(new Error("SQLITE_READONLY_DIRECTORY"))).toBe("read_only");
    expect(databaseUnavailableReason(new Error("attempt to write a readonly database"))).toBe("read_only");
    expect(databaseUnavailableReason(new Error("database or disk is full"))).toBe("disk_full");
    expect(databaseUnavailableReason(new Error("no space left on device, write"))).toBe("disk_full");
  });

  it("finds the reason in a cause chain and stops on a cyclic chain", () => {
    const wrapped = new Error("project deletion failed", { cause: sqliteError(13, "database or disk is full") });
    expect(databaseUnavailableReason(new Error("outer", { cause: wrapped }))).toBe("disk_full");

    const cyclic: { message: string; cause?: unknown } = { message: "outer" };
    cyclic.cause = { message: "inner", cause: cyclic };
    expect(databaseUnavailableReason(cyclic)).toBeUndefined();
  });

  it("prefers busy when a chain carries more than one reason", () => {
    const error = new Error("attempt to write a readonly database", { cause: sqliteError(5, "database is locked") });
    expect(databaseUnavailableReason(error)).toBe("busy");
    expect(isDatabaseBusyError(error)).toBe(true);
  });

  it("leaves other failures unclassified, including a bare I/O error", () => {
    for (const error of [
      undefined,
      null,
      "database is locked",
      42,
      new Error("UNIQUE constraint failed"),
      sqliteError(SQLITE_IOERR_WRITE, "disk I/O error"),
      sqliteError(26, "file is not a database"),
      Object.assign(new Error("permission denied"), { code: "EACCES" }),
      { errcode: "5", code: 5, message: 7 },
    ]) {
      expect(databaseUnavailableReason(error)).toBeUndefined();
      expect(isDatabaseBusyError(error)).toBe(false);
    }
  });

  it("classifies the error node:sqlite raises for a write on a query-only connection", () => {
    const writer = new DatabaseSync(":memory:");
    writer.exec("CREATE TABLE notes (body TEXT)");
    writer.exec("PRAGMA query_only = ON");
    let readOnlyError: unknown;
    try {
      writer.exec("INSERT INTO notes VALUES ('fiction')");
    } catch (error) {
      readOnlyError = error;
    } finally {
      writer.close();
    }
    expect(databaseUnavailableReason(readOnlyError)).toBe("read_only");
  });

  it("gives curated text for each reason, never SQLite wording", () => {
    expect(databaseUnavailableMessage("busy")).toBe(DATABASE_BUSY_MESSAGE);
    expect(databaseUnavailableMessage("read_only")).toBe(DATABASE_READ_ONLY_MESSAGE);
    expect(databaseUnavailableMessage("disk_full")).toBe(DATABASE_DISK_FULL_MESSAGE);
    for (const message of [DATABASE_BUSY_MESSAGE, DATABASE_READ_ONLY_MESSAGE, DATABASE_DISK_FULL_MESSAGE]) {
      expect(message).not.toMatch(/sqlite|readonly database|disk is full/i);
    }
  });
});
