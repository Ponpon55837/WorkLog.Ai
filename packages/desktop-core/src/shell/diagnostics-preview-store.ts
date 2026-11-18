import { randomUUID } from "node:crypto";

/** How long a previewed text waits for the user to save it. */
export const DIAGNOSTICS_PREVIEW_TTL_MS = 10 * 60 * 1000;

interface Held {
  readonly previewId: string;
  readonly bytes: Buffer;
  readonly expiresAt: number;
}

/** A previewed text taken for saving: the exact bytes, and a way to hand it back when the save did not happen. */
export interface DiagnosticsClaim {
  readonly bytes: Buffer;
  /** The user cancelled the dialog: the same preview may be saved again, until it expires or is replaced. */
  release(): void;
}

export interface DiagnosticsPreviewStoreOptions {
  /** Milliseconds clock; injected for tests. */
  readonly clock: () => number;
  readonly ttlMs?: number;
  /** A new unguessable id; injected for tests. */
  readonly newId?: () => string;
}

/**
 * The previews main keeps in memory only: one live preview per sender (a new one replaces the old), bound to that
 * sender, gone after the time limit and single-use. The saved file is the previewed bytes and nothing built again, so
 * what the user read is what lands on disk. An id that is unknown, expired, already used or made for another sender
 * all look the same: no claim.
 */
export class DiagnosticsPreviewStore {
  private readonly clock: () => number;
  private readonly ttlMs: number;
  private readonly newId: () => string;
  private readonly held = new Map<number, Held>();

  constructor(options: DiagnosticsPreviewStoreOptions) {
    this.clock = options.clock;
    this.ttlMs = options.ttlMs ?? DIAGNOSTICS_PREVIEW_TTL_MS;
    this.newId = options.newId ?? randomUUID;
  }

  /** Keeps `text` for `senderId` and returns its id; the sender's earlier preview is gone. */
  put(senderId: number, text: string): string {
    this.pruneExpired();
    const previewId = this.newId();
    this.held.set(senderId, { previewId, bytes: Buffer.from(text, "utf8"), expiresAt: this.clock() + this.ttlMs });
    return previewId;
  }

  /** Takes the preview of `previewId` for `senderId` (single use), or undefined when it cannot be taken. */
  claim(senderId: number, previewId: string): DiagnosticsClaim | undefined {
    this.pruneExpired();
    const entry = this.held.get(senderId);
    if (entry === undefined || entry.previewId !== previewId) return undefined;
    this.held.delete(senderId);
    return {
      bytes: entry.bytes,
      release: () => {
        // A newer preview of the same sender wins; an expired one is not brought back.
        if (!this.held.has(senderId) && this.clock() < entry.expiresAt) this.held.set(senderId, entry);
      },
    };
  }

  private pruneExpired(): void {
    const now = this.clock();
    for (const [senderId, entry] of this.held) if (now >= entry.expiresAt) this.held.delete(senderId);
  }
}
