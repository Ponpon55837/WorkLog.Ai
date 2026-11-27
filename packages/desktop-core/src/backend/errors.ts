import { DESKTOP_BACKEND_ERROR_CODES, type DesktopBackendErrorCode } from "@work-intelligence/schema";
import { RUNTIME_ERROR_CODES, type RuntimeErrorCode } from "../runtime/errors.js";

export const BACKEND_ERROR_CODES = [...DESKTOP_BACKEND_ERROR_CODES, ...RUNTIME_ERROR_CODES] as const;

export type BackendErrorCode = DesktopBackendErrorCode | RuntimeErrorCode;

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

export function backendErrorCode(error: unknown, fallback: BackendErrorCode = "REPAIR_REQUIRED"): BackendErrorCode {
  return error instanceof BackendFailure ? error.code : fallback;
}
