import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { MANIFEST_FILE_NAME, VERIFIED_CACHE_FILE_NAME } from "./layout.js";

/** What identifies one version of a file on disk without reading it; ctime cannot be set back from user space. */
export interface Fingerprint {
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly ino: string;
  readonly dev: string;
}

/** A file system entry as seen by one `lstat`. */
export interface EntryStat {
  readonly mode: number;
  readonly uid: number;
  readonly size: number;
  readonly fingerprint: Fingerprint;
}

/** A regular file found below a runtime directory. */
export interface ScannedFile {
  readonly path: string;
  readonly stat: EntryStat;
}

/** A symbolic link found below a runtime directory. */
export interface ScannedSymlink {
  readonly path: string;
  readonly target: string;
}

/** Everything below a runtime directory, found in one walk. Paths are relative and use `/`. */
export interface RuntimeScan {
  readonly files: readonly ScannedFile[];
  readonly symlinks: readonly ScannedSymlink[];
  /** Directories (the runtime directory itself is `""`), for the permission check. */
  readonly directories: readonly { readonly path: string; readonly stat: EntryStat }[];
  /** Sockets, FIFOs, devices, and non-files using a bookkeeping name; none belongs in a runtime. */
  readonly special: readonly string[];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A cache write in progress next to the cache itself; another launcher may be mid-write while this one scans. */
const CACHE_TEMP_PATTERN = new RegExp(`^${escapeRegExp(VERIFIED_CACHE_FILE_NAME)}\\.[0-9a-f]+\\.tmp$`);

/** One `lstat` as numbers and strings; BigInt stats keep nanosecond times and 64-bit inodes exact. */
export function toEntryStat(stat: BigIntStats): EntryStat {
  return {
    mode: Number(stat.mode),
    uid: Number(stat.uid),
    size: Number(stat.size),
    fingerprint: {
      size: String(stat.size),
      mtimeNs: String(stat.mtimeNs),
      ctimeNs: String(stat.ctimeNs),
      ino: String(stat.ino),
      dev: String(stat.dev),
    },
  };
}

/** `lstat` of one path as an {@link EntryStat}. */
export async function lstatEntry(target: string): Promise<EntryStat> {
  return toEntryStat(await fs.lstat(target, { bigint: true }));
}

/** Whether two fingerprints describe the same version of a file. */
export function sameFingerprint(left: Fingerprint, right: Fingerprint): boolean {
  return (
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.ino === right.ino &&
    left.dev === right.dev
  );
}

/** The manifest and the verification cache are not part of the runtime's content. */
function isBookkeeping(relative: string): boolean {
  return relative === MANIFEST_FILE_NAME || relative === VERIFIED_CACHE_FILE_NAME || CACHE_TEMP_PATTERN.test(relative);
}

/**
 * Walks `directory` once. Symbolic links are reported, never followed, so nothing outside the directory is read.
 * Directory listings and `lstat` calls overlap with bounded parallelism; the result is sorted by path.
 */
export async function scanRuntimeDirectory(directory: string): Promise<RuntimeScan> {
  const files: ScannedFile[] = [];
  const symlinks: ScannedSymlink[] = [];
  const directories: { path: string; stat: EntryStat }[] = [];
  const special: string[] = [];
  const stats: Promise<void>[] = [];

  const queueStat = (relative: string, sink: (stat: EntryStat) => void): void => {
    stats.push(lstatEntry(path.join(directory, relative)).then(sink));
  };

  try {
    const pending = [""];
    while (pending.length > 0) {
      const relativeDirectory = pending.pop() as string;
      queueStat(relativeDirectory, (stat) => directories.push({ path: relativeDirectory, stat }));
      const entries = await fs.readdir(path.join(directory, relativeDirectory), { withFileTypes: true });
      for (const entry of entries) {
        const relative = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
        if (relativeDirectory === "" && isBookkeeping(relative)) {
          // Only a plain file may hide under a bookkeeping name; a directory or link there would escape the scan.
          if (!entry.isFile()) special.push(relative);
          continue;
        }
        if (entry.isDirectory()) {
          pending.push(relative);
        } else if (entry.isSymbolicLink()) {
          stats.push(
            fs
              .readlink(path.join(directory, relative))
              .then((target) => void symlinks.push({ path: relative, target })),
          );
        } else if (entry.isFile()) {
          queueStat(relative, (stat) => files.push({ path: relative, stat }));
        } else {
          special.push(relative);
        }
      }
    }
  } finally {
    // Every started lstat settles before this returns or throws, so none is left rejecting unobserved.
    await Promise.allSettled(stats);
  }
  await Promise.all(stats);

  const byPath = <T extends { path: string }>(left: T, right: T): number => (left.path < right.path ? -1 : 1);
  return {
    files: files.sort(byPath),
    symlinks: symlinks.sort(byPath),
    directories: directories.sort(byPath),
    special: special.sort(),
  };
}
