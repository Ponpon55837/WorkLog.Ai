import { readFile, rename } from "node:fs/promises";
import { writeFileAtomic } from "../internal/atomic-file.js";
import { OPERATION_JOURNAL_VERSION, operationJournalFileSchema, type OperationJournalFile } from "./journal-record.js";

/** Why a journal could not be loaded or saved. */
export type JournalStoreErrorCode = "unreadable" | "invalid" | "unwritable" | "newer-version";

/** Fail-closed error: callers must treat the journal state as unknown and go to repair, never "empty". */
export class JournalStoreError extends Error {
  readonly code: JournalStoreErrorCode;

  constructor(code: JournalStoreErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "JournalStoreError";
    this.code = code;
  }
}

/** Persistence port for the journal; injected so tests and other platforms can swap it. */
export interface OperationJournalStore {
  /** `null` only when no journal exists yet; every other failure throws {@link JournalStoreError}. */
  load(): Promise<OperationJournalFile | null>;
  save(file: OperationJournalFile): Promise<void>;
}

/** Volatile store for tests and dry runs. Stores a deep copy so callers cannot mutate persisted state. */
export class InMemoryOperationJournalStore implements OperationJournalStore {
  private snapshot: string | null = null;

  async load(): Promise<OperationJournalFile | null> {
    return this.snapshot === null ? null : operationJournalFileSchema.parse(JSON.parse(this.snapshot));
  }

  async save(file: OperationJournalFile): Promise<void> {
    this.snapshot = JSON.stringify(file);
  }
}

/** Told when a journal that could not be parsed was moved aside so the next start begins from an empty one. */
export interface JournalQuarantine {
  readonly from: string;
  readonly to: string;
  /** Why the file was rejected (a parse error or the first schema issue); never the file's content. */
  readonly reason: string;
}

export interface FileOperationJournalStoreOptions {
  /** Called once per quarantined file (the App logs it). */
  readonly onQuarantine?: (quarantine: JournalQuarantine) => void;
  readonly clock?: () => Date;
}

/**
 * File-backed store: atomic replace with mode 0o600. Only ENOENT means "no journal". A file that is there but cannot be
 * read stays fail-closed (`unreadable`), and so does one written by a newer App (`newer-version`, left untouched). A file
 * that cannot be parsed (corrupt, truncated, a shape this version does not know) is moved
 * aside to `<file>.corrupt-<time>` and the journal starts empty, so one damaged file cannot stop every later start;
 * the records it held cannot be recovered, which the caller's log line records.
 */
export class FileOperationJournalStore implements OperationJournalStore {
  private readonly filePath: string;
  private readonly onQuarantine: ((quarantine: JournalQuarantine) => void) | undefined;
  private readonly clock: () => Date;

  constructor(filePath: string, options: FileOperationJournalStoreOptions = {}) {
    this.filePath = filePath;
    this.onQuarantine = options.onQuarantine;
    this.clock = options.clock ?? (() => new Date());
  }

  async load(): Promise<OperationJournalFile | null> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new JournalStoreError("unreadable", `cannot read operation journal ${this.filePath}`, error);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return this.quarantine(error);
    }
    // A journal written by a newer App is not damaged: it is left exactly where it is and nothing is started on it.
    const version = (parsed as { journalVersion?: unknown } | null)?.journalVersion;
    if (typeof version === "number" && version > OPERATION_JOURNAL_VERSION) {
      throw new JournalStoreError("newer-version", `operation journal ${this.filePath} was written by a newer version`);
    }
    try {
      return operationJournalFileSchema.parse(parsed);
    } catch (error) {
      return this.quarantine(error);
    }
  }

  private async quarantine(cause: unknown): Promise<null> {
    const stamp = this.clock().toISOString().replace(/[:.]/g, "-");
    const target = `${this.filePath}.corrupt-${stamp}`;
    try {
      await rename(this.filePath, target);
    } catch (error) {
      throw new JournalStoreError(
        "invalid",
        `operation journal ${this.filePath} is corrupt and could not be moved aside`,
        error,
      );
    }
    const reason = cause instanceof Error ? cause.name : "unparseable";
    this.onQuarantine?.({ from: this.filePath, to: target, reason });
    return null;
  }

  async save(file: OperationJournalFile): Promise<void> {
    try {
      await writeFileAtomic(this.filePath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      throw new JournalStoreError("unwritable", `cannot write operation journal ${this.filePath}`, error);
    }
  }
}
