import { Buffer } from "node:buffer";
import { closeSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import {
  PROJECT_DATA_TABLES,
  type ProjectDataExportScope,
  type ProjectDataRow,
  type ProjectDataTable,
} from "@work-intelligence/core";
import { nowIso } from "@work-intelligence/shared";
import {
  type ArchitectureDiagramRedactor,
  type ExportRowSource,
  existingRow,
  exportRowSources,
  exportRows,
  ProjectDataTransferError,
  redactRow,
  runReadTransaction,
  SessionRedactionTally,
} from "./project-data-export.js";
import { LATEST_SCHEMA_VERSION } from "./schema-migrations.js";
import type { DatabaseSync } from "node:sqlite";

/**
 * The portable export written to a file row by row, so its memory does not grow with the data. The bytes are those of
 * `JSON.stringify(buildProjectDataExport(readProjectDataRows(...)))`: same rows, order, masking and counts.
 *
 * A Session's redaction_count includes the redactions of its later rows, so the tables after `sessions` are written to
 * a side file first, the Sessions after them, and the side file is then appended.
 */

/** Bytes buffered before a write. */
const WRITE_BUFFER_BYTES = 1024 * 1024;

/** An exclusive (`wx`, 0600) file written through a 1 MiB buffer. */
class ExportFileWriter {
  public bytes = 0;
  private readonly fd: number;
  private readonly buffer = Buffer.allocUnsafe(WRITE_BUFFER_BYTES);
  private buffered = 0;
  private closed = false;

  public constructor(public readonly path: string) {
    this.fd = openSync(path, "wx", 0o600);
  }

  public write(text: string): void {
    const length = Buffer.byteLength(text);
    if (length > this.buffer.byteLength - this.buffered) this.flush();
    if (length > this.buffer.byteLength) {
      this.writeAll(Buffer.from(text, "utf8"), length);
    } else {
      this.buffered += this.buffer.write(text, this.buffered, "utf8");
    }
    this.bytes += length;
  }

  /** Appends a closed writer's file, a buffer at a time. */
  public append(source: ExportFileWriter): void {
    this.flush();
    const fd = openSync(source.path, "r");
    try {
      let read: number;
      while ((read = readSync(fd, this.buffer, 0, this.buffer.byteLength, null)) > 0) this.writeAll(this.buffer, read);
    } finally {
      closeSync(fd);
    }
    this.bytes += source.bytes;
  }

  public close(): void {
    if (this.closed) return;
    try {
      this.flush();
    } finally {
      this.closed = true;
      closeSync(this.fd);
    }
  }

  /** Closes and deletes the file. */
  public discard(): void {
    try {
      if (!this.closed) {
        this.closed = true;
        closeSync(this.fd);
      }
    } finally {
      rmSync(this.path, { force: true });
    }
  }

  private flush(): void {
    this.writeAll(this.buffer, this.buffered);
    this.buffered = 0;
  }

  private writeAll(bytes: Buffer, length: number): void {
    let done = 0;
    while (done < length) done += writeSync(this.fd, bytes, done, length - done);
  }
}

/** The export's JSON around its `tables` object: everything before the `{` that opens it, and after its `}`. */
function exportOutline(scope: ProjectDataExportScope): [string, string] {
  const marker = "\u0000tables\u0000";
  const outline = JSON.stringify({
    format: "work-intelligence-export",
    formatVersion: 1,
    schemaVersion: LATEST_SCHEMA_VERSION,
    exportedAt: nowIso(),
    scope,
    tables: marker,
  });
  const [prefix, suffix] = outline.split(JSON.stringify(marker));
  if (prefix === undefined || suffix === undefined) throw new Error("The export outline could not be built.");
  return [prefix, suffix];
}

function writeTable(
  writer: ExportFileWriter,
  db: DatabaseSync,
  source: ExportRowSource,
  first: boolean,
  emit: (row: ProjectDataRow) => ProjectDataRow,
): void {
  writer.write(`${first ? "" : ","}${JSON.stringify(source.table)}:[`);
  let index = 0;
  for (const row of exportRows(db, source)) {
    writer.write(index === 0 ? JSON.stringify(emit(row)) : `,${JSON.stringify(emit(row))}`);
    index += 1;
  }
  writer.write("]");
}

/**
 * Writes the portable export of `scope` to `target`, which must not exist yet, inside one read snapshot. On failure
 * nothing is left behind.
 */
export function writeProjectDataExport(
  db: DatabaseSync,
  scope: ProjectDataExportScope,
  redactArchitectureDiagram: ArchitectureDiagramRedactor,
  target: string,
): { bytes: number } {
  const output = new ExportFileWriter(target);
  let later: ExportFileWriter | undefined;
  try {
    runReadTransaction(db, () => {
      if (scope.type === "project" && !existingRow(db, "projects", scope.projectId)) {
        throw new ProjectDataTransferError("project_not_found", "找不到要匯出的專案。");
      }
      const sources = exportRowSources(db, scope);
      const tally = new SessionRedactionTally();
      const mask = (table: ProjectDataTable) => (row: ProjectDataRow) => {
        const redacted = redactRow(table, row, redactArchitectureDiagram);
        tally.add(table, row, redacted.row, redacted.redactions);
        return redacted.row;
      };
      const [prefix, suffix] = exportOutline(scope);
      output.write(`${prefix}{`);
      writeTable(output, db, sources.projects, true, mask("projects"));
      later = new ExportFileWriter(`${target}.later`);
      for (const table of PROJECT_DATA_TABLES.slice(2)) writeTable(later, db, sources[table], false, mask(table));
      later.close();
      // Every later row is counted by now; masking a Session adds its own redactions just before it is written.
      const maskSession = mask("sessions");
      writeTable(output, db, sources.sessions, false, (row) => tally.session(maskSession(row)));
      output.append(later);
      output.write(`}${suffix}`);
    });
    output.close();
    return { bytes: output.bytes };
  } catch (error) {
    output.discard();
    throw error;
  } finally {
    (later as ExportFileWriter | undefined)?.discard();
  }
}
