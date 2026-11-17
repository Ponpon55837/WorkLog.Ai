import type { BackendErrorCode } from "../backend/errors.js";

/** Errors a retry cannot fix: the database, schema, runtime or port is wrong until the user acts. */
const DETERMINISTIC_PREFIXES = ["DB_", "SCHEMA_", "RUNTIME_"] as const;
const DETERMINISTIC_CODES: ReadonlySet<string> = new Set([
  "PORT_OCCUPIED_BY_OTHER",
  // The OS does not let this user bind it (for example a Windows excluded range): only another port helps.
  "PORT_NOT_PERMITTED",
  "REPAIR_REQUIRED",
  // Only the user can resolve it: remove the old service, or say "仍要啟動".
  "LEGACY_SERVICE_ACTIVE",
]);

/** Whether retrying an unchanged start can only fail the same way. */
export function isDeterministicFailure(code: BackendErrorCode | string): boolean {
  return DETERMINISTIC_CODES.has(code) || DETERMINISTIC_PREFIXES.some((prefix) => code.startsWith(prefix));
}

export type RestartDecision =
  | {
      readonly retry: true;
      /** 1-based attempt number within the window. */ readonly attempt: number;
      readonly delayMs: number;
    }
  | { readonly retry: false; readonly reason: "deterministic" | "exhausted" };

export interface RestartPolicyOptions {
  readonly clock: () => number;
  /** At most this many automatic retries inside `windowMs` (R4 section 6 point 4: 3 in 2 minutes). */
  readonly maxAttempts?: number;
  readonly windowMs?: number;
  /** Wait before attempt 1, 2, 3...; the last value repeats. */
  readonly delaysMs?: readonly number[];
}

/**
 * Bounded automatic retry after an unexpected exit: up to 3 attempts per 2-minute window with a growing delay, and none
 * at all for an error a retry cannot fix. The clock is injected, so the window is testable without waiting.
 */
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

  /** Decides what to do about a failure with `code`; a granted retry is counted at once. */
  decide(code: BackendErrorCode | string): RestartDecision {
    if (isDeterministicFailure(code)) return { retry: false, reason: "deterministic" };
    const now = this.clock();
    this.attempts = this.attempts.filter((at) => now - at < this.windowMs);
    if (this.attempts.length >= this.maxAttempts) return { retry: false, reason: "exhausted" };
    this.attempts.push(now);
    const attempt = this.attempts.length;
    return { retry: true, attempt, delayMs: this.delaysMs[Math.min(attempt, this.delaysMs.length) - 1] ?? 0 };
  }

  /** A start that stayed healthy (or a manual retry by the user) begins a fresh budget. */
  reset(): void {
    this.attempts = [];
  }
}
