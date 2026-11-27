import { lstat, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { canonicalDatabasePath } from "../shell/setup-state.js";
import type { CopySettlement } from "./startup-recovery.js";

const COPY_FILE_NAME = /^work-intelligence-local(?:-\d+)?\.sqlite$/;
const SIDE_FILES = ["-wal", "-shm", "-journal"] as const;

export interface SettleOrphanCopyInput {
  readonly copyPath: string;
  readonly copyDirectory: string;
  readonly settingsDatabasePaths: readonly (string | null | undefined)[];
  readonly platform: NodeJS.Platform;
  readonly recordUpdatedAt?: string;
  readonly copyGraceMs?: number;
}

export const DEFAULT_COPY_GRACE_MS = 600_000;

export function isOwnCopyPath(copyPath: string, copyDirectory: string, platform: NodeJS.Platform): boolean {
  const path = resolve(copyPath);
  const directory = resolve(copyDirectory);
  const same = (a: string, b: string): boolean =>
    platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  return same(dirname(path), directory) && COPY_FILE_NAME.test(basename(path));
}

async function isMissing(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export async function settleOrphanCopy(input: SettleOrphanCopyInput): Promise<CopySettlement> {
  const { copyPath, copyDirectory, platform } = input;
  if (!isOwnCopyPath(copyPath, copyDirectory, platform)) return "refused";
  const key = canonicalDatabasePath(copyPath, platform);
  const inUse = input.settingsDatabasePaths.some(
    (path) => typeof path === "string" && path.length > 0 && canonicalDatabasePath(path, platform) === key,
  );
  if (inUse) return "in-use";
  let present = false;
  try {
    const stat = await lstat(copyPath);
    if (!stat.isFile()) return "refused";
    present = true;
    if (input.recordUpdatedAt !== undefined) {
      const wrote = Date.parse(input.recordUpdatedAt);
      if (!Number.isNaN(wrote) && stat.mtimeMs > wrote + (input.copyGraceMs ?? DEFAULT_COPY_GRACE_MS)) return "refused";
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "refused";
  }
  let removedAny = present;
  for (const suffix of ["", ...SIDE_FILES]) {
    const path = `${copyPath}${suffix}`;
    if (await isMissing(path)) continue;
    const stat = await lstat(path);
    if (!stat.isFile()) return "refused";
    await rm(path, { force: true });
    removedAny = true;
  }
  return removedAny ? "removed" : "absent";
}
