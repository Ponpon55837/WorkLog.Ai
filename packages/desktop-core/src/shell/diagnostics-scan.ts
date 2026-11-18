import { emptyDiagnosticsCounts, type DiagnosticsCategory, type DiagnosticsCounts } from "./diagnostics-redact.js";

/** What a scan puts in place of what it found. */
export const SCAN_MASK = "[scan-masked]";

export interface ScanRule {
  readonly category: DiagnosticsCategory;
  /** Global; the whole match is replaced. */
  readonly pattern: RegExp;
  /** The replacement; {@link SCAN_MASK} unless a test needs another. */
  readonly mask?: string;
}

export interface ScanResult {
  readonly text: string;
  /** What this pass found (and masked), per category. */
  readonly found: DiagnosticsCounts;
  readonly total: number;
}

// An independent pattern set: written apart from the redactor's, broader where a miss would leak, and never aware of
// how the redactor works. It looks for what must not be left in the redacted text; the redactor's own markers
// (`[redacted…]`) are not findings. Every pattern is fixed and linear (a lookbehind anchors a run, repeats are bounded).
const NOT_REDACTED = String.raw`(?!\[redacted)`;

// The characters that end a path: a quote, a closing bracket, a separator of a list, an angle bracket, the end of the line.
const HARD = String.raw`"'\x60)\]},;|<>\r\n`;
const PATH_TAIL = String.raw`[^\s${HARD}][^${HARD}]*`;
// Not right after a letter or digit (a URL path, a relative path) or a separator; `file:///` is a local path.
const POSIX_START = String.raw`(?:(?<![A-Za-z0-9_.~)\]/\\-])|(?<=file://))`;
const POSIX_DIRECTORIES = "Users|home|Volumes|private|var|tmp|mnt|media|opt|srv|run|Library|Applications";

/** The second pass over redacted text: anything it finds is a path, code or token the first pass missed. */
export const SCAN_RULES: readonly ScanRule[] = [
  // Paths of any user: drive-letter, POSIX (home and the other absolute folders), tilde and share forms, plain or
  // JSON-escaped. Like the redactor's, a path runs to the end of the line or a hard delimiter, spaces included.
  { category: "paths", pattern: new RegExp(String.raw`(?<![A-Za-z0-9])[A-Za-z]:[\\/]+${PATH_TAIL}`, "g") },
  {
    category: "paths",
    pattern: new RegExp(
      String.raw`${POSIX_START}/(?:root(?![A-Za-z0-9_.-])[^${HARD}]*|(?:${POSIX_DIRECTORIES})/${PATH_TAIL})`,
      "gi",
    ),
  },
  { category: "paths", pattern: new RegExp(String.raw`(?<![A-Za-z0-9_.])~[/\\]${PATH_TAIL}`, "g") },
  {
    category: "paths",
    pattern: new RegExp(String.raw`(?<![\\:A-Za-z0-9_.])\\{2,4}[A-Za-z0-9_.$-]{1,255}\\+${PATH_TAIL}`, "g"),
  },
  // One-time codes: a secret query or fragment parameter, the App's handoff fragment, a fragment of an address.
  {
    category: "authCodes",
    pattern: new RegExp(
      String.raw`[?&#;](?:access_token|refresh_token|id_token|client_secret|api_?key|signature|session_?id|session|password|secret|ticket|token|auth|authorization|code|state|nonce|otp|sig|key)=${NOT_REDACTED}[^\s&#"']+`,
      "gi",
    ),
  },
  { category: "authCodes", pattern: new RegExp(String.raw`wi-handoff=${NOT_REDACTED}[^\s"']+`, "g") },
  { category: "authCodes", pattern: /#(?<=:\/\/[^\s"'<>#]{0,256}#)(?!\[redacted\])[^\s"'<>]+/g },
  // Credentials in an address, key blocks and every well-known token shape.
  { category: "tokens", pattern: /:\/\/(?!\[redacted\]@)[^\s/@"'<>]{1,128}@/g },
  { category: "tokens", pattern: /-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g },
  { category: "tokens", pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g },
  { category: "tokens", pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}/g },
  { category: "tokens", pattern: /xox[a-z]-[A-Za-z0-9-]{6,}/g },
  { category: "tokens", pattern: /gh[pousr]_[A-Za-z0-9]{6,}|github_pat_[A-Za-z0-9_]{6,}/g },
  { category: "tokens", pattern: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{6,}/g },
  { category: "tokens", pattern: new RegExp(String.raw`Bearer[ \t]+${NOT_REDACTED}[^\s"']+`, "gi") },
  {
    category: "tokens",
    pattern: new RegExp(
      String.raw`(?:(?:token|secret|password|passwd|passphrase|pwd|credentials?|authorization|cookie|api[-_]?key)[A-Za-z0-9_.-]{0,32}["']?[ \t]{0,8}|(?<![A-Za-z0-9_])pass["']?)[:=][ \t]{0,8}["']?${NOT_REDACTED}[^\s"',;&}\]]+`,
      "gi",
    ),
  },
  // Standard base64 and long hex or key-like runs (the first pass stops at `/` and `+`).
  { category: "tokens", pattern: /[A-Za-z0-9+/=_-]{40,}/g },
  {
    category: "emails",
    pattern: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,1024}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g,
  },
];

/** Step 3, scan: finds what the redactor missed, masks it and counts it per category. The text is never returned in a count. */
export function scanText(text: string, rules: readonly ScanRule[] = SCAN_RULES): ScanResult {
  const found = emptyDiagnosticsCounts();
  let result = text;
  for (const rule of rules) {
    result = result.replace(rule.pattern, () => {
      found[rule.category] += 1;
      return rule.mask ?? SCAN_MASK;
    });
  }
  return { text: result, found, total: found.paths + found.authCodes + found.tokens + found.emails };
}
