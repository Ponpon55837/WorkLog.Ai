import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Lives beside the database, not in the system temp directory (often a small system drive on Windows). The sweep
 * removes only what this module made and never follows a symbolic link.
 */

export type TransferKind = "import" | "export";

/** @internal test-only */
export const ORPHAN_TRANSFER_AGE_MS = 60 * 60 * 1000;
/**
 * The upload, its spill file (at most the upload's size), then database growth and the pre-import snapshot, with a margin.
 * @internal test-only
 */
export const TRANSFER_FREE_SPACE_FACTOR = 2.5;
export const TRANSFER_DISK_FULL_MESSAGE = "磁碟空間不足，無法暫存匯入檔；請先釋出空間再試。";

/** @internal test-only */
export const TRANSFER_ROOT_NAME = ".work-intelligence-transfer";
/** @internal test-only */
export const TRANSFER_MARKER_FILE = ".wi-transfer";
/** @internal test-only */
export const TRANSFER_MARKER_CONTENT = "work-intelligence transfer directory v1\n";

export const TRANSFER_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Directories of the transfers running in this process; the sweep never removes one, however old it looks. */
const activeDirectories = new Set<string>();

// `mkdtemp` appends exactly six characters from this set.
const TRANSFER_DIRECTORY = /^(import|export)-[A-Za-z0-9]{6}$/;

export function transferRoot(databasePath: string): string {
  return databasePath === ":memory:" || databasePath === ""
    ? join(tmpdir(), "work-intelligence-transfers")
    : join(dirname(resolve(databasePath)), TRANSFER_ROOT_NAME);
}

export function createTransferDirectory(root: string, kind: TransferKind): string {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(root, `${kind}-`));
  try {
    writeFileSync(join(directory, TRANSFER_MARKER_FILE), TRANSFER_MARKER_CONTENT, { flag: "wx", mode: 0o600 });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  activeDirectories.add(directory);
  return directory;
}

export function removeTransferDirectory(directory: string): void {
  activeDirectories.delete(directory);
  rmSync(directory, { recursive: true, force: true });
}

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
    if (activeDirectories.has(path)) continue;
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

export async function hasTransferSpace(directory: string, uploadBytes: number): Promise<boolean> {
  try {
    const stats = await statfs(directory);
    return Number(stats.bavail) * Number(stats.bsize) >= uploadBytes * TRANSFER_FREE_SPACE_FACTOR;
  } catch {
    return true;
  }
}
