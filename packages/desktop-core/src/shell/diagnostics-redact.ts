import { SecretMasker } from "../backend/ring-buffer.js";

export type DiagnosticsCategory = "paths" | "authCodes" | "tokens" | "emails";
export type DiagnosticsCounts = Record<DiagnosticsCategory, number>;

export function emptyDiagnosticsCounts(): DiagnosticsCounts {
  return { paths: 0, authCodes: 0, tokens: 0, emails: 0 };
}

export interface RedactionContext {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly userName?: string;
  readonly paths?: readonly (string | undefined)[];
  readonly secrets?: readonly (string | undefined)[];
}

export interface CountingRedactor {
  redact(text: string): string;
  readonly counts: Readonly<DiagnosticsCounts>;
}

const REDACTED = "[redacted]";
const REDACTED_PATH = "[redacted path]";
const REDACTED_EMAIL = "[redacted email]";

// Every pattern here is fixed and linear (anchored lookbehinds, bounded repeats); keep it that way to avoid backtracking blowups.
const SECRET_PAIR =
  /((?:(?:token|secret|password|passwd|passphrase|pwd|credentials?|authorization|cookie|api[-_]?key)[A-Za-z0-9_.-]{0,32}(?:\\?["'])?[ \t]{0,8}|(?<![A-Za-z0-9_])pass(?:\\?["'])?)[:=][ \t]{0,8})(\\"[^"\\]{0,4096}\\"|"(?:[^"\\]|\\.){0,4096}"|'[^'\n]{0,4096}'|(?:(?:Bearer|Basic|Token)[ \t]+)?[^\s,;&"'}\]\\]+|["'][^"'\s]*)/gi;

const QUERY_SECRET =
  /([?&#;](?:access_token|refresh_token|id_token|client_secret|api_?key|signature|session_?id|session|password|secret|ticket|token|auth|authorization|code|state|nonce|otp|sig|key)=)[^\s&#"'<>;]*/gi;

const HANDOFF_FRAGMENT = /(wi-handoff=)[A-Za-z0-9_-]*/g;

const URL_CREDENTIALS = /(:\/\/)[^\s/@"'<>]{1,256}@/g;

const JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]*/g;
const AWS_KEY = /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g;
const SLACK_TOKEN = /\bxox[abprs]-[A-Za-z0-9-]{8,}/g;
const BEARER = /\bBearer[ \t]{1,16}[A-Za-z0-9._~+/=-]+/gi;

const TOKEN_PATTERNS: readonly RegExp[] = [
  AWS_KEY,
  SLACK_TOKEN,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /[A-Za-z0-9_-]{32,}/g,
];

// JSON writes a backslash twice, so a separator is one or two backslashes or a slash.
const SEGMENT = String.raw`[^\\/\s"'<>|:*?,;]`;
const SEPARATOR = String.raw`(?:\\{1,2}|/)`;
const POSIX_START = String.raw`(?:(?<![A-Za-z0-9_.~)\]/\\-])|(?<=file://))`;
const POSIX_DIRECTORIES =
  "Users|home|Volumes|private|var|tmp|mnt|media|opt|srv|run|Library|Applications|etc|usr|data|bin|sbin|lib|lib64|snap|nix|proc|sys|dev|boot|workspace|workspaces|projects|repos";
const AFTER_DIRECTORY = String.raw`(?=[^\s/\\"'\x60)\]},;|<>])`;

function pathStartSource(): string {
  return [
    String.raw`(?:(?<![\\:A-Za-z0-9_.])\\{2,4}[?.]\\{1,2})?(?<![A-Za-z0-9])[A-Za-z]:${SEPARATOR}(?=${SEGMENT})`,
    String.raw`${POSIX_START}/(?:root(?![A-Za-z0-9_.-])|(?:${POSIX_DIRECTORIES})/${AFTER_DIRECTORY})`,
    String.raw`(?<![A-Za-z0-9_.])~[/\\](?=${SEGMENT})`,
    String.raw`(?<![\\:A-Za-z0-9_.])\\{2,4}[A-Za-z0-9_.$-]+\\{1,2}(?=${SEGMENT})`,
  ].join("|");
}

interface PathStarts {
  readonly scan: RegExp;
  readonly at: RegExp;
}

function pathStartPatterns(platform: NodeJS.Platform): PathStarts {
  const flags = platform === "win32" || platform === "darwin" ? "i" : "";
  return { scan: new RegExp(pathStartSource(), `${flags}g`), at: new RegExp(pathStartSource(), `${flags}y`) };
}

const HOME_START = /(?:Users|home|Documents and Settings)[\\/]+$/i;
const HARD_DELIMITERS = new Set(['"', "'", "`", ")", "]", "}", ",", ";", "|", "<", ">", "\r", "\n"]);
const FILE_EXTENSION_BEFORE = /\.[A-Za-z0-9]{1,8}$/;
const MAX_EXTENSION_LOOKBACK = 9;

function isSeparator(character: string): boolean {
  return character === "/" || character === "\\";
}

function pathEnd(text: string, from: number, afterHome: boolean, startsAt: RegExp): number {
  let end = from;
  while (end < text.length && !HARD_DELIMITERS.has(text.charAt(end))) {
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

const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,1024}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+/g;

function isFragmentBoundary(character: string): boolean {
  return /[\s"'<>]/.test(character);
}

function maskUrlFragments(text: string, onMask: () => void): string {
  const MAX_ADDRESS = 2048;
  let output = "";
  let cursor = 0;
  let hash = text.indexOf("#");
  while (hash >= 0) {
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

// A block with no END line is masked to the end of the text; a string search avoids rescanning on repeated headers.
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

// JSON doubles backslashes, so a Windows path inside a JSON string differs from the path itself.
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
    result = maskPaths(result, pathStart, () => (counts.paths += 1));
    result = mask(personal, result, "paths");
    result = replaceCounted(result, EMAIL, "emails", REDACTED_EMAIL);
    result = result.replace(SECRET_PAIR, (match: string, key: string, value: string) => {
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

export function createRedactor(context: RedactionContext): (text: string) => string {
  const redactor = createCountingRedactor(context);
  return (text) => redactor.redact(text);
}
