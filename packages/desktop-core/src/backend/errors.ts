import { DESKTOP_BACKEND_ERROR_CODES, type DesktopBackendErrorCode } from "@work-intelligence/schema";
import { RUNTIME_ERROR_CODES, type RuntimeErrorCode } from "../runtime/errors.js";

/**
 * The one list of backend error codes: the ones the server child reports over the private channel (R4 section 8.1, in
 * `@work-intelligence/schema`) plus every reason the runtime itself can be refused, which the supervisor reports as is
 * so the true cause reaches the logs, the repair window and diagnostics.
 */
export const BACKEND_ERROR_CODES = [...DESKTOP_BACKEND_ERROR_CODES, ...RUNTIME_ERROR_CODES] as const;

export type BackendErrorCode = DesktopBackendErrorCode | RuntimeErrorCode;

/** A failure while bringing the backend up or down: a code the shell maps to one next step, and a path-free detail. */
export class BackendFailure extends Error {
  readonly code: BackendErrorCode;
  readonly detail: string;

  constructor(code: BackendErrorCode, detail: string, options?: { cause?: unknown }) {
    super(`${code}: ${detail}`, options);
    this.name = "BackendFailure";
    this.code = code;
    this.detail = detail;
  }
}

/** The code of a thrown {@link BackendFailure}, or `fallback` for any other error. */
export function backendErrorCode(error: unknown, fallback: BackendErrorCode = "REPAIR_REQUIRED"): BackendErrorCode {
  return error instanceof BackendFailure ? error.code : fallback;
}
