import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../internal/atomic-file.js";
import { VERIFIED_CACHE_FILE_NAME } from "./layout.js";
import { SHA256_PATTERN } from "./manifest.js";
import type { Fingerprint } from "./scan.js";

export interface CachedFile extends Fingerprint {
  readonly sha256: string;
}

export interface AclStampEntry {
  readonly ctimeNs: string;
  readonly ino: string;
}

export type AclStamp = Readonly<Record<string, AclStampEntry>>;

export interface VerifiedCache {
  readonly files: Map<string, CachedFile>;
  readonly acl: AclStamp | undefined;
}

const MAX_CACHE_BYTES = 8 * 1024 * 1024;

const emptyCache = (): VerifiedCache => ({ files: new Map(), acl: undefined });
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

function aclStampOf(raw: unknown): AclStamp | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw);
  const wellFormed = entries.every(([, entry]) => {
    if (typeof entry !== "object" || entry === null) return false;
    const value = entry as Record<string, unknown>;
    return (
      typeof value.ctimeNs === "string" &&
      DECIMAL_PATTERN.test(value.ctimeNs) &&
      typeof value.ino === "string" &&
      DECIMAL_PATTERN.test(value.ino)
    );
  });
  return wellFormed ? (raw as AclStamp) : undefined;
}

function cachedFilesOf(raw: unknown, runtimeId: string): VerifiedCache | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const cache = raw as Record<string, unknown>;
  if (cache.cacheVersion !== 1 || cache.runtimeId !== runtimeId) return undefined;
  const files = cache.files;
  if (typeof files !== "object" || files === null || Array.isArray(files)) return undefined;
  const entries = Object.entries(files);
  if (!entries.every(([, entry]) => isCachedFile(entry))) return undefined;
  return { files: new Map(entries as [string, CachedFile][]), acl: aclStampOf(cache.acl) };
}

/** A bad cache can only cost a full re-verification, never make a file pass; it is a speed-up, not a security boundary. */
export async function readVerifiedCache(runtimeDirectory: string, runtimeId: string): Promise<VerifiedCache> {
  const cachePath = path.join(runtimeDirectory, VERIFIED_CACHE_FILE_NAME);
  try {
    const stat = await fs.lstat(cachePath);
    if (!stat.isFile() || stat.size > MAX_CACHE_BYTES) return emptyCache();
    return cachedFilesOf(JSON.parse(await fs.readFile(cachePath, "utf8")), runtimeId) ?? emptyCache();
  } catch {
    return emptyCache();
  }
}

export async function writeVerifiedCache(
  runtimeDirectory: string,
  runtimeId: string,
  files: ReadonlyMap<string, CachedFile>,
  acl?: AclStamp,
): Promise<void> {
  const content = JSON.stringify({
    cacheVersion: 1,
    runtimeId,
    files: Object.fromEntries(files),
    ...(acl ? { acl } : {}),
  });
  try {
    await writeFileAtomic(path.join(runtimeDirectory, VERIFIED_CACHE_FILE_NAME), content, { mode: 0o644 });
  } catch {
    // Best effort.
  }
}
