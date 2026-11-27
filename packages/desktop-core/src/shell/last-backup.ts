import { posix, win32 } from "node:path";
import { parseDatabaseBackupFileName } from "@work-intelligence/shared/backup-name";

export type LastBackupInfo =
  { readonly status: "known"; readonly at: string } | { readonly status: "none" } | { readonly status: "unknown" };

export interface BackupDirectoryReader {
  readdir(directory: string): Promise<readonly string[]>;
  lstat(path: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean }>;
}

export function joinBackupPath(directory: string, name: string, platform: NodeJS.Platform): string {
  return (platform === "win32" ? win32 : posix).join(directory, name);
}

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
    const parsed = parseDatabaseBackupFileName(databasePath, name, platform);
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

export function databaseKey(identity: {
  readonly realPath: string;
  readonly fileId: { readonly device: string; readonly inode: string } | null;
}): string {
  return `${identity.realPath}\n${identity.fileId ? `${identity.fileId.device}:${identity.fileId.inode}` : "-"}`;
}

export interface LastBackupTrackerOptions {
  readonly clock?: () => number;
  readonly scanTtlMs?: number;
}

const DEFAULT_SCAN_TTL_MS = 30_000;

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

  bindDatabase(key: string | null): void {
    if (key === this.bound) return;
    this.bound = key;
    this.invalidate();
  }

  recordFromBackend(at: string, key: string): void {
    const time = Date.parse(at);
    if (Number.isNaN(time)) return;
    const iso = new Date(time).toISOString();
    if (!this.reported || this.reported.key !== key || iso > this.reported.at) this.reported = { key, at: iso };
    this.invalidate();
  }

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
