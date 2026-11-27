import { randomUUID } from "node:crypto";

export const DIAGNOSTICS_PREVIEW_TTL_MS = 10 * 60 * 1000;

interface Held {
  readonly previewId: string;
  readonly bytes: Buffer;
  readonly expiresAt: number;
}

export interface DiagnosticsClaim {
  readonly bytes: Buffer;
  release(): void;
}

export interface DiagnosticsPreviewStoreOptions {
  readonly clock: () => number;
  readonly ttlMs?: number;
  readonly newId?: () => string;
}

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

  put(senderId: number, text: string): string {
    this.pruneExpired();
    const previewId = this.newId();
    this.held.set(senderId, { previewId, bytes: Buffer.from(text, "utf8"), expiresAt: this.clock() + this.ttlMs });
    return previewId;
  }

  claim(senderId: number, previewId: string): DiagnosticsClaim | undefined {
    this.pruneExpired();
    const entry = this.held.get(senderId);
    if (entry === undefined || entry.previewId !== previewId) return undefined;
    this.held.delete(senderId);
    return {
      bytes: entry.bytes,
      release: () => {
        if (!this.held.has(senderId) && this.clock() < entry.expiresAt) this.held.set(senderId, entry);
      },
    };
  }

  private pruneExpired(): void {
    const now = this.clock();
    for (const [senderId, entry] of this.held) if (now >= entry.expiresAt) this.held.delete(senderId);
  }
}
