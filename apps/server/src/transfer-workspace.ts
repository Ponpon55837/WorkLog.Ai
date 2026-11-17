import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Scratch space of large imports and exports: the uploaded file, the import's spill file and an export being written.
 * It lives beside the database (`<data>/tmp/import-*` and `export-*`), on the disk the data is on and under the app's
 * own directory, instead of the system temporary directory, which on Windows is often a small system drive and is
 * cleaned by other software. Each operation removes its directory; a crash leaves one behind, which the next
 * backend start removes once it is older than {@link ORPHAN_TRANSFER_AGE_MS}.
 */

export type TransferKind = "import" | "export";

/** A directory left by a crashed operation is removed at start once it is this old; a live one is minutes old. */
export const ORPHAN_TRANSFER_AGE_MS = 60 * 60 * 1000;
/**
 * Free space an upload needs, as a multiple of its size: the upload itself, the spill file (at most the upload's
 * size) and the database growth and pre-import snapshot that follow, with a margin.
 */
export const TRANSFER_FREE_SPACE_FACTOR = 2.5;
export const TRANSFER_DISK_FULL_MESSAGE = "磁碟空間不足，無法暫存匯入檔；請先釋出空間再試。";

const TRANSFER_DIRECTORY = /^(import|export)-[A-Za-z0-9]+$/;

/** `<directory of the database>/tmp`; an in-memory database (tests) uses the system temporary directory. */
export function transferRoot(databasePath: string): string {
  return databasePath === ":memory:" || databasePath === ""
    ? join(tmpdir(), "work-intelligence-transfers")
    : join(dirname(resolve(databasePath)), "tmp");
}

/** A new private directory for one transfer; the caller removes it with {@link removeTransferDirectory}. */
export function createTransferDirectory(root: string, kind: TransferKind): string {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(root, `${kind}-`));
}

export function removeTransferDirectory(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}

/** Removes transfer directories older than `maxAgeMs`; returns how many. Never throws: it only frees space. */
export function sweepTransferDirectories(root: string, now = Date.now(), maxAgeMs = ORPHAN_TRANSFER_AGE_MS): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!TRANSFER_DIRECTORY.test(name)) continue;
    const path = join(root, name);
    try {
      if (now - statSync(path).mtimeMs < maxAgeMs) continue;
      removeTransferDirectory(path);
      removed += 1;
    } catch {
      // Another process may be removing it, or it is in use on Windows; the next start tries again.
    }
  }
  return removed;
}

/**
 * Whether the disk under `directory` can take an upload of `uploadBytes` and what follows it. A file system that cannot
 * report its free space does not block the upload: writing then fails on its own if the disk fills up.
 */
export async function hasTransferSpace(directory: string, uploadBytes: number): Promise<boolean> {
  try {
    const stats = await statfs(directory);
    return Number(stats.bavail) * Number(stats.bsize) >= uploadBytes * TRANSFER_FREE_SPACE_FACTOR;
  } catch {
    return true;
  }
}
