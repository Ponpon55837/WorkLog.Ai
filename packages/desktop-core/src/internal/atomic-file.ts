import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";

/** Options for {@link writeFileAtomic}. */
export interface AtomicWriteOptions {
  /** File mode of the new file; defaults to owner-only because journals may reveal local paths. */
  readonly mode?: number;
}

const DEFAULT_MODE = 0o600;

/** Best-effort directory fsync so the rename itself is durable; unsupported platforms (Windows) just skip it. */
async function syncDirectoryBestEffort(dirPath: string): Promise<void> {
  try {
    const handle = await open(dirPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Not supported or not permitted: the file content is already durable, only the rename may be lost on power failure.
  }
}

/**
 * Replace `target` with `data` so readers see either the old or the new content, never a torn file:
 * temp file in the same directory (same filesystem, so rename is atomic) -> fsync -> rename -> best-effort dir fsync.
 * On failure the temp file is removed and the target is untouched.
 */
export async function writeFileAtomic(target: string, data: string, options: AtomicWriteOptions = {}): Promise<void> {
  const dir = path.dirname(target);
  await mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const handle = await open(temp, "wx", options.mode ?? DEFAULT_MODE);
    try {
      await handle.writeFile(data, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  await syncDirectoryBestEffort(dir);
}
