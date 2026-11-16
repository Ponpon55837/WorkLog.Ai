import { normalizePathForCompare } from "@work-intelligence/shared/file-identity";
import type { DatabaseIdentity } from "./types.js";

/** Why two identities are not the same database; the first failing rule wins. */
export type DatabaseIdentityMismatch = "path-replaced" | "file-replaced" | "lineage-changed";

export type DatabaseIdentityComparison = { same: true } | { same: false; reason: DatabaseIdentityMismatch };

/**
 * The ONE rule for "is `actual` still the database that was `expected`" (recovery and the server's revalidation
 * must agree, otherwise one side accepts a swapped file the other rejects):
 * 1. both fileIds known: they must match (else `file-replaced`); otherwise the normalized realPaths must match
 *    (else `path-replaced`; compared case-insensitively on win32);
 * 2. lineage: both non-null must match; expected null -> actual non-null is allowed ONLY when the fileId matches
 *    (the first migration of the same file created schema_migrations); expected non-null -> actual null is a
 *    mismatch (the history vanished) (`lineage-changed`).
 * Pure: it only compares the two records, nothing touches the filesystem.
 */
export function compareDatabaseIdentity(
  expected: DatabaseIdentity,
  actual: DatabaseIdentity,
  platform: NodeJS.Platform = process.platform,
): DatabaseIdentityComparison {
  const fileIdKnown = expected.fileId !== null && actual.fileId !== null;
  const sameFile =
    fileIdKnown && expected.fileId?.device === actual.fileId?.device && expected.fileId?.inode === actual.fileId?.inode;
  if (fileIdKnown && !sameFile) return { same: false, reason: "file-replaced" };
  if (
    !fileIdKnown &&
    normalizePathForCompare(expected.realPath, platform) !== normalizePathForCompare(actual.realPath, platform)
  ) {
    return { same: false, reason: "path-replaced" };
  }
  if (expected.lineageId === null) {
    return actual.lineageId === null || sameFile ? { same: true } : { same: false, reason: "lineage-changed" };
  }
  return expected.lineageId === actual.lineageId ? { same: true } : { same: false, reason: "lineage-changed" };
}
