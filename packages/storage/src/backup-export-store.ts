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
import { writeProjectDataExport } from "./project-data-export-stream.js";

/** An export reads each row once; the default 16 MB cache left about 30 MiB more resident after the worker exited. */
const EXPORT_CACHE_SIZE_KIB = 1_000;

export interface BackupExportStoreOptions {
  backup?: BackupRetentionOptions;
  /** The API process owns migrations; this store only checks the version. */
  expectedSchemaVersion: number;
}

function refuseArchitectureDiagram(): never {
  throw new Error("Architecture diagram masking was not loaded.");
}

/**
 * The backup worker loads this instead of the whole store: nothing here may import `@work-intelligence/schema` (zod
 * cost the worker about 100 ms of cold start). Output is byte-identical to the store's (backup-export-store.test.ts).
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
      configureWorkIntelligenceDatabaseConnection(this.db, EXPORT_CACHE_SIZE_KIB);
      assertDatabaseSchemaVersion(this.db, options.expectedSchemaVersion);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  public close(): void {
    this.db.close();
  }

  public createBackup(): DatabaseBackupCreated {
    return backupDatabase(this.db, this.databasePath, this.backupOptions);
  }

  public backupIfDue(now = new Date()): DatabaseBackupCreated | null {
    if (!isBackupDue(this.databasePath, this.backupOptions.directory, now)) return null;
    return backupDatabase(this.db, this.databasePath, { ...this.backupOptions, kind: "automatic", now });
  }

  public exportTo(target: string, options: ExportOptions = {}): { bytes: number } {
    return exportDatabase(this.db, target, options);
  }

  public async exportProjectData(scope: ProjectDataExportScope): Promise<ProjectDataExport> {
    const rows = readProjectDataRows(this.db, scope);
    const hasArchitectureDiagram = rows.session_diagrams.some((row) => row.kind === "architecture");
    const redactArchitectureDiagram = hasArchitectureDiagram
      ? (await import("./diagram-source-redaction.js")).redactArchitectureDiagramSource
      : refuseArchitectureDiagram;
    return buildProjectDataExport(rows, scope, redactArchitectureDiagram);
  }

  /** Same bytes as `JSON.stringify(await exportProjectData(scope))`; zod masking is imported only when a diagram exists. */
  public async writeProjectData(
    scope: ProjectDataExportScope,
    target: string,
    maxBytes?: number,
  ): Promise<{ bytes: number }> {
    const hasArchitectureDiagram =
      this.db.prepare("SELECT 1 FROM session_diagrams WHERE kind = 'architecture' LIMIT 1").get() !== undefined;
    const redactArchitectureDiagram = hasArchitectureDiagram
      ? (await import("./diagram-source-redaction.js")).redactArchitectureDiagramSource
      : refuseArchitectureDiagram;
    return writeProjectDataExport(this.db, scope, redactArchitectureDiagram, target, maxBytes);
  }
}
