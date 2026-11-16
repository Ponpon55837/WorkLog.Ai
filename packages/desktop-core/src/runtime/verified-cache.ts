import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../internal/atomic-file.js";
import { VERIFIED_CACHE_FILE_NAME } from "./layout.js";
import { SHA256_PATTERN } from "./manifest.js";
import type { Fingerprint } from "./scan.js";

/** The content hash a file passed verification with, and the fingerprint it had at that moment. */
export interface CachedFile extends Fingerprint {
  readonly sha256: string;
}

const MAX_CACHE_BYTES = 8 * 1024 * 1024;

const FINGERPRINT_FIELDS = ["size", "mtimeNs", "ctimeNs", "ino", "dev"] as const;
const DECIMAL_PATTERN = /^\d{1,40}$/;

function isCachedFile(value: unknown): value is CachedFile {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.sha256 === "string" &&
    SHA256_PATTERN.test(entry.sha256) &&
    FINGERPRINT_FIELDS.every(
      (field) => typeof entry[field] === "string" && DECIMAL_PATTERN.test(entry[field] as string),
    )
  );
}

/** The cache's files when `raw` is a well-formed cache of `runtimeId`; any deviation yields undefined. */
function cachedFilesOf(raw: unknown, runtimeId: string): Map<string, CachedFile> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const cache = raw as Record<string, unknown>;
  if (cache.cacheVersion !== 1 || cache.runtimeId !== runtimeId) return undefined;
  const files = cache.files;
  if (typeof files !== "object" || files === null || Array.isArray(files)) return undefined;
  const entries = Object.entries(files);
  return entries.every(([, entry]) => isCachedFile(entry)) ? new Map(entries as [string, CachedFile][]) : undefined;
}

/**
 * Reads `.verified.json`. A missing, oversized, unparsable or foreign cache is an empty cache: a bad cache can only
 * cost a full re-verification, never make a file pass. The cache is a speed-up for the owner of the runtime directory,
 * not a security boundary (see verifyRuntime).
 */
export async function readVerifiedCache(runtimeDirectory: string, runtimeId: string): Promise<Map<string, CachedFile>> {
  const cachePath = path.join(runtimeDirectory, VERIFIED_CACHE_FILE_NAME);
  try {
    const stat = await fs.lstat(cachePath);
    if (!stat.isFile() || stat.size > MAX_CACHE_BYTES) return new Map();
    return cachedFilesOf(JSON.parse(await fs.readFile(cachePath, "utf8")), runtimeId) ?? new Map();
  } catch {
    return new Map();
  }
}

/** Writes `.verified.json` atomically; failing to write (read-only directory, another user) only costs speed. */
export async function writeVerifiedCache(
  runtimeDirectory: string,
  runtimeId: string,
  files: ReadonlyMap<string, CachedFile>,
): Promise<void> {
  const content = JSON.stringify({ cacheVersion: 1, runtimeId, files: Object.fromEntries(files) });
  try {
    await writeFileAtomic(path.join(runtimeDirectory, VERIFIED_CACHE_FILE_NAME), content, { mode: 0o644 });
  } catch {
    // Best effort.
  }
}
