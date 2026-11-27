export interface RecordedError {
  readonly code: string;
  readonly at: string;
}

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

  clear(): void {
    this.entries.length = 0;
  }

  replaceWith(code: string, at: Date): void {
    this.clear();
    this.record(code, at);
  }

  list(): readonly RecordedError[] {
    return [...this.entries];
  }

  latest(): RecordedError | undefined {
    return this.entries[this.entries.length - 1];
  }
}
