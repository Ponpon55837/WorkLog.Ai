import type { BackendErrorCode } from "../backend/errors.js";

const DETERMINISTIC_PREFIXES = ["DB_", "SCHEMA_", "RUNTIME_"] as const;
const DETERMINISTIC_CODES: ReadonlySet<string> = new Set([
  "PORT_OCCUPIED_BY_OTHER",
  // A Windows excluded port range refuses the bind on every retry; only another port helps.
  "PORT_NOT_PERMITTED",
  "REPAIR_REQUIRED",
  "LEGACY_SERVICE_ACTIVE",
]);

export function isDeterministicFailure(code: BackendErrorCode | string): boolean {
  return DETERMINISTIC_CODES.has(code) || DETERMINISTIC_PREFIXES.some((prefix) => code.startsWith(prefix));
}

export type RestartDecision =
  | {
      readonly retry: true;
      readonly attempt: number;
      readonly delayMs: number;
    }
  | { readonly retry: false; readonly reason: "deterministic" | "exhausted" };

export interface RestartPolicyOptions {
  readonly clock: () => number;
  readonly maxAttempts?: number;
  readonly windowMs?: number;
  readonly delaysMs?: readonly number[];
}

export class RestartPolicy {
  private readonly clock: () => number;
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly delaysMs: readonly number[];
  private attempts: number[] = [];

  constructor(options: RestartPolicyOptions) {
    this.clock = options.clock;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.windowMs = options.windowMs ?? 120_000;
    this.delaysMs = options.delaysMs ?? [1_000, 5_000, 15_000];
  }

  decide(code: BackendErrorCode | string): RestartDecision {
    if (isDeterministicFailure(code)) return { retry: false, reason: "deterministic" };
    const now = this.clock();
    this.attempts = this.attempts.filter((at) => now - at < this.windowMs);
    if (this.attempts.length >= this.maxAttempts) return { retry: false, reason: "exhausted" };
    this.attempts.push(now);
    const attempt = this.attempts.length;
    return { retry: true, attempt, delayMs: this.delaysMs[Math.min(attempt, this.delaysMs.length) - 1] ?? 0 };
  }

  reset(): void {
    this.attempts = [];
  }
}
