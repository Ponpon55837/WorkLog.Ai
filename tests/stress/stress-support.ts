import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const WRITER_COUNT = 4;
export const CHECKPOINT_MODES = ["PASSIVE", "FULL", "RESTART", "TRUNCATE"] as const;
export type CheckpointMode = (typeof CHECKPOINT_MODES)[number];

export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function mixSeed(...parts: number[]): number {
  let hash = 2_166_136_261;
  for (const part of parts) {
    hash = Math.imul(hash ^ (part >>> 0), 16_777_619) >>> 0;
    hash = Math.imul(hash ^ (hash >>> 13), 0x5bd1e995) >>> 0;
  }
  return hash >>> 0;
}

export function idempotencyKey(writer: number, seq: number): string {
  return `stress-w${writer}-s${seq}`;
}

export function expectedEventCount(writer: number, seq: number): number {
  return 2 + ((writer + seq) % 4);
}

export function eventSummary(writer: number, seq: number, index: number): string {
  return `stress w${writer} s${seq} e${index}`;
}

export function paddingFor(seed: number, writer: number, seq: number): string {
  const random = createRandom(mixSeed(seed, writer, seq));
  return "lorem ipsum dolor ".repeat(Math.floor(random() * 80));
}

export function parseKey(key: string): { writer: number; seq: number } | undefined {
  const match = /^stress-w(\d+)-s(\d+)$/.exec(key);
  return match ? { writer: Number(match[1]), seq: Number(match[2]) } : undefined;
}

export interface SessionRows {
  bySeq: Map<number, number>[];
  foreign: number;
}

export function readStressRows(db: DatabaseSync): SessionRows {
  const bySeq = Array.from({ length: WRITER_COUNT }, () => new Map<number, number>());
  let foreign = 0;
  const rows = db
    .prepare(
      `SELECT s.idempotency_key AS key,
              (SELECT COUNT(*) FROM work_events e WHERE e.session_id = s.id AND e.summary LIKE 'stress w%') AS events
         FROM sessions s`,
    )
    .all() as Array<{ key: string; events: number }>;
  for (const row of rows) {
    const parsed = parseKey(row.key);
    const target = parsed ? bySeq[parsed.writer] : undefined;
    if (!parsed || !target) foreign += 1;
    else if (target.has(parsed.seq)) throw new Error(`Duplicate session row for ${row.key}.`);
    else target.set(parsed.seq, Number(row.events));
  }
  return { bySeq, foreign };
}

export interface TableFingerprint {
  rows: number;
  sha256: string;
}

// change_revisions holds database_id and the revisions, which restoreDatabase rewrites on purpose so caches keyed on them are invalidated.
export const RESTORE_EXCLUDED_TABLES = ["change_revisions"] as const;

function fingerprintTables(db: DatabaseSync, excluded: readonly string[]): string[] {
  const all = (
    db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
      name: string;
      sql: string | null;
    }>
  ).filter((table) => !table.name.startsWith("sqlite_"));
  const virtual = all
    .filter((table) => /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(table.sql ?? ""))
    .map((table) => table.name);
  const shadow = (name: string): boolean => virtual.some((fts) => name.startsWith(`${fts}_`));
  return all
    .map((table) => table.name)
    .filter((name) => !virtual.includes(name) && !shadow(name) && !excluded.includes(name));
}

function canonical(value: unknown): unknown {
  if (typeof value === "bigint") return `bigint:${value}`;
  if (value instanceof Uint8Array) return `blob:${Buffer.from(value).toString("hex")}`;
  return value;
}

export function fingerprintDatabase(
  db: DatabaseSync,
  excluded: readonly string[] = RESTORE_EXCLUDED_TABLES,
): Record<string, TableFingerprint> {
  const result: Record<string, TableFingerprint> = {};
  for (const table of fingerprintTables(db, excluded)) {
    const lines = (db.prepare(`SELECT * FROM "${table}"`).all() as Array<Record<string, unknown>>)
      .map((row) => JSON.stringify(Object.entries(row).map(([column, value]) => [column, canonical(value)])))
      .sort();
    const hash = createHash("sha256");
    for (const line of lines) hash.update(line).update("\n");
    result[table] = { rows: lines.length, sha256: hash.digest("hex") };
  }
  return result;
}

export function describeError(error: unknown): string {
  const value = error as { code?: string; errcode?: number; message?: string };
  return `${value.code ?? "Error"}${typeof value.errcode === "number" ? `#${value.errcode}` : ""}: ${(value.message ?? String(error)).slice(0, 200)}`;
}
