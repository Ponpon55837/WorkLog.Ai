import { SecretMasker } from "../backend/ring-buffer.js";

/** What a mask hid; the diagnostics report counts these and never shows a value. */
export type DiagnosticsCategory = "paths" | "authCodes" | "tokens" | "emails";
export type DiagnosticsCounts = Record<DiagnosticsCategory, number>;

export function emptyDiagnosticsCounts(): DiagnosticsCounts {
  return { paths: 0, authCodes: 0, tokens: 0, emails: 0 };
}

export interface RedactionContext {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly userName?: string;
  /** Database, real database, backup and log paths. */
  readonly paths?: readonly (string | undefined)[];
  /** Exact secrets such as the run id. */
  readonly secrets?: readonly (string | undefined)[];
}

/** A redactor that remembers how much it masked, per category, across every call. */
export interface CountingRedactor {
  redact(text: string): string;
  readonly counts: Readonly<DiagnosticsCounts>;
}

const REDACTED = "[redacted]";
const REDACTED_PATH = "[redacted path]";
const REDACTED_EMAIL = "[redacted email]";

// Every pattern below is fixed (never built from input) and linear: a pattern that starts with a run of characters is
// anchored by a lookbehind so a long run is scanned from its start only, repetitions are bounded or end the pattern, and
// the two constructs that would rescan (a PEM block, a URL fragment) are plain string searches.

/**
 * A key name that marks its value as a secret; a longer name keeps its prefix because only the value is replaced. `pass`
 * counts only as the whole key word written `pass=` / `pass:` (no space before the sign), so "passed" and "pass rate"
 * in prose are left alone.
 */
const SECRET_PAIR =
  /((?:(?:token|secret|password|passwd|passphrase|pwd|credentials?|authorization|cookie|api[-_]?key)[A-Za-z0-9_.-]{0,32}(?:\\?["'])?[ \t]{0,8}|(?<![A-Za-z0-9_])pass(?:\\?["'])?)[:=][ \t]{0,8})(\\"[^"\\]{0,4096}\\"|"(?:[^"\\]|\\.){0,4096}"|'[^'\n]{0,4096}'|(?:(?:Bearer|Basic|Token)[ \t]+)?[^\s,;&"'}\]\\]+|["'][^"'\s]*)/gi;

/** `?code=`, `&access_token=`, `#state=` and the like: the parameter stays, its value goes. */
const QUERY_SECRET =
  /([?&#;](?:access_token|refresh_token|id_token|client_secret|api_?key|signature|session_?id|session|password|secret|ticket|token|auth|authorization|code|state|nonce|otp|sig|key)=)[^\s&#"'<>;]*/gi;

/** The App's own one-time fragment after a port change (`wi-handoff=<base64url>`), wherever it appears. */
const HANDOFF_FRAGMENT = /(wi-handoff=)[A-Za-z0-9_-]*/g;

/** `scheme://user:password@host`: the credentials before the `@`. */
const URL_CREDENTIALS = /(:\/\/)[^\s/@"'<>]{1,256}@/g;

const JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]*/g;
const AWS_KEY = /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g;
const SLACK_TOKEN = /\bxox[abprs]-[A-Za-z0-9-]{8,}/g;
const BEARER = /\bBearer[ \t]{1,16}[A-Za-z0-9._~+/=-]+/gi;

/** Well-known token shapes, whatever precedes them. */
const TOKEN_PATTERNS: readonly RegExp[] = [
  AWS_KEY,
  SLACK_TOKEN,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  // A long unbroken run of URL-safe base64 or hex characters is a key, a run id or a hash, not prose.
  /[A-Za-z0-9_-]{32,}/g,
];

// A path segment: no separator, space, quote or character a file name cannot hold. JSON writes a backslash twice, so
// a separator is one or two backslashes or a slash.
const SEGMENT = String.raw`[^\\/\s"'<>|:*?,;]`;
const SEPARATOR = String.raw`(?:\\{1,2}|/)`;
// What may stand right before an absolute POSIX path: not a letter or digit (a URL path or a relative path), not a
// separator. `file:///` is the one URL whose path is a local path.
const POSIX_START = String.raw`(?:(?<![A-Za-z0-9_.~)\]/\\-])|(?<=file://))`;
const POSIX_DIRECTORIES = "Users|home|Volumes|private|var|tmp|mnt|media|opt|srv|run|Library|Applications";
const AFTER_DIRECTORY = String.raw`(?=[^\s/\\"'\x60)\]},;|<>])`;

/**
 * Where a path starts. Only the start is a pattern: the rest runs to the end of the line or a hard delimiter, spaces
 * included ({@link pathEnd}), because a folder name may hold spaces ("Application Support"). Drive-letter paths on any
 * drive, `/Users`, `/home`, `/root`, `/Volumes`, `/private`, `/var`, `/tmp`, `/mnt`, `/media`, `/opt`, `/srv`, `/run`,
 * `/Library`, `/Applications`, `~/`, and shares (`\\host\share`, also `\\wsl$\…`); plain or JSON-escaped. A path inside an
 * http(s) address or a relative path is not a start. The directory names are case-insensitive where the file system is.
 */
function pathStartSource(): string {
  return [
    String.raw`(?<![A-Za-z0-9])[A-Za-z]:${SEPARATOR}(?=${SEGMENT})`,
    String.raw`${POSIX_START}/(?:root(?![A-Za-z0-9_.-])|(?:${POSIX_DIRECTORIES})/${AFTER_DIRECTORY})`,
    String.raw`(?<![A-Za-z0-9_.])~[/\\](?=${SEGMENT})`,
    String.raw`(?<![\\:A-Za-z0-9_.])\\{2,4}[A-Za-z0-9_.$-]+\\{1,2}(?=${SEGMENT})`,
  ].join("|");
}

interface PathStarts {
  readonly scan: RegExp;
  readonly at: RegExp;
}

/** The start pattern, global to walk a text, and the same pattern sticky to ask whether a path starts at one place. */
function pathStartPatterns(platform: NodeJS.Platform): PathStarts {
  const flags = platform === "win32" || platform === "darwin" ? "i" : "";
  return { scan: new RegExp(pathStartSource(), `${flags}g`), at: new RegExp(pathStartSource(), `${flags}y`) };
}

/** A start that ends in a user folder: what follows is the user's name, which may hold spaces. */
const HOME_START = /(?:Users|home|Documents and Settings)[\\/]+$/i;
const HARD_DELIMITERS = new Set(['"', "'", "`", ")", "]", "}", ",", ";", "|", "<", ">", "\r", "\n"]);
const FILE_EXTENSION_BEFORE = /\.[A-Za-z0-9]{1,8}$/;
const MAX_EXTENSION_LOOKBACK = 9;

function isSeparator(character: string): boolean {
  return character === "/" || character === "\\";
}

/**
 * Where the path that starts before `from` ends: at the end of the line or the first hard delimiter, spaces included.
 * A quote ends it (a trailing backslash is the escape of that quote and stays out), and so does trailing white space.
 * The last component is the one place a space may be the end of the path and not a part of it: it ends at the first space
 * after a file extension ("notes.md now"), and, when it has no extension at its end, at its first space ("ClientX now");
 * a user's name right after the home folder runs through its spaces. One pass, each character read a few times at most.
 */
function pathEnd(text: string, from: number, afterHome: boolean, startsAt: RegExp): number {
  let end = from;
  while (end < text.length && !HARD_DELIMITERS.has(text.charAt(end))) {
    // Another path after a space is a path of its own: this one ends before it.
    if (text.charAt(end - 1) === " " || text.charAt(end - 1) === "\t") {
      startsAt.lastIndex = end;
      if (end > from && startsAt.test(text)) break;
    }
    end += 1;
  }
  if (text.charAt(end) === '"') while (end > from && text.charAt(end - 1) === "\\") end -= 1;
  while (end > from && /\s/.test(text.charAt(end - 1))) end -= 1;

  let start = end;
  while (start > from && !isSeparator(text.charAt(start - 1))) start -= 1;
  if (start === from && afterHome) return end;
  for (let index = start; index < end; index += 1) {
    if (text.charAt(index) !== " " && text.charAt(index) !== "\t") continue;
    if (FILE_EXTENSION_BEFORE.test(text.slice(Math.max(start, index - MAX_EXTENSION_LOOKBACK), index))) return index;
  }
  if (FILE_EXTENSION_BEFORE.test(text.slice(Math.max(start, end - MAX_EXTENSION_LOOKBACK), end))) return end;
  for (let index = start; index < end; index += 1)
    if (text.charAt(index) === " " || text.charAt(index) === "\t") return index;
  return end;
}

/** Masks every path: its start is found by `start`, its end by {@link pathEnd}. */
function maskPaths(text: string, start: PathStarts, onMask: () => void): string {
  let output = "";
  let cursor = 0;
  const walk = start.scan;
  walk.lastIndex = 0;
  for (let match = walk.exec(text); match; match = walk.exec(text)) {
    const end = pathEnd(text, match.index + match[0].length, HOME_START.test(match[0]), start.at);
    output += `${text.slice(cursor, match.index)}${REDACTED_PATH}`;
    cursor = end;
    walk.lastIndex = end;
    onMask();
  }
  return output + text.slice(cursor);
}

// Up to 1024 characters before the `@`: an address glued to a longer run is still found, and the scan finds the rest.
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,1024}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+/g;

/** The fragment of an address ends at the first space, quote or angle bracket. */
function isFragmentBoundary(character: string): boolean {
  return /[\s"'<>]/.test(character);
}

/** Masks the `#fragment` of every `scheme://…#fragment`; a bare `#` in prose (a heading, an issue number) stays. */
function maskUrlFragments(text: string, onMask: () => void): string {
  const MAX_ADDRESS = 2048;
  let output = "";
  let cursor = 0;
  let hash = text.indexOf("#");
  while (hash >= 0) {
    // The address before the `#`, bounded and never reaching back past another `#`, so a run of them stays linear.
    let start = hash;
    while (
      start > 0 &&
      hash - start < MAX_ADDRESS &&
      !isFragmentBoundary(text.charAt(start - 1)) &&
      text.charAt(start - 1) !== "#"
    )
      start -= 1;
    if (!text.slice(start, hash).includes("://")) {
      hash = text.indexOf("#", hash + 1);
      continue;
    }
    let end = hash + 1;
    while (end < text.length && !isFragmentBoundary(text.charAt(end))) end += 1;
    if (end > hash + 1) {
      output += `${text.slice(cursor, hash + 1)}${REDACTED}`;
      cursor = end;
      onMask();
    }
    hash = text.indexOf("#", end);
  }
  return output + text.slice(cursor);
}

const PEM_BEGIN = "-----BEGIN ";
const PEM_END = "-----END ";
const PEM_DASHES = "-----";
const MAX_PEM_LABEL = 64;

/**
 * Masks every `-----BEGIN … PRIVATE KEY-----` block up to its END line. A block whose END line is missing (a cut line)
 * is masked to the end of the text: what follows a private key header is never shown. A string search, not a lazy
 * pattern, so a text of repeated headers does not rescan to its end from each one.
 */
function maskPemBlocks(text: string, onMask: () => void): string {
  let output = "";
  let cursor = 0;
  let begin = text.indexOf(PEM_BEGIN);
  while (begin >= 0) {
    const labelStart = begin + PEM_BEGIN.length;
    const labelEnd = text.indexOf(PEM_DASHES, labelStart);
    const label = labelEnd < 0 || labelEnd - labelStart > MAX_PEM_LABEL ? "" : text.slice(labelStart, labelEnd);
    if (!label.endsWith("PRIVATE KEY") && !label.endsWith("PRIVATE KEY BLOCK")) {
      begin = text.indexOf(PEM_BEGIN, labelStart);
      continue;
    }
    const endLine = text.indexOf(PEM_END, labelEnd + PEM_DASHES.length);
    const endClose = endLine < 0 ? -1 : text.indexOf(PEM_DASHES, endLine + PEM_END.length);
    const blockEnd = endClose < 0 ? text.length : endClose + PEM_DASHES.length;
    output += `${text.slice(cursor, begin)}${REDACTED}`;
    cursor = blockEnd;
    onMask();
    begin = text.indexOf(PEM_BEGIN, blockEnd);
  }
  return output + text.slice(cursor);
}

/** JSON writes a backslash twice, so a Windows path inside a JSON string is a different text than the path itself. */
function withJsonEscapedForm(value: string): string[] {
  const escaped = value.replaceAll("\\", "\\\\");
  return escaped === value ? [value] : [value, escaped];
}

function maskerFor(values: readonly (string | undefined)[], platform: NodeJS.Platform): SecretMasker {
  // Windows and macOS (APFS by default) file systems do not tell `/Users/Alice` from `/users/alice`.
  const masker = new SecretMasker({ caseInsensitive: platform === "win32" || platform === "darwin" });
  for (const value of values) {
    if (!value) continue;
    for (const form of withJsonEscapedForm(value)) masker.add(form);
  }
  return masker;
}

/**
 * Step 2, redact: builds a function that masks, in any text: the exact secrets and known paths (case-insensitive and
 * with either slash on Windows and macOS), any user's path (home folders and the other absolute paths, drive-letter paths, UNC paths, to the end of the line or a hard delimiter), e-mail addresses,
 * private-key blocks, JWTs, AWS, Slack, GitHub and OpenAI-style keys, secret-looking values by key name, query-string
 * and fragment secrets, the App's one-time handoff fragment, and long key-like runs. Known values are searched as plain
 * strings; every pattern is fixed and never built from input.
 */
export function createCountingRedactor(context: RedactionContext): CountingRedactor {
  const secrets = maskerFor(context.secrets ?? [], context.platform);
  const knownPaths = maskerFor(context.paths ?? [], context.platform);
  const personal = maskerFor([context.homeDirectory, context.userName], context.platform);
  const counts = emptyDiagnosticsCounts();
  const pathStart = pathStartPatterns(context.platform);

  function replaceCounted(text: string, pattern: RegExp, category: DiagnosticsCategory, replacement: string): string {
    return text.replace(pattern, (match: string, prefix?: string) => {
      counts[category] += 1;
      return typeof prefix === "string" ? `${prefix}${replacement}` : replacement;
    });
  }

  function mask(masker: SecretMasker, text: string, category: DiagnosticsCategory): string {
    const result = masker.applyCounted(text);
    counts[category] += result.replaced;
    return result.line;
  }

  function redact(text: string): string {
    let result = mask(secrets, text, "tokens");
    result = mask(knownPaths, result, "paths");
    result = maskPemBlocks(result, () => (counts.tokens += 1));
    result = maskUrlFragments(result, () => (counts.authCodes += 1));
    result = replaceCounted(result, HANDOFF_FRAGMENT, "authCodes", REDACTED);
    result = replaceCounted(result, QUERY_SECRET, "authCodes", REDACTED);
    result = replaceCounted(result, URL_CREDENTIALS, "tokens", `${REDACTED}@`);
    // Any user's home before the current user's own values, so a whole path goes and not only its first part.
    result = maskPaths(result, pathStart, () => (counts.paths += 1));
    result = mask(personal, result, "paths");
    result = replaceCounted(result, EMAIL, "emails", REDACTED_EMAIL);
    result = result.replace(SECRET_PAIR, (match: string, key: string, value: string) => {
      // A value an earlier step already replaced is neither replaced again nor counted again.
      if (value.replace(/^\\?["']/, "").startsWith("[redacted")) return match;
      counts.tokens += 1;
      return `${key}${REDACTED}`;
    });
    result = replaceCounted(result, JWT, "tokens", REDACTED);
    result = result.replace(BEARER, () => {
      counts.tokens += 1;
      return `Bearer ${REDACTED}`;
    });
    for (const pattern of TOKEN_PATTERNS) result = replaceCounted(result, pattern, "tokens", REDACTED);
    return result;
  }

  return { redact, counts };
}

/** The text-to-text form of {@link createCountingRedactor}. */
export function createRedactor(context: RedactionContext): (text: string) => string {
  const redactor = createCountingRedactor(context);
  return (text) => redactor.redact(text);
}
