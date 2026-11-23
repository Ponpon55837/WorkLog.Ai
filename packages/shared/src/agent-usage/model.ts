const MODEL_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,63}$/;
const DRIVE_PREFIX = /^[A-Za-z]:/;
const MODEL_MAX_LENGTH = 96;
/** First segments that mean a file-system location, not a provider. */
const PATH_ROOTS = new Set([
  "users",
  "home",
  "root",
  "var",
  "tmp",
  "private",
  "mnt",
  "media",
  "opt",
  "usr",
  "etc",
  "volumes",
  "library",
  "srv",
]);

/**
 * Returns the value when it looks like a model id (`claude-sonnet-4-5`, `openrouter/some-model`) and "" otherwise.
 * An allowlist, so a log field that holds a path or free text can never reach a report.
 */
export function safeModelId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MODEL_MAX_LENGTH) return "";
  if (value.includes("..") || DRIVE_PREFIX.test(value)) return "";
  const segments = value.split("/");
  if (segments.length > 2 || !segments.every((segment) => MODEL_SEGMENT.test(segment))) return "";
  if (segments.length === 2 && PATH_ROOTS.has((segments[0] ?? "").toLowerCase())) return "";
  return value;
}
