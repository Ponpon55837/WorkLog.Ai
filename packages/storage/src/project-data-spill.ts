import { Buffer } from "node:buffer";
import type { Hash } from "node:crypto";
import { closeSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import type {
  ProjectDataImportInput,
  ProjectDataRow,
  ProjectDataTable,
  ProjectDataValue,
} from "@work-intelligence/core";

/**
 * Long column values of a streamed import live in a spill file instead of the heap. A spilled row keeps its short
 * values (ids, parents, statuses, times: everything the planner decides on) and a reference to the rest; the planner
 * works on these light rows, and the full row is read back only where it is compared with a local copy or written.
 * Object spread copies the symbol-keyed reference with the row, so the copies the planner makes stay hydratable.
 */

interface SpilledColumns {
  spill: ProjectDataSpill;
  offset: number;
  length: number;
  /** The row's column order, shared by every row of the table with the same order. */
  keys: readonly string[];
}

/** Bytes buffered before a write; one write per MiB instead of one per row. */
const SPILL_WRITE_BUFFER_BYTES = 1024 * 1024;

export const SPILLED_COLUMNS: unique symbol = Symbol("spilledColumns");

type SpillableRow = ProjectDataRow & { [SPILLED_COLUMNS]?: SpilledColumns };

/** An append-only file of JSON objects, read back by offset. Created with mode 0600 and removed by `dispose`. */
export class ProjectDataSpill {
  private readonly fd: number;
  private readonly pending: Buffer = Buffer.allocUnsafe(SPILL_WRITE_BUFFER_BYTES);
  private pendingBytes = 0;
  private written = 0;
  private disposed = false;
  private readonly keyOrders = new Map<string, readonly string[]>();

  public constructor(private readonly path: string) {
    this.fd = openSync(path, "wx+", 0o600);
  }

  /** The row with its long values moved to the file, or the row itself when every value stays in memory. */
  public split(
    table: ProjectDataTable,
    row: ProjectDataRow,
    keepInline: (column: string, value: ProjectDataValue) => boolean,
  ): ProjectDataRow {
    const light: Record<string, ProjectDataValue> = {};
    let heavy: Record<string, ProjectDataValue> | undefined;
    const keys = Object.keys(row);
    for (const key of keys) {
      const value = row[key] as ProjectDataValue;
      if (keepInline(key, value)) light[key] = value;
      else (heavy ??= {})[key] = value;
    }
    if (!heavy) return row;
    const text = JSON.stringify(heavy);
    const length = Buffer.byteLength(text);
    const offset = this.append(text, length);
    const orderKey = `${table}\u0000${keys.join("\u0000")}`;
    let order = this.keyOrders.get(orderKey);
    if (!order) {
      order = keys;
      this.keyOrders.set(orderKey, order);
    }
    const reference: SpilledColumns = { spill: this, offset, length, keys: order };
    Object.defineProperty(light, SPILLED_COLUMNS, { value: reference, enumerable: true });
    return light as ProjectDataRow;
  }

  /** Makes every appended row readable. */
  public flush(): void {
    let offset = 0;
    while (offset < this.pendingBytes) {
      offset += writeSync(this.fd, this.pending, offset, this.pendingBytes - offset, this.written + offset);
    }
    this.written += this.pendingBytes;
    this.pendingBytes = 0;
  }

  public read(offset: number, length: number): Record<string, ProjectDataValue> {
    if (offset + length > this.written) this.flush();
    const bytes = Buffer.allocUnsafe(length);
    let done = 0;
    while (done < length) {
      const read = readSync(this.fd, bytes, done, length - done, offset + done);
      if (read === 0) throw new Error("The import spill file ended early.");
      done += read;
    }
    return JSON.parse(bytes.toString("utf8")) as Record<string, ProjectDataValue>;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      closeSync(this.fd);
    } finally {
      rmSync(this.path, { force: true });
    }
  }

  private append(text: string, length: number): number {
    const offset = this.written + this.pendingBytes;
    if (length > this.pending.byteLength - this.pendingBytes) this.flush();
    if (length > this.pending.byteLength) {
      const bytes = Buffer.from(text, "utf8");
      let done = 0;
      while (done < length) done += writeSync(this.fd, bytes, done, length - done, this.written + done);
      this.written += length;
      return offset;
    }
    this.pendingBytes += this.pending.write(text, this.pendingBytes, "utf8");
    return offset;
  }
}

/**
 * The complete row, in its original column order: the light row's values (which the planner may have changed) over
 * the spilled ones. A row that was never split is returned as it is.
 */
export function hydrateRow(row: ProjectDataRow): ProjectDataRow {
  const reference = (row as SpillableRow)[SPILLED_COLUMNS];
  if (!reference) return row;
  const heavy = reference.spill.read(reference.offset, reference.length);
  const full: Record<string, ProjectDataValue> = {};
  for (const key of reference.keys) {
    full[key] = Object.hasOwn(row, key) ? (row[key] as ProjectDataValue) : (heavy[key] as ProjectDataValue);
  }
  // Columns the planner added (none today) come after the original ones, as they would on a plain row.
  for (const key of Object.keys(row)) if (!Object.hasOwn(full, key)) full[key] = row[key] as ProjectDataValue;
  return full as ProjectDataRow;
}

/**
 * Feeds `JSON.stringify(input)` to the hash without building it: the import audit's source digest. Rows are hydrated
 * one at a time, so a streamed import is hashed in bounded memory and to the same digest as the whole-bundle path.
 */
export function hashProjectDataImportInput(hash: Hash, input: ProjectDataImportInput): void {
  const marker = "\u0000tables\u0000";
  const outline = JSON.stringify({ ...input, bundle: { ...input.bundle, tables: marker } });
  const [prefix, suffix] = outline.split(JSON.stringify(marker));
  if (prefix === undefined || suffix === undefined) throw new Error("The import outline could not be hashed.");
  hash.update(prefix);
  hash.update("{");
  let firstTable = true;
  for (const [table, rows] of Object.entries(input.bundle.tables)) {
    hash.update(`${firstTable ? "" : ","}${JSON.stringify(table)}:[`);
    firstTable = false;
    (rows as ProjectDataRow[]).forEach((row, index) => {
      hash.update(index === 0 ? JSON.stringify(hydrateRow(row)) : `,${JSON.stringify(hydrateRow(row))}`);
    });
    hash.update("]");
  }
  hash.update("}");
  hash.update(suffix);
}
