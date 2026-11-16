import { posix, win32 } from "node:path";
import { parseDatabaseBackupFileName } from "@work-intelligence/shared/backup-name";

/** When the last successful backup was made, as far as the App can tell. */
export type LastBackupInfo =
  | { readonly status: "known"; /** UTC instant, ISO 8601. */ readonly at: string }
  | { readonly status: "none" }
  | { readonly status: "unknown" };

/** The few file-system calls the directory scan needs, injected so it runs on any platform. */
export interface BackupDirectoryReader {
  readdir(directory: string): Promise<readonly string[]>;
  lstat(path: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean }>;
}

/**
 * Joins a backup folder and a file name the way the platform does: `win32` accepts either slash and UNC shares and always
 * yields backslashes; `posix` keeps forward slashes. The platform is injected so both are tested on any machine.
 */
export function joinBackupPath(directory: string, name: string, platform: NodeJS.Platform): string {
  return (platform === "win32" ? win32 : posix).join(directory, name);
}

/**
 * The newest backup of `databasePath` in `directory`. Only a regular, non-link file whose name passes the shared safety
 * and naming check counts (the same rules the storage layer writes and lists with); anything else is ignored.
 * A missing directory is `none`; an unreadable one is `unknown`, never a guess.
 */
export async function readLastBackupFromDirectory(
  databasePath: string,
  directory: string,
  reader: BackupDirectoryReader,
  platform: NodeJS.Platform = process.platform,
): Promise<LastBackupInfo> {
  let names: readonly string[];
  try {
    names = await reader.readdir(directory);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { status: "none" } : { status: "unknown" };
  }
  let newest: { at: string; sequence: number } | undefined;
  for (const name of names) {
    const parsed = parseDatabaseBackupFileName(databasePath, name);
    if (!parsed) continue;
    try {
      const stats = await reader.lstat(joinBackupPath(directory, name, platform));
      if (!stats.isFile() || stats.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    if (
      !newest ||
      parsed.createdAt > newest.at ||
      (parsed.createdAt === newest.at && parsed.sequence > newest.sequence)
    ) {
      newest = { at: parsed.createdAt, sequence: parsed.sequence };
    }
  }
  return newest ? { status: "known", at: newest.at } : { status: "none" };
}

/** A stable key of a database for binding reports to it: the real path and the file id, never the lineage (it can appear later). */
export function databaseKey(identity: {
  readonly realPath: string;
  readonly fileId: { readonly device: string; readonly inode: string } | null;
}): string {
  return `${identity.realPath}\n${identity.fileId ? `${identity.fileId.device}:${identity.fileId.inode}` : "-"}`;
}

export interface LastBackupTrackerOptions {
  /** Milliseconds clock; injected for tests. */
  readonly clock?: () => number;
  /** How long a folder scan stays valid. Polling the repair page must not read the folder every time. */
  readonly scanTtlMs?: number;
}

const DEFAULT_SCAN_TTL_MS = 30_000;

/**
 * Keeps the last successful backup: the running backend reports each one (`backup-completed`), and the backup folder is
 * read for what happened while it was not running. The later of the two wins; if neither is readable it says so.
 *
 * A report belongs to the database that made it: it counts only while that same database is the one the App is bound to
 * (`bindDatabase`), so switching from A to B never shows A's backup as B's. The folder scan is cached for a short time and
 * dropped whenever the bound database changes or a report arrives.
 */
export class LastBackupTracker {
  private readonly scan: () => Promise<LastBackupInfo>;
  private readonly clock: () => number;
  private readonly scanTtlMs: number;
  private reported: { readonly key: string; readonly at: string } | undefined;
  private bound: string | null = null;
  private cache: { readonly value: LastBackupInfo; readonly takenAt: number } | undefined;
  private scanning: { readonly generation: string | null; readonly promise: Promise<LastBackupInfo> } | undefined;

  constructor(scan: () => Promise<LastBackupInfo>, options: LastBackupTrackerOptions = {}) {
    this.scan = scan;
    this.clock = options.clock ?? Date.now;
    this.scanTtlMs = options.scanTtlMs ?? DEFAULT_SCAN_TTL_MS;
  }

  /** The database the App now serves (its `databaseKey`), or null when none. A different one drops what was cached. */
  bindDatabase(key: string | null): void {
    if (key === this.bound) return;
    this.bound = key;
    this.invalidate();
  }

  /** A backup the running backend of database `key` just completed (UTC ISO instant); an unparsable value is ignored. */
  recordFromBackend(at: string, key: string): void {
    const time = Date.parse(at);
    if (Number.isNaN(time)) return;
    const iso = new Date(time).toISOString();
    if (!this.reported || this.reported.key !== key || iso > this.reported.at) this.reported = { key, at: iso };
    this.invalidate();
  }

  /** Forgets the cached folder scan (the folder or the database changed). */
  invalidate(): void {
    this.cache = undefined;
  }

  async current(): Promise<LastBackupInfo> {
    const scanned = await this.scanned();
    const reported = this.reported && this.reported.key === this.bound ? this.reported.at : undefined;
    if (scanned.status === "known") {
      const scannedIso = new Date(scanned.at).toISOString();
      return { status: "known", at: reported && reported > scannedIso ? reported : scannedIso };
    }
    if (reported) return { status: "known", at: reported };
    return scanned;
  }

  private async scanned(): Promise<LastBackupInfo> {
    const now = this.clock();
    if (this.cache && now - this.cache.takenAt < this.scanTtlMs) return this.cache.value;
    const generation = this.bound;
    if (this.scanning?.generation !== generation) {
      const promise = this.scan()
        .catch((): LastBackupInfo => ({ status: "unknown" }))
        .then((value) => {
          // A scan that finished after the database changed describes the old one: it is never cached.
          if (generation === this.bound) this.cache = { value, takenAt: this.clock() };
          return value;
        })
        .finally(() => {
          if (this.scanning?.promise === promise) this.scanning = undefined;
        });
      this.scanning = { generation, promise };
    }
    return this.scanning.promise;
  }
}
