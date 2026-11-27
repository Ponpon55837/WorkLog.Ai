import { Buffer } from "node:buffer";
import type { Hash } from "node:crypto";
import { closeSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import type {
  ProjectDataImportInput,
  ProjectDataRow,
  ProjectDataTable,
  ProjectDataValue,
} from "@work-intelligence/core";

// Object spread copies the symbol-keyed spill reference with the row, so the planner's copies stay hydratable.
interface SpilledColumns {
  spill: ProjectDataSpill;
  offset: number;
  length: number;
  keys: readonly string[];
}

const SPILL_WRITE_BUFFER_BYTES = 1024 * 1024;

export const SPILLED_COLUMNS: unique symbol = Symbol("spilledColumns");

type SpillableRow = ProjectDataRow & { [SPILLED_COLUMNS]?: SpilledColumns };

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

export function hydrateRow(row: ProjectDataRow): ProjectDataRow {
  const reference = (row as SpillableRow)[SPILLED_COLUMNS];
  if (!reference) return row;
  const heavy = reference.spill.read(reference.offset, reference.length);
  const full: Record<string, ProjectDataValue> = {};
  for (const key of reference.keys) {
    full[key] = Object.hasOwn(row, key) ? (row[key] as ProjectDataValue) : (heavy[key] as ProjectDataValue);
  }
  for (const key of Object.keys(row)) if (!Object.hasOwn(full, key)) full[key] = row[key] as ProjectDataValue;
  return full as ProjectDataRow;
}

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
