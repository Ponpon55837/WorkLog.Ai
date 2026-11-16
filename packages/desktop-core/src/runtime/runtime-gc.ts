import fs from "node:fs/promises";
import path from "node:path";
import { QUARANTINE_DIRECTORY_PREFIX, RUNTIMES_DIRECTORY_NAME, readCurrentRuntimeId } from "./layout.js";
import { isRuntimeId } from "./manifest.js";

/** What a collection did; names only, never paths. */
export interface RuntimeCollection {
  readonly removed: readonly string[];
  /** Directories that could not be removed now (on Windows, one a running process still holds); tried again next time. */
  readonly failed: readonly string[];
}

/** Options of {@link collectOldRuntimes}. */
export interface CollectOldRuntimesOptions {
  /** Runtime ids to keep besides `current`: the previous runtime is the one fallback. */
  readonly keep?: readonly string[];
  /** Remove only leftovers (quarantined directories), never a runtime directory. */
  readonly onlyLeftovers?: boolean;
  /** Removes a directory tree; injectable so tests can make one stay. */
  readonly remove?: (directory: string) => Promise<void>;
}

const removeTree = (directory: string): Promise<void> =>
  fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });

/**
 * Best-effort cleanup of `<root>/runtimes` (DT-24): removes quarantined directories (a staging directory belongs to an install that may be running, so only that install removes it), and runtime directories
 * that are neither `current` nor listed in `keep`. `current` is read here, at collection time, and is never removed; if
 * it cannot be read nothing but leftovers is removed. A directory that cannot be removed (a process still runs from it on
 * Windows) stays and is reported in `failed`; it is not an error. Run it in the background: it never blocks a start.
 * It is meant to run only after the runtime was verified, from the App that holds the single-instance lock.
 */
export async function collectOldRuntimes(
  root: string,
  options: CollectOldRuntimesOptions = {},
): Promise<RuntimeCollection> {
  const runtimes = path.join(root, RUNTIMES_DIRECTORY_NAME);
  const remove = options.remove ?? removeTree;
  const current = await readCurrentRuntimeId(root).catch(() => undefined);
  const keep = new Set([...(options.keep ?? []), ...(current === undefined ? [] : [current])]);
  let names: string[];
  try {
    names = await fs.readdir(runtimes);
  } catch {
    return { removed: [], failed: [] };
  }
  const removed: string[] = [];
  const failed: string[] = [];
  for (const name of names) {
    const leftover = name.startsWith(QUARANTINE_DIRECTORY_PREFIX);
    const stale = isRuntimeId(name) && !keep.has(name) && current !== undefined && options.onlyLeftovers !== true;
    if (!leftover && !stale) continue;
    const target = path.join(runtimes, name);
    try {
      if (!(await fs.lstat(target)).isDirectory()) continue;
      await remove(target);
      removed.push(name);
    } catch {
      failed.push(name);
    }
  }
  return { removed, failed };
}
