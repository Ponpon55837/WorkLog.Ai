/** Stable codes for every way a runtime can be refused; the launcher prints them and the App maps them to repair steps. */
export const RUNTIME_ERROR_CODES = [
  "RUNTIME_POINTER_MISSING",
  "RUNTIME_POINTER_INVALID",
  "RUNTIME_MANIFEST_INVALID",
  "RUNTIME_FILE_MISSING",
  "RUNTIME_FILE_UNEXPECTED",
  "RUNTIME_FILE_TAMPERED",
  "RUNTIME_SYMLINK_REJECTED",
  "RUNTIME_ACTION_NOT_ALLOWED",
  "RUNTIME_KIND_NOT_ALLOWED",
  "RUNTIME_UNSAFE_PERMISSIONS",
  "RUNTIME_ACL_UNREADABLE",
  "RUNTIME_ALREADY_INSTALLED",
  "RUNTIME_BUNDLE_INVALID",
  "RUNTIME_INSTALL_FAILED",
  /** The runtime directory to replace is held by a running process (an Agent on Windows): close it and retry. */
  "RUNTIME_IN_USE",
] as const;

/** One of {@link RUNTIME_ERROR_CODES}. */
export type RuntimeErrorCode = (typeof RUNTIME_ERROR_CODES)[number];

/**
 * Errors that mean the installed files are wrong (damaged, replaced, incomplete): a clean reinstall fixes them. Anything
 * else (permissions, an ACL that cannot be read, a bad pointer) is not fixed by copying again and goes to the repair flow.
 */
export const REINSTALLABLE_CODES: ReadonlySet<string> = new Set<RuntimeErrorCode>([
  "RUNTIME_FILE_TAMPERED",
  "RUNTIME_MANIFEST_INVALID",
  "RUNTIME_FILE_MISSING",
  "RUNTIME_FILE_UNEXPECTED",
  "RUNTIME_SYMLINK_REJECTED",
]);

/** What a refusal is about: the offending file and what was expected versus found. */
export interface RuntimeErrorDetail {
  readonly file?: string;
  readonly expected?: string;
  readonly actual?: string;
}

const REPAIR_HINT = "請從 App 重新安裝 runtime。";

/** A runtime that must not be launched. The message names the file and says how to repair it. */
export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  readonly detail: RuntimeErrorDetail;

  constructor(code: RuntimeErrorCode, summary: string, detail: RuntimeErrorDetail = {}, options?: { cause?: unknown }) {
    super(formatMessage(code, summary, detail), options);
    this.name = "RuntimeError";
    this.code = code;
    this.detail = detail;
  }
}

function formatMessage(code: RuntimeErrorCode, summary: string, detail: RuntimeErrorDetail): string {
  const parts = [`${code}: ${summary}`];
  if (detail.file !== undefined) parts.push(`檔案：${detail.file}`);
  if (detail.expected !== undefined) parts.push(`預期：${detail.expected}`);
  if (detail.actual !== undefined) parts.push(`實際：${detail.actual}`);
  parts.push(REPAIR_HINT);
  return parts.join("；");
}

/** The error code of any thrown value, or undefined when it is not a {@link RuntimeError}. */
export function runtimeErrorCode(error: unknown): RuntimeErrorCode | undefined {
  return error instanceof RuntimeError ? error.code : undefined;
}
