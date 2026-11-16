import type { DatabaseSync } from "node:sqlite";

export const DATABASE_SCHEMA_CHANGED_CODE = "DATABASE_SCHEMA_CHANGED";

/** The database was migrated by a newer process after this one opened it, so this process must not write. */
export class DatabaseSchemaChangedError extends Error {
  public readonly code = DATABASE_SCHEMA_CHANGED_CODE;

  public constructor() {
    super("資料庫 schema 已更新，請重新啟動 Work Intelligence。");
    this.name = "DatabaseSchemaChangedError";
  }
}

export function isDatabaseSchemaChangedError(error: unknown): error is DatabaseSchemaChangedError {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === DATABASE_SCHEMA_CHANGED_CODE,
  );
}

/**
 * Rejects a write when another process migrated the database past the version this process was built for. It runs
 * inside the write lock, so no migration can land between the check and the write. Once a check passes it is
 * remembered; `data_version` (changes when another connection commits) and `schema_version` (changes on any DDL)
 * tell cheaply that nothing could have changed, so the `schema_migrations` lookup only repeats after foreign commits.
 */
export class SchemaWriteGate {
  private verifiedStamp: string | undefined;
  private verifiedVersion: number | undefined;

  public constructor(
    private readonly db: DatabaseSync,
    public readonly expectedVersion: number,
  ) {}

  /** Must run inside an open write transaction. */
  public assertCompatible(expectedVersion: number = this.expectedVersion): void {
    const stamp = this.readStamp();
    if (stamp === this.verifiedStamp && expectedVersion === this.verifiedVersion) return;
    const row = this.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
      { version?: number | null } | undefined;
    if (row?.version !== expectedVersion) {
      this.verifiedStamp = undefined;
      this.verifiedVersion = undefined;
      throw new DatabaseSchemaChangedError();
    }
    this.verifiedStamp = stamp;
    this.verifiedVersion = expectedVersion;
  }

  private readStamp(): string {
    const row = this.db
      .prepare(
        `SELECT (SELECT data_version FROM pragma_data_version) AS dataVersion,
                (SELECT schema_version FROM pragma_schema_version) AS schemaVersion`,
      )
      .get() as { dataVersion: number; schemaVersion: number };
    return `${row.dataVersion}:${row.schemaVersion}`;
  }
}
