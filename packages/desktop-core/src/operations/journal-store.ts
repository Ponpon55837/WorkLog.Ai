import { readFile, rename } from "node:fs/promises";
import { writeFileAtomic } from "../internal/atomic-file.js";
import { OPERATION_JOURNAL_VERSION, operationJournalFileSchema, type OperationJournalFile } from "./journal-record.js";

export type JournalStoreErrorCode = "unreadable" | "invalid" | "unwritable" | "newer-version";

/** Fail closed: callers treat the journal state as unknown and go to repair, never as empty. */
export class JournalStoreError extends Error {
  readonly code: JournalStoreErrorCode;

  constructor(code: JournalStoreErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "JournalStoreError";
    this.code = code;
  }
}

export interface OperationJournalStore {
  load(): Promise<OperationJournalFile | null>;
  save(file: OperationJournalFile): Promise<void>;
}

export class InMemoryOperationJournalStore implements OperationJournalStore {
  private snapshot: string | null = null;

  async load(): Promise<OperationJournalFile | null> {
    return this.snapshot === null ? null : operationJournalFileSchema.parse(JSON.parse(this.snapshot));
  }

  async save(file: OperationJournalFile): Promise<void> {
    this.snapshot = JSON.stringify(file);
  }
}

export interface JournalQuarantine {
  readonly from: string;
  readonly to: string;
  readonly reason: string;
}

export interface FileOperationJournalStoreOptions {
  readonly onQuarantine?: (quarantine: JournalQuarantine) => void;
  readonly clock?: () => Date;
}

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
    // A journal written by a newer App is not damaged: leave it in place and start nothing on it.
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
