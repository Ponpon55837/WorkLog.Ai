import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { createTransferDirectory, removeTransferDirectory } from "./transfer-workspace.js";
import type { ProjectDataImportUpload } from "./routes/router.js";

/**
 * Export files the Web UI uploaded once for an import. The page streams the chosen file to the API, which saves it
 * under the transfer root and answers with an id; every preview and the import then name that id instead of sending
 * the file again, and the renderer never reads or parses the file itself.
 *
 * The id is the only handle: 32 random bytes, returned only to the request that uploaded the file, never listed. The
 * API has no user sessions (it serves the local user on loopback behind its Origin and Host checks), so knowing the id
 * is the binding. A staged file is removed after a successful import, on cancel, {@link STAGED_IMPORT_TTL_MS} after it
 * was saved, and by the start-up sweep of the transfer root if the process died first.
 */

export const STAGED_IMPORT_TTL_MS = 30 * 60 * 1000;
/** Staged files kept at once; another upload removes the oldest one not in use, or is refused when all are. */
export const MAX_STAGED_IMPORTS = 2;
export const STAGED_IMPORT_NOT_FOUND_MESSAGE = "暫存的匯入檔已過期或不存在；請重新選擇檔案。";
export const STAGED_IMPORT_BUSY_MESSAGE = "匯入檔仍在處理中，請稍後再試。";

const STAGING_ID = /^[A-Za-z0-9_-]{43}$/;

export class StagedImportError extends Error {
  public constructor(
    public readonly statusCode: 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "StagedImportError";
  }
}

interface StagedImport {
  readonly id: string;
  readonly directory: string;
  readonly path: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** Operations reading the file now; removal waits until they end. */
  uses: number;
  removed: boolean;
  timer: ReturnType<typeof setTimeout>;
}

/** A staged file reserved before its upload finishes; `commit` makes it usable, `discard` removes it. */
export interface StagedImportReservation {
  readonly id: string;
  readonly path: string;
  readonly directory: string;
  readonly expiresAt: Date;
  commit(): void;
  discard(): void;
}

export class StagedImports {
  private readonly entries = new Map<string, StagedImport>();

  public constructor(
    private readonly root: string,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = STAGED_IMPORT_TTL_MS,
    private readonly limit = MAX_STAGED_IMPORTS,
  ) {}

  /**
   * A new directory for an upload. The upload counts toward the limit (and is in use) from now on, so two uploads at
   * once cannot both pass it.
   */
  public reserve(): StagedImportReservation {
    this.makeRoom();
    const id = randomBytes(32).toString("base64url");
    const directory = createTransferDirectory(this.root, "import");
    const createdAt = this.now();
    const entry: StagedImport = {
      id,
      directory,
      path: join(directory, "bundle.json"),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      uses: 1,
      removed: false,
      timer: this.expireLater(id, this.ttlMs),
    };
    this.entries.set(id, entry);
    return {
      id,
      path: entry.path,
      directory,
      expiresAt: new Date(entry.expiresAt),
      commit: () => this.release(entry),
      discard: () => {
        this.release(entry);
        this.remove(id);
      },
    };
  }

  /** Runs `operation` on a staged file; it is not removed while the operation runs. */
  public async use<T>(
    id: string,
    options: unknown,
    operation: (upload: ProjectDataImportUpload) => Promise<T>,
  ): Promise<T> {
    const entry = this.find(id);
    entry.uses += 1;
    try {
      return await operation({ path: entry.path, directory: entry.directory, envelope: "bundle", options });
    } finally {
      this.release(entry);
    }
  }

  /** Removes a staged file now, or as soon as the operations reading it end. Unknown ids are ignored. */
  public remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    clearTimeout(entry.timer);
    entry.removed = true;
    if (entry.uses === 0) removeTransferDirectory(entry.directory);
  }

  /** Removes every staged file (server shutdown). */
  public clear(): void {
    for (const id of [...this.entries.keys()]) this.remove(id);
  }

  public get size(): number {
    return this.entries.size;
  }

  private find(id: string): StagedImport {
    const entry = STAGING_ID.test(id) ? this.entries.get(id) : undefined;
    if (!entry || entry.expiresAt <= this.now()) {
      if (entry) this.remove(id);
      throw new StagedImportError(404, STAGED_IMPORT_NOT_FOUND_MESSAGE);
    }
    return entry;
  }

  private release(entry: StagedImport): void {
    entry.uses = Math.max(0, entry.uses - 1);
    if (entry.removed && entry.uses === 0) removeTransferDirectory(entry.directory);
  }

  private makeRoom(): void {
    for (const [id, entry] of this.entries) if (entry.expiresAt <= this.now()) this.remove(id);
    while (this.entries.size >= this.limit) {
      const idle = [...this.entries.values()]
        .filter((entry) => entry.uses === 0)
        .sort((left, right) => left.createdAt - right.createdAt)[0];
      if (!idle) throw new StagedImportError(409, STAGED_IMPORT_BUSY_MESSAGE);
      this.remove(idle.id);
    }
  }

  private expireLater(id: string, ms: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => this.remove(id), ms);
    timer.unref();
    return timer;
  }
}
