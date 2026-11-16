import { describe, expect, it } from "vitest";
import {
  backupPrefix,
  isSafeDatabaseBackupFileName,
  parseBackupName,
  parseDatabaseBackupFileName,
} from "../../packages/shared/src/backup-name.js";

describe("parseBackupName", () => {
  it.each([
    ["automatic-20260101T000000Z", "automatic", "2026-01-01T00:00:00Z", 1],
    ["manual-20260301T120000Z-2", "manual", "2026-03-01T12:00:00Z", 2],
    ["pre-migration-v33-20260301T120000Z", "migration", "2026-03-01T12:00:00Z", 1],
    ["pre-maintenance-20260301T120000Z", "maintenance", "2026-03-01T12:00:00Z", 1],
    ["pre-delete-20260301T120000Z", "deletion", "2026-03-01T12:00:00Z", 1],
    ["pre-session-delete-20260301T120000Z", "session_deletion", "2026-03-01T12:00:00Z", 1],
    ["pre-import-20260301T120000Z", "import", "2026-03-01T12:00:00Z", 1],
    ["20260301T120000Z", "manual", "2026-03-01T12:00:00Z", 1],
  ])("reads %s", (value, kind, createdAt, sequence) => {
    expect(parseBackupName(value)).toEqual({ kind, createdAt, sequence });
  });

  it.each([
    "automatic-20261301T000000Z",
    "automatic-20260230T000000Z",
    "automatic-20260101T000000Z-1",
    "automatic-20260101T000000Z-0",
    "automatic-20260101T000000Z-x",
    "pre-migration-v0-20260101T000000Z",
    "pre-migration-v99999999999999999999-20260101T000000Z",
    "experimental-20260101T000000Z",
    "pre-future-20260101T000000Z",
    "Automatic-20260101T000000Z",
    "automatic-",
    "garbage",
    "",
  ])("refuses %s", (value) => {
    expect(parseBackupName(value)).toBeNull();
  });
});

describe("database backup file names", () => {
  const db = "/synthetic/data/work.sqlite";

  it("is named after the database file", () => {
    expect(backupPrefix(db)).toBe("work-");
  });

  it("accepts only a plain name of this database", () => {
    expect(parseDatabaseBackupFileName(db, "work-automatic-20260101T000000Z.sqlite")).toMatchObject({
      kind: "automatic",
    });
    expect(isSafeDatabaseBackupFileName(db, "work-manual-20260101T000000Z.sqlite")).toBe(true);
    for (const bad of [
      "other-automatic-20260101T000000Z.sqlite",
      "work-automatic-20260101T000000Z.sqlite.bak",
      "work-automatic-20260101T000000Z.db",
      "work-experimental-20260101T000000Z.sqlite",
      "../work-automatic-20260101T000000Z.sqlite",
      "sub/work-automatic-20260101T000000Z.sqlite",
      "sub\\work-automatic-20260101T000000Z.sqlite",
      "work-automatic-20260101T000000Z.sqlite\n",
      "work-automatic-20260101T000000Z\u0000.sqlite",
      "",
    ]) {
      expect(parseDatabaseBackupFileName(db, bad)).toBeNull();
    }
  });
});
