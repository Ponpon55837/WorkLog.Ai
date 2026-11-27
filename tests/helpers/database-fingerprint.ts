import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export interface TableFingerprint {
  rows: number;
  hash: string;
}

export type DatabaseFingerprint = Record<string, TableFingerprint>;

export interface FingerprintOptions {
  excludeTables?: readonly string[];
  ignoreColumns?: Readonly<Record<string, readonly string[]>>;
}

export function fingerprintConnection(db: DatabaseSync, options: FingerprintOptions = {}): DatabaseFingerprint {
  const tables = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string; sql: string | null }>;
  const virtualTables = tables.filter((table) => /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(table.sql ?? ""));
  const isShadow = (name: string): boolean => virtualTables.some((table) => name.startsWith(`${table.name}_`));
  const result: DatabaseFingerprint = {};
  for (const { name } of tables) {
    if (isShadow(name) || options.excludeTables?.includes(name)) continue;
    const ignored = options.ignoreColumns?.[name] ?? [];
    const columns = (db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>)
      .map((column) => column.name)
      .filter((column) => !ignored.includes(column));
    const list = columns.map((column) => `"${column}"`).join(", ");
    const rows = db.prepare(`SELECT ${list} FROM "${name}" ORDER BY ${list}`).all() as Array<Record<string, unknown>>;
    const hash = createHash("sha256");
    for (const row of rows) hash.update(`${JSON.stringify(columns.map((column) => String(row[column])))}\n`);
    result[name] = { rows: rows.length, hash: hash.digest("hex") };
  }
  return result;
}

/** Fingerprint of a database file, read through a fresh read-only connection (WAL content included). */
export function fingerprintDatabase(databasePath: string, options: FingerprintOptions = {}): DatabaseFingerprint {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return fingerprintConnection(db, options);
  } finally {
    db.close();
  }
}

/** sha256 of the main database file's bytes (not its WAL): for "this file was not touched" assertions. */
export function fileDigest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
