import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { backupOptionsFromEnvironment } from "../../packages/storage/src/backup-environment.js";
import { DEFAULT_BACKUP_KEEP } from "../../packages/storage/src/backup.js";

const databasePath = resolve("fixture-data", "work-intelligence.sqlite");

describe("backupOptionsFromEnvironment", () => {
  it("uses the default location and retention when nothing is set", () => {
    expect(backupOptionsFromEnvironment(databasePath, {})).toEqual({ keep: DEFAULT_BACKUP_KEEP });
  });

  it("resolves a relative backup directory beside the database, not the working directory", () => {
    const options = backupOptionsFromEnvironment(databasePath, { WORK_INTELLIGENCE_BACKUP_DIR: "snapshots" });
    expect(options.directory).toBe(join(resolve("fixture-data"), "snapshots"));
  });

  it("keeps an absolute backup directory and a valid retention count", () => {
    const directory = resolve("elsewhere", "backups");
    expect(
      backupOptionsFromEnvironment(databasePath, {
        WORK_INTELLIGENCE_BACKUP_DIR: ` ${directory} `,
        WORK_INTELLIGENCE_BACKUP_KEEP: "5",
      }),
    ).toEqual({ directory, keep: 5 });
  });

  it("falls back to the default retention for invalid counts and ignores a blank directory", () => {
    for (const keep of ["0", "-3", "2.5", "many"]) {
      expect(
        backupOptionsFromEnvironment(databasePath, {
          WORK_INTELLIGENCE_BACKUP_DIR: "  ",
          WORK_INTELLIGENCE_BACKUP_KEEP: keep,
        }),
      ).toEqual({ keep: DEFAULT_BACKUP_KEEP });
    }
  });
});
