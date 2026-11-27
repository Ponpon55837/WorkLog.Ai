import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export type RegularFileRead =
  { kind: "read"; text: string; modifiedAt: Date } | { kind: "skipped"; reason: "not_regular_file" | "too_large" };

// Opening a FIFO for reading blocks until a writer appears, so a file that turns into one after a directory listing
// must not block the open itself. The flag does not exist on Windows, where FIFOs are not file-system entries.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

/** Checks use the opened descriptor, so nothing swapped in after a listing or `stat` (a FIFO, device, directory) is read. */
export function readRegularFileUtf8(path: string, maxBytes: number): RegularFileRead {
  const descriptor = openSync(path, OPEN_FLAGS);
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) {
      return { kind: "skipped", reason: "not_regular_file" };
    }
    if (stats.size > maxBytes) {
      return { kind: "skipped", reason: "too_large" };
    }
    // A file that grows after the check is read only up to the checked size.
    const buffer = Buffer.allocUnsafe(stats.size);
    let filled = 0;
    while (filled < buffer.length) {
      const bytesRead = readSync(descriptor, buffer, filled, buffer.length - filled, null);
      if (bytesRead === 0) {
        break;
      }
      filled += bytesRead;
    }
    return { kind: "read", text: buffer.toString("utf8", 0, filled), modifiedAt: stats.mtime };
  } finally {
    closeSync(descriptor);
  }
}
