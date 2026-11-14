// Realistic, non-adversarial text for timing a machine through redactText (see tests/helpers/timing.ts). Fictional only.
const REFERENCE_LINES = [
  "The tokenizer splits text before the model counts tokens; secretary notes list who owns each password reset.",
  "設定頁會要求輸入密碼，權杖用量顯示在右上角。Commit 3f2a9c1d7b4e5f60718293a4b5c6d7e8f9012345 fixed it.",
  "Use --token only in CI. Keep API keys out of logs: see docs/security.md and the key rotation checklist.",
  "DB_PASSWORD=hunter2hunter2 Authorization: Bearer abcdEFGH12345 ?api_key=abcdEFGH12345 ",
].join("\n");

/** Ordinary prose with a few secrets, repeated to exactly `length` characters. */
export function redactionReferenceText(length: number): string {
  return REFERENCE_LINES.repeat(Math.ceil(length / REFERENCE_LINES.length)).slice(0, length);
}
