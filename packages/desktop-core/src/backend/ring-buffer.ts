export class LineRingBuffer {
  private readonly slots: string[];
  private readonly maxLineLength: number;
  private next = 0;
  private size = 0;

  constructor(capacity: number, maxLineLength = 500) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("capacity must be a positive integer");
    this.slots = new Array<string>(capacity);
    this.maxLineLength = maxLineLength;
  }

  push(line: string): void {
    this.slots[this.next] = line.length > this.maxLineLength ? `${line.slice(0, this.maxLineLength)}…` : line;
    this.next = (this.next + 1) % this.slots.length;
    this.size = Math.min(this.size + 1, this.slots.length);
  }

  lines(): string[] {
    const start = this.size < this.slots.length ? 0 : this.next;
    return Array.from({ length: this.size }, (_unused, index) => this.slots[(start + index) % this.slots.length] ?? "");
  }
}

const MIN_SECRET_LENGTH = 3;
const REDACTED = "[redacted]";

export class SecretMasker {
  private readonly caseInsensitive: boolean;
  private secrets: string[] = [];

  constructor(options: { caseInsensitive?: boolean } = {}) {
    this.caseInsensitive = options.caseInsensitive ?? false;
  }

  add(secret: string | undefined): void {
    if (!secret || secret.length < MIN_SECRET_LENGTH) return;
    const variants = this.caseInsensitive ? [secret, secret.replaceAll("\\", "/")] : [secret];
    for (const variant of variants) {
      if (this.secrets.includes(variant)) continue;
      this.secrets.push(variant);
    }
    // Longest first: a path must be masked before the home directory that is its prefix.
    this.secrets.sort((left, right) => right.length - left.length);
  }

  apply(line: string): string {
    return this.applyCounted(line).line;
  }

  applyCounted(line: string): { readonly line: string; readonly replaced: number } {
    let replaced = 0;
    const masked = this.secrets.reduce((current, secret) => {
      const result = this.replaceAll(current, secret);
      replaced += result.replaced;
      return result.line;
    }, line);
    return { line: masked, replaced };
  }

  private replaceAll(line: string, secret: string): { line: string; replaced: number } {
    if (!this.caseInsensitive) {
      const parts = line.split(secret);
      return { line: parts.join(REDACTED), replaced: parts.length - 1 };
    }
    const needle = secret.toLowerCase();
    const lower = line.toLowerCase();
    if (lower.length === line.length && needle.length === secret.length) {
      const parts: string[] = [];
      let start = 0;
      let found = lower.indexOf(needle);
      while (found !== -1) {
        parts.push(line.slice(start, found));
        start = found + needle.length;
        found = lower.indexOf(needle, start);
      }
      parts.push(line.slice(start));
      return { line: parts.join(REDACTED), replaced: parts.length - 1 };
    }
    let output = "";
    let index = 0;
    let replaced = 0;
    while (index < line.length) {
      if (
        needle.startsWith(line.charAt(index).toLowerCase()) &&
        line.slice(index, index + secret.length).toLowerCase() === needle
      ) {
        output += REDACTED;
        index += secret.length;
        replaced += 1;
      } else {
        output += line.charAt(index);
        index += 1;
      }
    }
    return { line: output, replaced };
  }
}

const MAX_PARTIAL_LENGTH = 8192;

/** A line is masked whole before the ring buffer cuts it, so a secret is never split in two and stored in halves. */
export class LineCollector {
  private readonly buffer: LineRingBuffer;
  private readonly masker: SecretMasker;
  private partial = "";
  private discarding = false;

  constructor(buffer: LineRingBuffer, masker: SecretMasker) {
    this.buffer = buffer;
    this.masker = masker;
  }

  write(text: string): void {
    let rest = text;
    if (this.discarding) {
      const newline = rest.indexOf("\n");
      if (newline < 0) return;
      this.discarding = false;
      rest = rest.slice(newline + 1);
    }
    const parts = (this.partial + rest).split(/\r?\n/);
    this.partial = parts.pop() ?? "";
    for (const line of parts) this.buffer.push(this.masker.apply(line));
    if (this.partial.length > MAX_PARTIAL_LENGTH) {
      this.flush();
      this.discarding = true;
    }
  }

  flush(): void {
    if (this.partial) this.buffer.push(this.masker.apply(this.partial));
    this.partial = "";
  }
}
