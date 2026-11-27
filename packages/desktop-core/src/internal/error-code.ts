export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null ? (error as { code?: string }).code : undefined;
}

export function isMissingError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}
