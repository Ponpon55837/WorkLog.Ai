import { randomBytes } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import path from "node:path";

/** The mode of a file only its owner may read or write. */
const OWNER_ONLY_MODE = 0o600;

/**
 * Writes `bytes` to `target` so the result is readable by its owner only, also when `target` already exists: a file's
 * mode is applied only when it is created, so the bytes go to a new file in the same directory (flag `wx`, mode 0600)
 * and that file is renamed over `target`. A reader sees the old content or the new, and on a failure the new file is
 * removed and `target` is left as it was. (Windows has no POSIX mode; the rename still replaces the file.)
 */
export async function writePrivateFile(target: string, bytes: Uint8Array): Promise<void> {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const handle = await open(temporary, "wx", OWNER_ONLY_MODE);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  } catch (error) {
    try {
      await rm(temporary, { force: true });
    } catch {
      // The first error is the one to report; a leftover temporary file holds no more than the target would.
    }
    throw error;
  }
}
