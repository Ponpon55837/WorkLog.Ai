/** A fixed-capacity buffer of the most recent lines: O(1) writes, the oldest line is overwritten, memory never grows. */
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

  /** The kept lines, oldest first. */
  lines(): string[] {
    const start = this.size < this.slots.length ? 0 : this.next;
    return Array.from({ length: this.size }, (_unused, index) => this.slots[(start + index) % this.slots.length] ?? "");
  }
}

/** A secret shorter than this is not masked: a one-character "path" such as `/` would erase every line. */
const MIN_SECRET_LENGTH = 3;
const REDACTED = "[redacted]";

/**
 * Masks known secrets in one line of child output: the run id, the health challenge, and every path the child may echo
 * (database, its real path, backup directory, the user's home). Plain string search, never a RegExp, so a path full of
 * regex metacharacters (`C:\Users\a.b (x86)`) is matched literally. `caseInsensitive` is for Windows paths.
 */
export class SecretMasker {
  private readonly caseInsensitive: boolean;
  private secrets: string[] = [];

  constructor(options: { caseInsensitive?: boolean } = {}) {
    this.caseInsensitive = options.caseInsensitive ?? false;
  }

  /** Registers a secret (and, for a Windows path, its forward-slash form); empty and tiny values are ignored. */
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

  /** The whole line with every occurrence of every secret replaced. */
  apply(line: string): string {
    return this.applyCounted(line).line;
  }

  /** Like {@link apply}, and how many occurrences were replaced (the diagnostics report counts them, never their values). */
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
    let output = "";
    let index = 0;
    let replaced = 0;
    while (index < line.length) {
      // The first character is compared before slicing, so a long text does not allocate a slice per position.
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

/** A line that grows past this without a newline is masked as a whole, stored, and the rest of it is dropped. */
const MAX_PARTIAL_LENGTH = 8192;

/**
 * Turns stream chunks into whole lines for a {@link LineRingBuffer}. A partial last line waits for its newline. Every
 * line is masked as a whole BEFORE the ring buffer cuts it to its length limit, so a secret is never split in two and
 * pushed in halves. A line that never ends is masked and stored once it passes {@link MAX_PARTIAL_LENGTH}, and the rest
 * of that line is discarded; because the ring limit is far below that length, any secret cut by the chunk boundary
 * falls in the part the ring drops.
 */
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

  /** Stores an unfinished last line (the stream ended without a newline). */
  flush(): void {
    if (this.partial) this.buffer.push(this.masker.apply(this.partial));
    this.partial = "";
  }
}
