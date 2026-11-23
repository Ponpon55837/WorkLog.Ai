import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { endCodexFile, handleCodexLine, linkCodexCompactions } from "./codex.js";
import { reduceClaudeRecords } from "./claude.js";
import { CACHE_VERSION, type UsageCacheEntry } from "./cache.js";
import { checkScanLimits } from "./errors.js";
import { extractFile, type ExtractResult } from "./extract.js";
import { isRecord, mergeMetrics, publicMetrics } from "./metrics.js";
import { createState, type ScanState } from "./state.js";
import type { ShapeReport, UsageCacheCounts, UsageReport, UsageScanOptions } from "./types.js";

const PREFIX_BYTES = 4096;
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;
const SAFE_DISCRIMINATOR = /^[A-Za-z0-9_.:-]{1,128}$/;
const SHAPE_PATH_CAP = 200;
const SHAPE_MAX_DEPTH = 4;

async function expandPaths(paths: string[], options: UsageScanOptions): Promise<string[]> {
  const files: string[] = [];
  async function visit(path: string): Promise<void> {
    checkScanLimits(options.signal, options.deadlineMs);
    const info = await stat(path);
    if (info.isDirectory()) {
      const entries = await readdir(path, { withFileTypes: true });
      entries.sort((a, b) => (a.name < b.name ? -1 : 1));
      for (const entry of entries) await visit(join(path, entry.name));
    } else if (path.endsWith(".jsonl")) {
      files.push(path);
    }
  }
  for (const path of paths) {
    const info = await stat(path);
    if (info.isFile()) files.push(path);
    else await visit(path);
  }
  return files;
}

/** sha256 of the bytes just before `offset` (at most 4 KiB); distinguishes an appended file from a rewritten one. */
async function hashPrefix(path: string, offset: number): Promise<string> {
  const length = Math.min(PREFIX_BYTES, offset);
  const hash = createHash("sha256");
  if (length > 0) {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset - length);
      hash.update(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  }
  return hash.digest("hex");
}

async function prefixUnchanged(path: string, entry: UsageCacheEntry): Promise<boolean> {
  try {
    return (await hashPrefix(path, entry.offset)) === entry.prefixHash;
  } catch {
    return false;
  }
}

function entryFrom(
  extracted: ExtractResult,
  info: { mtimeMs: number; size: number },
  prefixHash: string,
): UsageCacheEntry {
  return {
    version: CACHE_VERSION,
    mtimeMs: info.mtimeMs,
    size: info.size,
    offset: extracted.offset,
    prefixHash,
    records: extracted.records,
    skippedLines: extracted.skippedLines,
    tail: { records: extracted.tail.records, skippedLines: extracted.tail.skippedLines },
  };
}

/** Processes one file: serves it from the cache, reads only its appended bytes, or parses it in full. */
async function scanFile(
  state: ScanState,
  file: string,
  options: UsageScanOptions,
  counts: UsageCacheCounts,
): Promise<void> {
  const info = await stat(file);
  // Lines are appended, so none is newer than the file's mtime: a file last written before `since` has nothing in range.
  if (state.since !== null && info.mtimeMs < state.since) return;
  const { cache, signal, deadlineMs } = options;
  const key = resolve(file);
  state.file = { path: file, codex: null };
  const entry = cache?.get(key);
  let current: UsageCacheEntry | undefined;
  if (entry && entry.mtimeMs === info.mtimeMs && entry.size === info.size) {
    counts.reused += 1;
    current = entry;
  } else if (entry && info.size >= entry.offset && (await prefixUnchanged(file, entry))) {
    const added = await extractFile(file, { start: entry.offset, signal, deadlineMs });
    counts.bytesRead += added.bytesRead;
    if (added.codexLines === 0) {
      counts.appended += 1;
      const records = entry.records;
      for (const record of added.records) records.push(record);
      current = {
        ...entry,
        mtimeMs: info.mtimeMs,
        size: info.size,
        offset: added.offset,
        prefixHash: await hashPrefix(file, added.offset),
        records,
        skippedLines: entry.skippedLines + added.skippedLines,
        tail: { records: added.tail.records, skippedLines: added.tail.skippedLines },
      };
      cache?.set(key, current);
    }
  }
  if (!current) {
    // Codex lines in a file keep it out of the cache: their per-file state depends on other files.
    const full = await extractFile(file, { signal, deadlineMs, onCodexLine: (line) => handleCodexLine(state, line) });
    counts.parsed += 1;
    counts.bytesRead += full.bytesRead;
    state.formats.codexLines += full.codexLines;
    if (full.codexLines === 0) {
      current = entryFrom(full, info, await hashPrefix(file, full.offset));
      cache?.set(key, current);
    } else {
      cache?.delete(key);
      current = entryFrom(full, info, "");
    }
  }
  state.formats.claudeCodeLines += current.records.length + current.tail.records.length;
  state.skippedLines += current.skippedLines + current.tail.skippedLines;
  reduceClaudeRecords(state, current.records);
  reduceClaudeRecords(state, current.tail.records);
  endCodexFile(state);
}

/**
 * Summarizes jsonl session logs (Claude Code incrementally through `options.cache`, Codex rollouts experimental and
 * reparsed on every scan). Sessions carry only a label and a short hash. A file whose mtime precedes `since` is skipped
 * unread, so its lines count in no total (not even `formats` or `skippedLines`).
 */
export async function summarizeFiles(paths: string[], options: UsageScanOptions = {}): Promise<UsageReport> {
  const state = createState(options);
  const counts: UsageCacheCounts = { reused: 0, appended: 0, parsed: 0, bytesRead: 0 };
  for (const file of await expandPaths(paths, options)) {
    checkScanLimits(options.signal, options.deadlineMs);
    await scanFile(state, file, options, counts);
  }
  linkCodexCompactions(state);
  const ordered = [...state.sessions.values()].sort((a, b) =>
    (a.firstTimestamp ?? "") < (b.firstTimestamp ?? "")
      ? -1
      : (a.firstTimestamp ?? "") > (b.firstTimestamp ?? "")
        ? 1
        : 0,
  );
  const sessions = ordered.map((session, index) => {
    const { key, ...rest } = session;
    const metrics = publicMetrics(rest);
    mergeMetrics(state.total, rest);
    const hash = createHash("sha256").update(key).digest("hex").slice(0, 8);
    return { label: `session-${index + 1}`, hash, ...metrics };
  });
  return {
    formats: state.formats,
    sessions,
    total: { sessions: sessions.length, ...publicMetrics(state.total) },
    skippedLines: state.skippedLines,
    codexTokenMismatches: state.codexTokenMismatches,
    codexTokenSourceDisagreements: state.codexTokenSourceDisagreements,
    codexForkedSessions: state.codexForkedSessions,
    codexIgnoredLines: state.codexIgnoredLines,
    codexCompactionLinked: state.codexCompactionLinked,
    codexCompactionCarryovers: state.codexCompactionCarryovers,
    codexContextOutputs: state.codexContextOutputs,
    cache: counts,
  };
}

function shapeKind(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

function walkShape(paths: Map<string, Set<string>>, value: unknown, path: string, depth: number, hops: number): void {
  if (path !== "") {
    let kinds = paths.get(path);
    if (!kinds && paths.size < SHAPE_PATH_CAP) {
      kinds = new Set();
      paths.set(path, kinds);
    }
    kinds?.add(shapeKind(value));
  }
  if (hops > 16) return;
  if (Array.isArray(value)) {
    for (const item of value) walkShape(paths, item, `${path}[]`, depth, hops + 1);
  } else if (isRecord(value) && depth < SHAPE_MAX_DEPTH) {
    for (const key of Object.keys(value)) {
      const safe = SAFE_KEY.test(key) ? key : "(key)";
      walkShape(paths, value[key], path === "" ? safe : `${path}.${safe}`, depth + 1, hops + 1);
    }
  }
}

function shapeDiscriminator(value: unknown): string {
  if (value === undefined) return "-";
  return typeof value === "string" && SAFE_DISCRIMINATOR.test(value) ? value : "(other)";
}

/**
 * Describes the structure of log lines for format debugging: per `type`/`payload.type` pair a count and the key
 * paths (depth 4) with their JS types. Values and JSON embedded in strings are never read or printed.
 */
export async function summarizeShapes(paths: string[]): Promise<ShapeReport> {
  const shapes = new Map<string, { count: number; paths: Map<string, Set<string>> }>();
  let skippedLines = 0;
  for (const file of await expandPaths(paths, {})) {
    const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const text of lines) {
      if (text.trim() === "") continue;
      let line: unknown;
      try {
        line = JSON.parse(text);
      } catch {
        skippedLines += 1;
        continue;
      }
      if (!isRecord(line)) {
        skippedLines += 1;
        continue;
      }
      const key = `${shapeDiscriminator(line.type)}/${isRecord(line.payload) ? shapeDiscriminator(line.payload.type) : "-"}`;
      let entry = shapes.get(key);
      if (!entry) {
        entry = { count: 0, paths: new Map() };
        shapes.set(key, entry);
      }
      entry.count += 1;
      walkShape(entry.paths, line, "", 0, 0);
    }
  }
  return {
    skippedLines,
    shapes: [...shapes.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([key, entry]) => ({
        key,
        count: entry.count,
        paths: [...entry.paths.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([path, kinds]) => ({ path, types: [...kinds].sort() })),
      })),
  };
}
