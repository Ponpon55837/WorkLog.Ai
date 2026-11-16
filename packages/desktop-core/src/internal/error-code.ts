/** The Node.js `code` of a thrown error (`ENOENT`, `EACCES`, ...), or undefined when it has none. */
export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null ? (error as { code?: string }).code : undefined;
}

/** Whether `error` says the path does not exist. */
export function isMissingError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}
