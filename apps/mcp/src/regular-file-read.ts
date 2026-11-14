import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

// Opening a FIFO for reading blocks until a writer appears; the flag does not exist on Windows (no FIFOs there).
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

/**
 * Reads a UTF-8 file named by a hook payload. A hook runs in the Agent's path, so a transcript path that is a FIFO or
 * a device (which would block the Agent forever) or a file larger than `maxBytes` throws instead of being read. The
 * checks use the open descriptor, so a path swapped after a check cannot be read either. Callers treat any throw as
 * "cannot tell" and stay silent.
 */
export function readRegularTextFile(path: string, maxBytes: number): string {
  const descriptor = openSync(path, OPEN_FLAGS);
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) {
      throw new Error("Not a regular file.");
    }
    if (stats.size > maxBytes) {
      throw new Error("The file is too large to read.");
    }
    const buffer = Buffer.allocUnsafe(stats.size);
    let filled = 0;
    while (filled < buffer.length) {
      const bytesRead = readSync(descriptor, buffer, filled, buffer.length - filled, null);
      if (bytesRead === 0) {
        break;
      }
      filled += bytesRead;
    }
    return buffer.toString("utf8", 0, filled);
  } finally {
    closeSync(descriptor);
  }
}
