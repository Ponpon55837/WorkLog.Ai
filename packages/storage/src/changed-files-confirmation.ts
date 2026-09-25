/** Returns whether stored changed-files metadata is valid and explicitly confirmed. */
export function isChangedFilesMetadataConfirmed(value: string | null, confirmed: number | undefined): boolean {
  try {
    const parsed: unknown = JSON.parse(value ?? "null");
    return (
      Array.isArray(parsed) &&
      parsed.every((item) => typeof item === "string") &&
      (parsed.length > 0 || confirmed === 1)
    );
  } catch {
    return false;
  }
}
