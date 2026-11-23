import process from "node:process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord } from "./metrics.js";
import type { ClaudeRecord } from "./types.js";

/** Bump when the record or entry format changes; entries of another version are dropped on load. */
export const CACHE_VERSION = 1;

/** What one Claude Code file contributed, valid while its size and mtime are unchanged. */
export interface UsageCacheEntry {
  version: number;
  mtimeMs: number;
  size: number;
  /** Bytes up to and including the last newline that were read. */
  offset: number;
  /** sha256 of the (up to 4 KiB) bytes just before `offset`, to tell an append from a rewrite. */
  prefixHash: string;
  records: ClaudeRecord[];
  skippedLines: number;
  /** The unterminated last line, replaced when the file grows. */
  tail: { records: ClaudeRecord[]; skippedLines: number };
}

/**
 * Per-file extraction results keyed by absolute path, kept in memory and optionally persisted as JSON. Persistence is
 * best effort: a missing, corrupt or foreign-version file is ignored and a failed write is swallowed.
 */
export class UsageCache {
  private readonly entries = new Map<string, UsageCacheEntry>();
  private readonly file: string | undefined;
  private dirty = false;

  constructor(options: { file?: string } = {}) {
    this.file = options.file;
  }

  get size(): number {
    return this.entries.size;
  }

  get(path: string): UsageCacheEntry | undefined {
    return this.entries.get(path);
  }

  set(path: string, entry: UsageCacheEntry): void {
    this.entries.set(path, entry);
    this.dirty = true;
  }

  delete(path: string): void {
    if (this.entries.delete(path)) this.dirty = true;
  }

  /** Reads the cache file when one was configured; any problem leaves the cache empty. */
  async load(): Promise<void> {
    if (this.file === undefined) return;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, "utf8"));
      if (!isRecord(parsed) || parsed.version !== CACHE_VERSION || !isRecord(parsed.entries)) return;
      for (const [path, entry] of Object.entries(parsed.entries)) {
        if (isEntry(entry)) this.entries.set(path, entry);
      }
      this.dirty = false;
    } catch {
      this.entries.clear();
    }
  }

  /** Writes the cache atomically with owner-only permissions; does nothing when nothing changed. */
  async save(): Promise<void> {
    if (this.file === undefined || !this.dirty) return;
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const body = JSON.stringify({ version: CACHE_VERSION, entries: Object.fromEntries(this.entries) });
      await writeFile(temporary, body, { mode: 0o600 });
      await chmod(temporary, 0o600).catch(() => undefined);
      await rename(temporary, this.file);
      this.dirty = false;
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

function isEntry(value: unknown): value is UsageCacheEntry {
  return (
    isRecord(value) &&
    value.version === CACHE_VERSION &&
    typeof value.mtimeMs === "number" &&
    typeof value.size === "number" &&
    typeof value.offset === "number" &&
    typeof value.prefixHash === "string" &&
    Array.isArray(value.records) &&
    typeof value.skippedLines === "number" &&
    isRecord(value.tail) &&
    Array.isArray(value.tail.records) &&
    typeof value.tail.skippedLines === "number"
  );
}
