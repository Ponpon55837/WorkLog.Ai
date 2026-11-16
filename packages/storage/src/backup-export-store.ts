import { DatabaseSync } from "node:sqlite";
import type { DatabaseBackupCreated, ProjectDataExport, ProjectDataExportScope } from "@work-intelligence/core";
import {
  backupDatabase,
  exportDatabase,
  isBackupDue,
  type BackupRetentionOptions,
  type ExportOptions,
} from "./backup.js";
import { assertDatabaseSchemaVersion, configureWorkIntelligenceDatabaseConnection } from "./database-initialization.js";
import { buildProjectDataExport, readProjectDataRows } from "./project-data-export.js";

export interface BackupExportStoreOptions {
  /** Where backups go and how many manual and automatic copies to retain independently. */
  backup?: BackupRetentionOptions;
  /** The database must already have exactly this schema version; the API process owns migrations. */
  expectedSchemaVersion: number;
}

function refuseArchitectureDiagram(): never {
  throw new Error("Architecture diagram masking was not loaded.");
}

/**
 * The read-only snapshot, export and backup operations of `WorkIntelligenceStore` (`mode: "read-only"`), without the
 * rest of it. The backup worker loads this entry instead of the whole store because everything here avoids
 * `@work-intelligence/schema`: that package builds about 140 zod schemas at load time, which cost the worker about
 * 100 ms of cold start. The architecture-diagram masking, the one step that parses with the schema, is imported only
 * when an export actually contains such a diagram. Output is byte-identical to the store's (see
 * `tests/storage/backup-export-store.test.ts`).
 */
export class BackupExportStore {
  private readonly db: DatabaseSync;
  private readonly backupOptions: BackupRetentionOptions;

  public constructor(
    public readonly databasePath: string,
    options: BackupExportStoreOptions,
  ) {
    if (!Number.isSafeInteger(options.expectedSchemaVersion) || options.expectedSchemaVersion < 1) {
      throw new Error("A BackupExportStore requires an expected schema version.");
    }
    if (databasePath === ":memory:") {
      throw new Error("A BackupExportStore requires an existing database file.");
    }
    this.backupOptions = options.backup ?? {};
    this.db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      configureWorkIntelligenceDatabaseConnection(this.db);
      assertDatabaseSchemaVersion(this.db, options.expectedSchemaVersion);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  public close(): void {
    this.db.close();
  }

  /** Writes a checked snapshot of the whole database and prunes old ones. */
  public createBackup(): DatabaseBackupCreated {
    return backupDatabase(this.db, this.databasePath, this.backupOptions);
  }

  /** Writes one automatic backup per local calendar day, independently of manual backups. */
  public backupIfDue(now = new Date()): DatabaseBackupCreated | null {
    if (!isBackupDue(this.databasePath, this.backupOptions.directory, now)) return null;
    return backupDatabase(this.db, this.databasePath, { ...this.backupOptions, kind: "automatic", now });
  }

  /** Writes the whole database to `target`; `target` must not exist yet. */
  public exportTo(target: string, options: ExportOptions = {}): { bytes: number } {
    return exportDatabase(this.db, target, options);
  }

  /** Exports portable data for every project or one selected project. */
  public async exportProjectData(scope: ProjectDataExportScope): Promise<ProjectDataExport> {
    const rows = readProjectDataRows(this.db, scope);
    const hasArchitectureDiagram = rows.session_diagrams.some((row) => row.kind === "architecture");
    const redactArchitectureDiagram = hasArchitectureDiagram
      ? (await import("./diagram-source-redaction.js")).redactArchitectureDiagramSource
      : refuseArchitectureDiagram;
    return buildProjectDataExport(rows, scope, redactArchitectureDiagram);
  }
}
