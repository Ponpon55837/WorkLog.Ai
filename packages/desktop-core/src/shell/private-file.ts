import { randomBytes } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import path from "node:path";

const OWNER_ONLY_MODE = 0o600;

// A file's mode applies only at creation, so write a new 0600 file and rename it over `target`.
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
      // Report the first error; a leftover temporary file holds no more than the target would.
    }
    throw error;
  }
}
