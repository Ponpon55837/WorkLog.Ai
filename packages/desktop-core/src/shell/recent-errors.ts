/** One recorded error: its code and when it happened (UTC ISO). Never a message body or a path. */
export interface RecordedError {
  readonly code: string;
  readonly at: string;
}

/** The last few error codes, newest last; a fixed capacity so a crash loop cannot grow memory. */
export class RecentErrors {
  private readonly capacity: number;
  private readonly entries: RecordedError[] = [];

  constructor(capacity = 20) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("capacity must be a positive integer");
    this.capacity = capacity;
  }

  record(code: string, at: Date): void {
    this.entries.push({ code, at: at.toISOString() });
    if (this.entries.length > this.capacity) this.entries.shift();
  }

  /** Forgets every error: the service works again, so none of them is current. */
  clear(): void {
    this.entries.length = 0;
  }

  /** The current failure replaces what was recorded before, so the page never mixes old errors with the new one. */
  replaceWith(code: string, at: Date): void {
    this.clear();
    this.record(code, at);
  }

  /** Oldest first. */
  list(): readonly RecordedError[] {
    return [...this.entries];
  }

  latest(): RecordedError | undefined {
    return this.entries[this.entries.length - 1];
  }
}
