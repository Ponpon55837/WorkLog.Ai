import { normalizePathForCompare } from "@work-intelligence/shared/file-identity";
import type { DatabaseIdentity } from "./types.js";

export type DatabaseIdentityMismatch = "path-replaced" | "file-replaced" | "lineage-changed";

export type DatabaseIdentityComparison = { same: true } | { same: false; reason: DatabaseIdentityMismatch };

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
