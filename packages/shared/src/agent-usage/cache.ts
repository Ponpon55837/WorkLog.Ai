import process from "node:process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord } from "./metrics.js";
import type { ClaudeRecord } from "./types.js";

/** Bump when the record or entry format changes; entries of another version are dropped on load. */
export const CACHE_VERSION = 3;

export interface UsageCacheEntry {
  version: number;
  mtimeMs: number;
  size: number;
  offset: number;
  prefixHash: string;
  evidence: boolean;
  records: ClaudeRecord[];
  skippedLines: number;
  tail: { records: ClaudeRecord[]; skippedLines: number };
}

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

  async save(): Promise<void> {
    if (this.file === undefined || !this.dirty) return;
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const body = JSON.stringify({ version: CACHE_VERSION, entries: Object.fromEntries(this.entries) });
      await writeFile(temporary, body, { mode: 0o600 });
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
    typeof value.evidence === "boolean" &&
    Array.isArray(value.records) &&
    typeof value.skippedLines === "number" &&
    isRecord(value.tail) &&
    Array.isArray(value.tail.records) &&
    typeof value.tail.skippedLines === "number"
  );
}
