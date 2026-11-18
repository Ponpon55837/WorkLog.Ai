import { lstat, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { canonicalDatabasePath } from "../shell/setup-state.js";
import type { CopySettlement } from "./startup-recovery.js";

/** The names `uniqueCopyTarget` gives a copy: nothing else in the copy folder is ever the App's to delete. */
const COPY_FILE_NAME = /^work-intelligence-local(?:-\d+)?\.sqlite$/;
const SIDE_FILES = ["-wal", "-shm", "-journal"] as const;

export interface SettleOrphanCopyInput {
  /** The path the journal recorded before the copy started. */
  readonly copyPath: string;
  /** The App's own folder for copies (the folder of its default database). */
  readonly copyDirectory: string;
  /** Every database path the settings name (the database to start, the last verified one); the copy is kept if one is it. */
  readonly settingsDatabasePaths: readonly (string | null | undefined)[];
  readonly platform: NodeJS.Platform;
}

/** The copy path is exactly a copy file name directly inside the copy folder (no other folder, no `..`, no other name). */
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

/**
 * Settles the copy an interrupted "copy to the local disk" left behind. The copy file never existed before the copy
 * (`uniqueCopyTarget` only picks a free name), so when the settings do not name it, it is an orphan and is removed with its
 * WAL/SHM/journal files. Only a plain file directly inside the App's own copy folder is ever removed; a symlink, a folder
 * or any other path is refused untouched.
 */
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
