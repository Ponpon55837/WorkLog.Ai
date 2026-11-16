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

  /** Oldest first. */
  list(): readonly RecordedError[] {
    return [...this.entries];
  }

  latest(): RecordedError | undefined {
    return this.entries[this.entries.length - 1];
  }
}
