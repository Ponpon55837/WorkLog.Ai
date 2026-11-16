import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "../internal/atomic-file.js";
import { operationJournalFileSchema, type OperationJournalFile } from "./journal-record.js";

/** Why a journal could not be loaded or saved. */
export type JournalStoreErrorCode = "unreadable" | "invalid" | "unwritable";

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

/** File-backed store: atomic replace with mode 0o600; reads are fail-closed (only ENOENT means "no journal"). */
export class FileOperationJournalStore implements OperationJournalStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<OperationJournalFile | null> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new JournalStoreError("unreadable", `cannot read operation journal ${this.filePath}`, error);
    }
    try {
      return operationJournalFileSchema.parse(JSON.parse(text));
    } catch (error) {
      throw new JournalStoreError(
        "invalid",
        `operation journal ${this.filePath} is corrupt or has an unknown version`,
        error,
      );
    }
  }

  async save(file: OperationJournalFile): Promise<void> {
    try {
      await writeFileAtomic(this.filePath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      throw new JournalStoreError("unwritable", `cannot write operation journal ${this.filePath}`, error);
    }
  }
}
