import { DESKTOP_BACKEND_ERROR_CODES, type DesktopBackendErrorCode } from "@work-intelligence/schema";

/**
 * The one list of backend error codes (R4 section 8.1 and the supervisor's own checks). It lives in
 * `@work-intelligence/schema` because the server child reports the same codes over the private channel.
 */
export const BACKEND_ERROR_CODES = DESKTOP_BACKEND_ERROR_CODES;

export type BackendErrorCode = DesktopBackendErrorCode;

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
