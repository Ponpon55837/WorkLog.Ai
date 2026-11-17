import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Scratch space of large imports and exports: the uploaded file, the import's spill file and an export being written.
 * It lives beside the database (`<data>/.work-intelligence-transfer/import-*` and `export-*`), on the disk the data is
 * on, instead of the system temporary directory, which on Windows is often a small system drive and is cleaned by
 * other software. Each operation removes its directory; a crash leaves one behind, which the next backend start
 * removes once it is older than {@link ORPHAN_TRANSFER_AGE_MS}.
 *
 * The database may sit in any folder of the user's (for example their Documents), so the sweep removes only what this
 * module made: a directory under the dedicated root, named exactly as `mkdtemp` names it, that holds the marker file
 * with {@link TRANSFER_MARKER_CONTENT}. A symbolic link is never followed: not as the root, and not as an entry.
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

/** The folder beside the database that holds every transfer directory, and nothing else. */
export const TRANSFER_ROOT_NAME = ".work-intelligence-transfer";
/** The file each transfer directory gets when it is created; the sweep removes only a directory that has it. */
export const TRANSFER_MARKER_FILE = ".wi-transfer";
export const TRANSFER_MARKER_CONTENT = "work-intelligence transfer directory v1\n";

/** `mkdtemp` appends exactly six characters from this set. */
const TRANSFER_DIRECTORY = /^(import|export)-[A-Za-z0-9]{6}$/;

/** `<directory of the database>/.work-intelligence-transfer`; an in-memory database (tests) uses the system temp. */
export function transferRoot(databasePath: string): string {
  return databasePath === ":memory:" || databasePath === ""
    ? join(tmpdir(), "work-intelligence-transfers")
    : join(dirname(resolve(databasePath)), TRANSFER_ROOT_NAME);
}

/** A new private directory for one transfer; the caller removes it with {@link removeTransferDirectory}. */
export function createTransferDirectory(root: string, kind: TransferKind): string {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(root, `${kind}-`));
  try {
    writeFileSync(join(directory, TRANSFER_MARKER_FILE), TRANSFER_MARKER_CONTENT, { flag: "wx", mode: 0o600 });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return directory;
}

export function removeTransferDirectory(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}

/**
 * Removes transfer directories older than `maxAgeMs`; returns how many. Only a real directory (not a link) named as
 * {@link createTransferDirectory} names it and holding its marker is removed, and nothing at all when the root is a
 * link. Never throws: it only frees space.
 */
export function sweepTransferDirectories(root: string, now = Date.now(), maxAgeMs = ORPHAN_TRANSFER_AGE_MS): number {
  let removed = 0;
  let entries: string[];
  try {
    if (!lstatSync(root).isDirectory()) return 0;
    entries = readdirSync(root);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!TRANSFER_DIRECTORY.test(name)) continue;
    const path = join(root, name);
    try {
      const stats = lstatSync(path);
      if (!stats.isDirectory() || now - stats.mtimeMs < maxAgeMs || !hasTransferMarker(path)) continue;
      removeTransferDirectory(path);
      removed += 1;
    } catch {
      // Another process may be removing it, or it is in use on Windows; the next start tries again.
    }
  }
  return removed;
}

function hasTransferMarker(directory: string): boolean {
  const marker = join(directory, TRANSFER_MARKER_FILE);
  try {
    return lstatSync(marker).isFile() && readFileSync(marker, "utf8") === TRANSFER_MARKER_CONTENT;
  } catch {
    return false;
  }
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
