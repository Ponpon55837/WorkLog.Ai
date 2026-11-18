// Content fingerprint of a SQLite database: row count and a sha256 over every row per user table.
// Plain ESM, no dependencies besides node built-ins, so both the fixture generator and tests can import it.
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Buffer } from "node:buffer";

/** Tables never fingerprinted: SQLite internals and the migration ledger (it legitimately grows on upgrade). */
export const EXCLUDED_TABLES = ["schema_migrations"];

/** Suffixes of the shadow tables SQLite creates for an FTS5 virtual table named `<fts>`. */
export const FTS_SHADOW_SUFFIXES = ["_data", "_idx", "_docsize", "_content", "_config"];

function quote(name) {
  return `"${name.replaceAll('"', '""')}"`;
}

/** A deterministic, type-preserving JSON form of one SQLite value (integers are read as bigint). */
function tag(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return `i:${value}`;
  if (typeof value === "number") return `r:${Object.is(value, -0) ? "-0" : value}`;
  if (typeof value === "string") return `s:${value}`;
  if (value instanceof Uint8Array) return `b:${Buffer.from(value).toString("hex")}`;
  throw new TypeError(`Unsupported SQLite value: ${typeof value}`);
}

/**
 * Names of the fingerprinted tables, sorted: every table (virtual FTS tables included) except sqlite_* tables,
 * FTS5 shadow tables (<fts>_data, _idx, _docsize, _content, _config) and EXCLUDED_TABLES.
 */
export function fingerprintTableNames(db, excluded = EXCLUDED_TABLES) {
  const rows = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();
  const ftsNames = rows.filter((row) => /USING\s+fts5/i.test(row.sql ?? "")).map((row) => row.name);
  const shadow = new Set(ftsNames.flatMap((fts) => FTS_SHADOW_SUFFIXES.map((suffix) => `${fts}${suffix}`)));
  return rows.map((row) => row.name).filter((name) => !shadow.has(name) && !excluded.includes(name));
}

/**
 * Opens `databasePath` read-only and returns `{ [table]: { columns, rows, hash } }`.
 * Rows are read in rowid order (primary-key order for WITHOUT ROWID tables).
 * `options.columnsByTable` (Map or object) restricts a table to the given columns, e.g. the ones that existed
 * before an upgrade; tables or columns that are absent are skipped / selected as listed.
 */
export function fingerprintDatabase(databasePath, options = {}) {
  const { columnsByTable, excludedTables = EXCLUDED_TABLES } = options;
  const wanted = columnsByTable instanceof Map ? columnsByTable : new Map(Object.entries(columnsByTable ?? {}));
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const result = {};
    for (const name of fingerprintTableNames(db, excludedTables)) {
      const info = db.prepare(`PRAGMA table_info(${quote(name)})`).all();
      const own = info.map((column) => column.name);
      const columns = wanted.get(name) ?? own;
      const primaryKey = info
        .filter((column) => column.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((column) => column.name);
      const withoutRowid = /WITHOUT\s+ROWID/i.test(
        db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name)?.sql ?? "",
      );
      const order = withoutRowid && primaryKey.length > 0 ? primaryKey.map(quote).join(", ") : "rowid";
      const statement = db.prepare(`SELECT ${columns.map(quote).join(", ")} FROM ${quote(name)} ORDER BY ${order}`);
      statement.setReadBigInts(true);
      const hash = createHash("sha256");
      let rows = 0;
      for (const row of statement.iterate()) {
        hash.update(`${JSON.stringify(columns.map((column) => tag(row[column])))}\n`);
        rows += 1;
      }
      result[name] = { columns, rows, hash: hash.digest("hex") };
    }
    return result;
  } finally {
    db.close();
  }
}
