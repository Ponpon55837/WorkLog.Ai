import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { MANIFEST_FILE_NAME, VERIFIED_CACHE_FILE_NAME } from "./layout.js";

export interface Fingerprint {
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly ino: string;
  readonly dev: string;
}

export interface EntryStat {
  readonly mode: number;
  readonly uid: number;
  readonly size: number;
  readonly fingerprint: Fingerprint;
}

export interface ScannedFile {
  readonly path: string;
  readonly stat: EntryStat;
}

export interface ScannedSymlink {
  readonly path: string;
  readonly target: string;
}

export interface RuntimeScan {
  readonly files: readonly ScannedFile[];
  readonly symlinks: readonly ScannedSymlink[];
  readonly directories: readonly { readonly path: string; readonly stat: EntryStat }[];
  readonly special: readonly string[];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const CACHE_TEMP_PATTERN = new RegExp(`^${escapeRegExp(VERIFIED_CACHE_FILE_NAME)}\\.[0-9a-f]+\\.tmp$`);

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

export async function lstatEntry(target: string): Promise<EntryStat> {
  return toEntryStat(await fs.lstat(target, { bigint: true }));
}

export function sameFingerprint(left: Fingerprint, right: Fingerprint): boolean {
  return (
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.ino === right.ino &&
    left.dev === right.dev
  );
}

function isBookkeeping(relative: string): boolean {
  return relative === MANIFEST_FILE_NAME || relative === VERIFIED_CACHE_FILE_NAME || CACHE_TEMP_PATTERN.test(relative);
}

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
