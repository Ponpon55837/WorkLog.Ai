import type { RedactionSummary, SensitiveDataKind } from "@work-intelligence/core";

export interface RedactedText {
  value: string;
  redactions: RedactionSummary;
}

export interface RedactedValue<T> {
  value: T;
  redactions: RedactionSummary;
}

interface SecretRange {
  start: number;
  end: number;
}

/**
 * Known limitation: obfuscated secrets are not detected. This covers URL-encoded values (`%70assword`), base64-wrapped
 * text, a credential split across lines or by an inserted line break, and zero-width or full-width look-alike
 * characters. Redaction is a safety net for accidental pastes, not a defence against deliberate evasion.
 */

/**
 * One masking rule. Every pattern must find all its matches in time linear in the input length, because it runs
 * synchronously over every stored string (up to ~200,000 characters) on the shared event loop:
 * - a match may start only at the beginning of a run of the characters it consumes (a lookbehind or `\b`), so the
 *   engine never re-scans a run from every position inside it;
 * - an unbounded run is taken atomically with `(?=(run))\N`, and a candidate that the old greedy pattern would have
 *   rejected after backtracking is consumed whole and rejected by `accept` instead, so the scan moves past it;
 * - bounded quantifiers keep their upper bounds.
 */
type Detector = {
  kind: SensitiveDataKind;
  /** A regex rule. Exactly one of `pattern` and `scan` is set. */
  pattern?: RegExp;
  /** A hand-written linear scanner for rules a regex cannot express safely; returns ascending, disjoint ranges to mask. */
  scan?: (text: string) => SecretRange[];
  /** Group 1 is the text before the secret and group 2 the secret; only group 2 is masked. Otherwise the whole match is. */
  masksGroup?: boolean;
  /** Keeps a candidate as written unless this returns true. `next` is the character after the match ("" at the end). */
  accept?: (groups: ReadonlyArray<string | undefined>, next: string) => boolean;
  /**
   * False when the text lacks a literal every match must contain, so the pattern cannot match and is not run. Most
   * stored strings hold no candidate at all, and a substring search is far cheaper than a scan that starts with a
   * lookbehind at every position; an export redacts every stored string.
   */
  mayMatch: (text: string) => boolean;
};

/**
 * `<private>` and `</private>` (case-insensitive, no attributes or inner whitespace). One literal-only regex scanned
 * once, so finding every block is linear in the input length with no backtracking.
 */
const PRIVATE_TAG = /<(\/?)private>/gi;
const PRIVATE_BLOCK_MARKER = "[REDACTED:private_block]";
/** The keywords environment_secret needs, without its boundaries; finding none rules the pattern out. */
const ENVIRONMENT_SECRET_KEYWORD = /api[_-]?key|secret|token|password/i;
/**
 * A literal some detector needs, searched once; text without any (most stored text) skips every detector. The
 * second expression holds the case-sensitive prefixes whose case-insensitive form (`sk`, `hf_`) would match ordinary words.
 */
const ANY_DETECTOR_LITERAL =
  /-----BEGIN |PuTTY-User-Key-File|github_pat_|gh[pousr]_|sk-|sk_live_|sk_test_|rk_live_|rk_test_|xox|xapp-|hooks\.slack\.com|AIza|ya29\.|GOCSPX-|AKIA|ASIA|aws_secret_access_key|:\/\/|eyJ|[?&]key=|api[_-]?key|secret|token|passw|pwd|passphrase|credential|authorization|cookie|accountkey|sharedaccess|signature/i;
const ANY_CASE_SENSITIVE_LITERAL = /glpat-|npm_|SG\.|hf_|SK[0-9a-f]{32}/;
/** A character that may follow an assigned secret value (the end of the input also may). */
const SECRET_VALUE_TERMINATOR = /["'\s,;}]/;

const GENERIC_PLACEHOLDERS = new Set([
  "changeme",
  "change-me",
  "example",
  "placeholder",
  "redacted",
  "replace-me",
  "your-secret",
]);

function isIdentifierLike(value: string): boolean {
  const normalized = value.trim();
  return (
    GENERIC_PLACEHOLDERS.has(normalized.toLowerCase()) ||
    /^[0-9a-f]{7,64}$/i.test(normalized) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)
  );
}

function isAssignedSecretValue(groups: ReadonlyArray<string | undefined>, next: string): boolean {
  const value = groups[1] ?? "";
  return value.length >= 8 && (next === "" || SECRET_VALUE_TERMINATOR.test(next)) && !isIdentifierLike(value);
}

/** What a keyed-assignment keyword (letters only, compared without `_`, `-` and `.`) additionally requires of its value. */
interface KeyedRule {
  keyword: string;
  /** Only a 40-character base64 value is an AWS secret access key; anything else is left as written. */
  exactLength?: number;
  /** A bare number is a count (`max_token: 4096`), not a credential. */
  rejectNumeric?: boolean;
  /** `PWD=/home/user` is the shell's working directory. */
  rejectPath?: boolean;
  /** The keyword must be the whole key or follow a `_`, `-` or `.`: `db_credentials`, not the setting `withCredentials`. */
  separatedOnly?: boolean;
}

/** Longest key name read before a `:` or `=`; bounds the work per separator. */
const KEYED_MAX_KEY_LENGTH = 64;
/** Longest quoted value read; an unterminated quote is then taken as an unquoted value, so a repeated quote stays cheap. */
const KEYED_MAX_QUOTED_LENGTH = 1024;
const KEYED_MIN_UNQUOTED_LENGTH = 8;
const KEYED_MIN_QUOTED_LENGTH = 6;
const REDACTED_MARKER_PREFIX = "[REDACTED:";
/** Order matters: the first keyword a key ends with decides (`secretaccesskey` before `accesskey`). */
const KEYED_RULES: readonly KeyedRule[] = [
  { keyword: "secretaccesskey", exactLength: 40 },
  { keyword: "password" },
  { keyword: "passwd" },
  { keyword: "passphrase" },
  { keyword: "pwd", rejectPath: true },
  { keyword: "secretkey" },
  { keyword: "secret" },
  { keyword: "token", rejectNumeric: true },
  { keyword: "apikey" },
  { keyword: "accesskey" },
  { keyword: "credentials", separatedOnly: true },
  { keyword: "credential", separatedOnly: true },
];
/** Values that document a field instead of holding a secret (`credentials: "include"`, `password: string`). */
const KEYED_PLACEHOLDERS = new Set([
  ...GENERIC_PLACEHOLDERS,
  "include",
  "omit",
  "same-origin",
  "required",
  "optional",
  "string",
  "boolean",
  "undefined",
  "password",
  "secret",
  "token",
  "null",
  "nil",
  "none",
  "true",
  "false",
]);
/** An unquoted value that starts with a literal and runs on into code (`withCredentials=false,timeout:5000}`). Fixed alternatives, anchored: no backtracking. */
const LEADING_LITERAL = /^(?:true|false|null|nil|undefined|none|[01])(?=[,;)}\]'`]|$)/i;
/** A bare JSON `"token"` key often names a text fragment; its value must look like a credential, not a word. */
const BARE_TOKEN_MIN_LENGTH = 12;
const BARE_TOKEN_KEY_LENGTH = 5;
const BARE_TOKEN_LETTERS_ONLY_LENGTH = 24;
const MASKED_FILLER = /^(.)\1+$/;
const DOTTED_IDENTIFIER = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/;
const FUNCTION_CALL = /^[A-Za-z_][\w.]*\(.*\)$/;
const BASE64_SECRET = /^[A-Za-z0-9/+=]+$/;

function isAlphanumericCode(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isKeySeparatorCode(code: number): boolean {
  return code === 95 || code === 45 || code === 46;
}

function isKeyCharCode(code: number): boolean {
  return isAlphanumericCode(code) || isKeySeparatorCode(code);
}

function isLineSpaceCode(code: number): boolean {
  return code === 32 || code === 9;
}

function isQuoteCode(code: number): boolean {
  return code === 34 || code === 39 || code === 96;
}

/**
 * The rule whose keyword ends the key `text[start, end)` at a keyword boundary: the start of the key, a character that
 * is not a letter or digit (`_` counts: `DB_PASSWORD`), or a camelCase step (`accessToken`). `pass_word` and `api-key`
 * match because `_`, `-` and `.` inside a keyword are skipped. Letters glued to the keyword (`tokenizer`, `secretary`,
 * `mytoken`) do not match.
 */
function keyedRuleFor(text: string, start: number, end: number): KeyedRule | undefined {
  for (const rule of KEYED_RULES) {
    const keyword = rule.keyword;
    let index = end - 1;
    let offset = keyword.length - 1;
    while (offset >= 0 && index >= start) {
      const code = text.charCodeAt(index);
      if (isKeySeparatorCode(code) && offset < keyword.length - 1) {
        index -= 1;
      } else if ((code | 32) === keyword.charCodeAt(offset)) {
        index -= 1;
        offset -= 1;
      } else {
        break;
      }
    }
    if (offset >= 0) continue;
    const first = index + 1;
    if (first === start) return rule;
    const before = text.charCodeAt(first - 1);
    if (!isAlphanumericCode(before)) return rule;
    const code = text.charCodeAt(first);
    if (rule.separatedOnly) continue;
    const isUpper = code >= 65 && code <= 90;
    const beforeIsLowerOrDigit = (before >= 97 && before <= 122) || (before >= 48 && before <= 57);
    if (isUpper && beforeIsLowerOrDigit) return rule;
  }
  return undefined;
}

/** No whitespace, at least two of lowercase, uppercase and digits (letters only when long): the shape of a credential, not a word or phrase. */
function looksLikeCredential(value: string): boolean {
  let lower = false;
  let upper = false;
  let digit = false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 32) return false;
    if (code >= 97 && code <= 122) lower = true;
    else if (code >= 65 && code <= 90) upper = true;
    else if (code >= 48 && code <= 57) digit = true;
  }
  // Letters of both cases alone (`ThisIsAFragment`) are a camelCase identifier unless the value is long.
  return (
    Number(lower) + Number(upper) + Number(digit) >= 2 && (digit || value.length >= BARE_TOKEN_LETTERS_ONLY_LENGTH)
  );
}

/** The checks every keyed rule shares: long enough, not already masked, not an interpolation or a documented placeholder. */
function isLiteralSecretValue(value: string, minLength: number): boolean {
  if (value.length < minLength) return false;
  // Placeholder shapes: `[REDACTED…]` (this module's own markers), `[[…]]`, `${…}`, `{{…}}`, `$(…)` and `<…>`.
  if (value.startsWith("[REDACTED") || value.startsWith("[[")) return false;
  if (value.startsWith("${") || value.startsWith("{{") || value.startsWith("$(") || value.startsWith("<")) return false;
  return !KEYED_PLACEHOLDERS.has(value.toLowerCase()) && !MASKED_FILLER.test(value);
}

function isAcceptedKeyedValue(value: string, rule: KeyedRule, quoted: boolean, bareJsonToken: boolean): boolean {
  if (!isLiteralSecretValue(value, quoted ? KEYED_MIN_QUOTED_LENGTH : KEYED_MIN_UNQUOTED_LENGTH)) return false;
  if (bareJsonToken && (value.length < BARE_TOKEN_MIN_LENGTH || !looksLikeCredential(value))) return false;
  if (rule.exactLength !== undefined) {
    return value.length === rule.exactLength && BASE64_SECRET.test(value);
  }
  if (quoted) return true;
  // The unquoted checks below drop code, markup and counts; a quoted value is an explicit literal and keeps all.
  if (value.startsWith("$") || value.includes("<") || value.includes(">")) return false;
  if (LEADING_LITERAL.test(value)) return false;
  if (rule.rejectNumeric && /^[0-9]+$/.test(value)) return false;
  if (rule.rejectPath && /^(?:[/~.]|[A-Za-z]:[\\/])/.test(value)) return false;
  return value.length > 128 || (!DOTTED_IDENTIFIER.test(value) && !FUNCTION_CALL.test(value));
}

/**
 * One value read after a key's `:` or `=`: the masked range (if any) and where scanning resumes. Quoted values run to the
 * closing quote, honoring backslash escapes (a JSON string); a quote escaped as `\"` (JSON inside a string) closes at the
 * next `\"`. Unquoted values run to whitespace, a `"`, a backslash, and `&` or `;` when the key follows that character,
 * minus trailing closing punctuation. Every read ends before the next unread character, so the scan stays linear.
 */
function readKeyedValue(
  text: string,
  separator: number,
  rule: KeyedRule,
  keyLead: number,
  bareJsonToken: boolean,
): { range?: SecretRange; next: number } {
  const length = text.length;
  let cursor = separator + 1;
  if (text.charCodeAt(separator) === 61 && text.charCodeAt(cursor) === 62) cursor += 1; // `=>`
  const spaceLimit = cursor + 16;
  while (cursor < length && cursor < spaceLimit && isLineSpaceCode(text.charCodeAt(cursor))) cursor += 1;
  if (cursor >= length) return { next: length };

  let quote = 0;
  let escaped = false;
  let start = cursor;
  const first = text.charCodeAt(cursor);
  if (first === 92 && isQuoteCode(text.charCodeAt(cursor + 1)) && text.charCodeAt(cursor + 1) !== 96) {
    quote = text.charCodeAt(cursor + 1);
    escaped = true;
    start = cursor + 2;
  } else if (isQuoteCode(first)) {
    quote = first;
    start = cursor + 1;
  }
  if (quote !== 0) {
    const limit = Math.min(length, start + KEYED_MAX_QUOTED_LENGTH);
    for (let index = start; index < limit; index += 1) {
      const code = text.charCodeAt(index);
      if (code === 10 || code === 13) break;
      if (escaped) {
        if (code === 92 && text.charCodeAt(index + 1) === quote) {
          return finishKeyed(text, rule, start, index, true, index + 2, bareJsonToken);
        }
        continue;
      }
      if (code === 92) {
        index += 1;
        continue;
      }
      if (code === quote) return finishKeyed(text, rule, start, index, true, index + 1, bareJsonToken);
    }
    // No closing quote nearby: read it as an unquoted value that starts after the quote.
  }

  let end = start;
  while (end < length) {
    const code = text.charCodeAt(end);
    if (code === 32 || code === 9 || code === 10 || code === 13 || code === 34 || code === 92) break;
    if ((code === 38 && (keyLead === 63 || keyLead === 38)) || (code === 59 && keyLead === 59)) break;
    end += 1;
  }
  // A closing `)` belongs to the value when it holds a `(`, so a call such as `getToken(session)` stays whole.
  const closesCall = text.slice(start, end).includes("(");
  let trimmed = end;
  while (trimmed > start && ",;)}]'`".includes(text[trimmed - 1]!) && !(closesCall && text[trimmed - 1] === ")")) {
    trimmed -= 1;
  }
  return finishKeyed(text, rule, start, trimmed, false, end, bareJsonToken);
}

function finishKeyed(
  text: string,
  rule: KeyedRule,
  start: number,
  end: number,
  quoted: boolean,
  next: number,
  bareJsonToken: boolean,
): { range?: SecretRange; next: number } {
  if (end > start && isAcceptedKeyedValue(text.slice(start, end), rule, quoted, bareJsonToken)) {
    return { range: { start, end }, next };
  }
  return { next };
}

/**
 * Masks the value of every `key: value`, `key=value` and `"key": "value"` whose key ends with a credential keyword
 * (`DB_PASSWORD=`, `accessToken:`, `"api_key": "…"`). Each separator costs a bounded look back; the value is read once
 * and scanning resumes after it, accepted or not, so `password=password=…` is not re-read from every separator.
 */
function scanKeyedSecrets(text: string): SecretRange[] {
  const ranges: SecretRange[] = [];
  const length = text.length;
  let index = 0;
  while (index < length) {
    const code = text.charCodeAt(index);
    if (code !== 58 && code !== 61) {
      index += 1;
      continue;
    }
    let cursor = index - 1;
    let spaces = 0;
    while (cursor >= 0 && spaces < 4 && isLineSpaceCode(text.charCodeAt(cursor))) {
      cursor -= 1;
      spaces += 1;
    }
    let keyQuoted = false;
    if (cursor >= 0 && isQuoteCode(text.charCodeAt(cursor))) {
      // `password" :aria-label=` is a key followed by the next attribute: after a closing quote and spaces, the
      // separator must be followed by space, a quote or `>` (`"password" : "x"`), not by a name.
      if (spaces > 0) {
        const after = text.charCodeAt(index + 1);
        if (!(Number.isNaN(after) || isLineSpaceCode(after) || isQuoteCode(after) || after === 92 || after === 62)) {
          index += 1;
          continue;
        }
      }
      keyQuoted = true;
      cursor -= 1;
      if (cursor >= 0 && text.charCodeAt(cursor) === 92) cursor -= 1; // `\"key\":` inside an escaped JSON string
    }
    const keyEnd = cursor + 1;
    while (cursor >= 0 && keyEnd - cursor <= KEYED_MAX_KEY_LENGTH && isKeyCharCode(text.charCodeAt(cursor))) {
      cursor -= 1;
    }
    const keyStart = cursor + 1;
    const rule = keyStart < keyEnd ? keyedRuleFor(text, keyStart, keyEnd) : undefined;
    if (!rule) {
      index += 1;
      continue;
    }
    const bareJsonToken = keyQuoted && keyEnd - keyStart === BARE_TOKEN_KEY_LENGTH && rule.keyword === "token";
    const read = readKeyedValue(text, index, rule, keyStart > 0 ? text.charCodeAt(keyStart - 1) : 0, bareJsonToken);
    if (read.range) ranges.push(read.range);
    index = Math.max(read.next, index + 1);
  }
  return ranges;
}

const DETECTORS: readonly Detector[] = [
  {
    kind: "private_key",
    // The lookahead takes the text up to the first footer (group 1) or, when no footer follows, the rest of the input
    // (group 2), so a header without a footer is scanned once and every later header (which has no footer either) is
    // skipped instead of each scanning to the end.
    // Markers are matched case-insensitively (`-----begin private key-----`) and include `PGP PRIVATE KEY BLOCK`.
    pattern:
      /-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED|PGP) )?PRIVATE KEY(?: BLOCK)?-----(?=([\s\S]+?-----END (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED|PGP) )?PRIVATE KEY(?: BLOCK)?-----)|([\s\S]*))\1\2/gi,
    accept: (groups) => groups[0] !== undefined,
    mayMatch: (text) => /-----BEGIN /i.test(text),
  },
  {
    kind: "private_key",
    // PuTTY `.ppk` files (versions 2 and 3) end with a `Private-MAC:` line; same footer-or-rest lookahead as above.
    pattern: /PuTTY-User-Key-File-[23]:(?=([\s\S]+?Private-MAC:[ \t]*[0-9A-Fa-f]*)|([\s\S]*))\1\2/g,
    accept: (groups) => groups[0] !== undefined,
    mayMatch: (text) => text.includes("PuTTY-User-Key-File-"),
  },
  {
    kind: "github_token",
    pattern: /(?<![A-Za-z0-9_])(?:github_pat_[A-Za-z0-9_]{50,255}|gh[pousr]_[A-Za-z0-9]{36,255})(?![A-Za-z0-9_])/g,
    mayMatch: (text) => text.includes("github_pat_") || /gh[pousr]_/.test(text),
  },
  {
    kind: "anthropic_token",
    pattern: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,255}(?![A-Za-z0-9_-])/g,
    mayMatch: (text) => text.includes("sk-ant-"),
  },
  {
    kind: "openai_token",
    pattern: /(?<![A-Za-z0-9_-])sk-(?!ant-)[A-Za-z0-9_-]{20,255}(?![A-Za-z0-9_-])/g,
    mayMatch: (text) => text.includes("sk-"),
  },
  {
    kind: "slack_token",
    // `-` may precede the prefix and is part of the body, so `xoxb-xoxb-…` starts a candidate at every prefix; the
    // atomic body scans each one at most 255 characters once instead of also backtracking through it.
    pattern: /(?<![A-Za-z0-9_])xox[abprs]-(?=([A-Za-z0-9-]{20,255}))\1(?![A-Za-z0-9_-])/g,
    mayMatch: (text) => text.includes("xox"),
  },
  {
    kind: "slack_token",
    // App-level tokens (`xapp-1-A0123-…`); the body is taken atomically like the other prefixed tokens.
    pattern: /(?<![A-Za-z0-9_])xapp-[0-9]-(?=([A-Za-z0-9-]{20,255}))\1(?![A-Za-z0-9_-])/g,
    mayMatch: (text) => text.includes("xapp-"),
  },
  {
    kind: "slack_token",
    // The path after `services/` is the secret of an incoming webhook.
    pattern: /(hooks\.slack\.com\/services\/)(T[A-Z0-9]{2,32}\/B[A-Z0-9]{2,32}\/[A-Za-z0-9]{8,64})(?![A-Za-z0-9])/g,
    masksGroup: true,
    mayMatch: (text) => text.includes("hooks.slack.com"),
  },
  {
    kind: "google_api_key",
    // Same as slack_token: `-AIza-AIza…` starts a candidate at every prefix, so the body is taken atomically.
    pattern: /(?<![A-Za-z0-9_])AIza(?=([A-Za-z0-9_-]{30,100}))\1(?![A-Za-z0-9_-])/g,
    mayMatch: (text) => text.includes("AIza"),
  },
  {
    kind: "google_api_key",
    // OAuth access tokens (`ya29.`) and OAuth client secrets (`GOCSPX-`).
    pattern:
      /(?<![A-Za-z0-9_])(?:ya29\.(?=([A-Za-z0-9_-]{20,500}))\1|GOCSPX-(?=([A-Za-z0-9_-]{20,100}))\2)(?![A-Za-z0-9_-])/g,
    mayMatch: (text) => text.includes("ya29.") || text.includes("GOCSPX-"),
  },
  {
    kind: "aws_access_key",
    // `_` may touch the id (`KEY_AKIA…_x`): an underscore is a separator in names, not part of the key.
    pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g,
    mayMatch: (text) => text.includes("AKIA") || text.includes("ASIA"),
  },
  {
    kind: "aws_secret_key",
    // `_` may precede the name (`MY_AWS_SECRET_ACCESS_KEY`) and a JSON key's closing quote may precede the `:`.
    pattern: /((?<![A-Za-z0-9])aws_secret_access_key["']?\s*[:=]\s*["']?)([A-Za-z0-9/+=]{40})(?=["'\s,;}]|$)/gi,
    masksGroup: true,
    mayMatch: (text) => /aws_secret_access_key/i.test(text),
  },
  {
    kind: "aws_secret_key",
    // The secret that follows an access key id (already masked above) in a credentials file, a CSV or a log line has no
    // name of its own. Only that position makes a bare 40-character string an AWS secret; a lone one is often a git SHA.
    pattern: /(\[REDACTED:aws_access_key\]["']?[ \t\r\n"',:;=]{1,8})([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/g,
    masksGroup: true,
    mayMatch: (text) => text.includes("[REDACTED:aws_access_key]"),
  },
  {
    kind: "connection_string_password",
    // A password that itself contains `@` or `/`: it runs lazily to the first `@` whose host part holds no further `@`,
    // so the last `@` of the authority ends it. `?` and `#` end the search (an `@` in a query string is not the host
    // separator) and the length is bounded, so each `scheme://user:` start costs at most 256 steps. It runs before the
    // rule below, which would mask only the part up to the first `@`. An empty user (`redis://:secret@host`) is allowed.
    pattern:
      /(?<![A-Za-z0-9+.-])([0-9+.-]*[A-Za-z][A-Za-z0-9+.-]*:\/\/[^:\s/@]*:)([^\s"'?#]{8,256}?)(@[^\s@/?#"'<>]+)(?![^\s/?#"'<>])/g,
    masksGroup: true,
    // `http://localhost:3000/user@example.com` is a host, a port and a path, not a password.
    accept: (groups) => !/^[0-9]{1,5}\//.test(groups[1] ?? ""),
    mayMatch: (text) => text.includes("://"),
  },
  {
    kind: "connection_string_password",
    // A match starts only where a scheme-character run starts (leading digits, `+`, `.` or `-` are kept in group 1 and
    // the scheme still begins at the run's first letter), so a long word without `://` is scanned once, not once per
    // letter. The user and password stop at `/`, so each `://` scans its own stretch of text.
    pattern: /(?<![A-Za-z0-9+.-])([0-9+.-]*[A-Za-z][A-Za-z0-9+.-]*:\/\/[^:\s/@]+:)([^\s/@]{8,})(@[^\s/]+)/g,
    masksGroup: true,
    // A password the rule above already masked is not counted again.
    accept: (groups) => !(groups[1] ?? "").startsWith(REDACTED_MARKER_PREFIX),
    mayMatch: (text) => text.includes("://"),
  },
  {
    kind: "jwt",
    pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9_-])/g,
    mayMatch: (text) => text.includes("eyJ"),
  },
  {
    kind: "environment_secret",
    // Provider prefixes without a dedicated kind: Stripe (`sk_live_`, `rk_live_`), GitLab, npm (exactly 36), SendGrid
    // (`SG.<id>.<secret>`), Hugging Face and Twilio API keys (`SK` plus 32 hex). Unbounded bodies are taken atomically.
    pattern:
      /(?<![A-Za-z0-9_])(?:(?:sk|rk)_(?:live|test)_(?=([A-Za-z0-9]{16,255}))\1|glpat-(?=([A-Za-z0-9_-]{20,255}))\2|npm_[A-Za-z0-9]{36}|SG\.(?=([A-Za-z0-9_-]{16,255}))\3\.(?=([A-Za-z0-9_-]{16,255}))\4|hf_(?=([A-Za-z0-9]{30,255}))\5|SK[0-9a-f]{32})(?![A-Za-z0-9_-])/g,
    mayMatch: (text) => /sk_live_|sk_test_|rk_live_|rk_test_|glpat-|npm_|SG\.|hf_|SK[0-9a-f]{32}/.test(text),
  },
  {
    kind: "environment_secret",
    // `Authorization: Bearer|Basic|Token …` (also in `curl -H "…"`); `$VAR`, `<placeholder>` and masked values stay.
    pattern:
      /((?<![A-Za-z0-9])authorization["']?[ \t]{0,3}[:=][ \t]{0,3}["']?(?:bearer|basic|token|digest|negotiate)[ \t]{1,4})([^\s"'\\]+)/gi,
    masksGroup: true,
    accept: (groups) => isLiteralSecretValue(groups[1] ?? "", 8) && !(groups[1] ?? "").startsWith("$"),
    mayMatch: (text) => /authorization/i.test(text),
  },
  {
    kind: "environment_secret",
    // `Cookie:` and `Set-Cookie:` carry session ids; the rest of the line is the value. A cookie holds `name=value`, which
    // keeps prose such as "cookie: chocolate" out.
    pattern: /((?<![A-Za-z0-9])cookie["']?[ \t]{0,3}:[ \t]{0,3}["']?)([^\r\n"']+)/gi,
    masksGroup: true,
    accept: (groups) => {
      const value = groups[1] ?? "";
      return value.includes("=") && !value.startsWith(REDACTED_MARKER_PREFIX) && !value.startsWith("$");
    },
    mayMatch: (text) => /cookie/i.test(text),
  },
  {
    kind: "environment_secret",
    // The value class contains `=`, `:` and keyword letters, so `token=token=…` used to re-scan to the end from every
    // keyword. The value is now the whole run, taken atomically and checked by `accept`; a keyword inside a rejected
    // run could only match the same run with the same ending, so skipping past the run loses nothing.
    pattern: /(\b(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*["']?)(?=([A-Za-z0-9_./+=:-]*))\2/gi,
    masksGroup: true,
    accept: isAssignedSecretValue,
    mayMatch: (text) => ENVIRONMENT_SECRET_KEYWORD.test(text),
  },
  {
    kind: "environment_secret",
    // Secrets in URLs: `?access_token=`, `&key=`, `X-Amz-Signature=` (presigned URLs) and Azure `AccountKey=…` strings.
    pattern:
      /([?&](?:access_token|refresh_token|id_token|api[_-]?key|key|token|secret|client_secret|password|x-amz-signature|x-amz-security-token|signature)=)([^&\s"'#<>]{8,})/gi,
    accept: (groups) => isLiteralSecretValue(groups[1] ?? "", 8),
    masksGroup: true,
    mayMatch: (text) => text.includes("?") || text.includes("&"),
  },
  {
    kind: "environment_secret",
    pattern:
      /((?<![A-Za-z0-9])(?:AccountKey|SharedAccessKey|SharedAccessSignature|PrimaryKey|SecondaryKey)[ \t]?=[ \t]?)([^;\s"'<>]{8,})/gi,
    accept: (groups) => isLiteralSecretValue(groups[1] ?? "", 8),
    masksGroup: true,
    mayMatch: (text) => /accountkey|sharedaccess|primarykey|secondarykey/i.test(text),
  },
  {
    kind: "environment_secret",
    // `DB_PASSWORD=`, `accessToken: "…"`, `"api_key": "…"` and the like: any key that ends with a credential keyword.
    scan: scanKeyedSecrets,
    mayMatch: (text) => /passw|pwd|passphrase|secret|token|api[_-]?key|access[_-]?key|credential/i.test(text),
  },
];

function emptyRedactions(): RedactionSummary {
  return { total: 0, byKind: {} };
}

function addRedaction(summary: RedactionSummary, kind: SensitiveDataKind): void {
  summary.total += 1;
  summary.byKind[kind] = (summary.byKind[kind] ?? 0) + 1;
}

/**
 * Replaces each outermost `<private>…</private>` block with one marker. A closing tag pairs with the nearest open
 * `<private>` before it, so nested blocks become one marker. An opening tag that is never closed and a stray closing
 * tag are ordinary text and stay as written: records often name the tag itself. One regex pass plus a stack of open
 * positions and a list of finished blocks (each block is pushed and dropped at most once), so the scan stays linear.
 */
function redactPrivateBlocks(input: string, redactions: RedactionSummary): string {
  if (!input.includes("<")) {
    return input;
  }
  const opens: number[] = [];
  const blocks: Array<{ start: number; end: number }> = [];
  for (const match of input.matchAll(PRIVATE_TAG)) {
    if (match[1] !== "/") {
      opens.push(match.index);
      continue;
    }
    const start = opens.pop();
    if (start === undefined) {
      continue;
    }
    while (blocks.length > 0 && blocks[blocks.length - 1]!.start > start) {
      blocks.pop();
    }
    blocks.push({ start, end: match.index + match[0].length });
  }
  if (blocks.length === 0) {
    return input;
  }
  let output = "";
  let cursor = 0;
  for (const block of blocks) {
    output += input.slice(cursor, block.start) + PRIVATE_BLOCK_MARKER;
    addRedaction(redactions, "private_block");
    cursor = block.end;
  }
  return output + input.slice(cursor);
}

function combineRedactions(target: RedactionSummary, source: RedactionSummary): void {
  target.total += source.total;
  for (const [kind, count] of Object.entries(source.byKind) as Array<[SensitiveDataKind, number]>) {
    target.byKind[kind] = (target.byKind[kind] ?? 0) + count;
  }
}

/**
 * Removes only the private blocks. Call it on the full text before any length cut, so a block that straddles the cut
 * is still removed instead of losing its closing tag.
 */
export function redactPrivateBlocksText(input: string): RedactedText {
  const redactions = emptyRedactions();
  return { value: redactPrivateBlocks(input, redactions), redactions };
}

/** Applies every credential detector (not the private-block rule) and counts what it masks. */
function redactSecrets(input: string, redactions: RedactionSummary): string {
  let value = input;
  if (!ANY_DETECTOR_LITERAL.test(value) && !ANY_CASE_SENSITIVE_LITERAL.test(value)) {
    return value;
  }

  for (const detector of DETECTORS) {
    if (!detector.mayMatch(value)) continue;
    const marker = `[REDACTED:${detector.kind}]`;
    if (detector.scan) {
      const ranges = detector.scan(value);
      if (ranges.length === 0) continue;
      let masked = "";
      let cursor = 0;
      for (const range of ranges) {
        masked += value.slice(cursor, range.start) + marker;
        cursor = range.end;
        addRedaction(redactions, detector.kind);
      }
      value = masked + value.slice(cursor);
      continue;
    }
    value = value.replace(detector.pattern!, (match: string, ...rest: unknown[]) => {
      const source = rest[rest.length - 1] as string;
      const offset = rest[rest.length - 2] as number;
      const groups = rest.slice(0, -2) as Array<string | undefined>;
      if (detector.accept && !detector.accept(groups, source.charAt(offset + match.length))) {
        return match;
      }
      addRedaction(redactions, detector.kind);
      if (!detector.masksGroup) {
        return marker;
      }
      // Cut by group lengths, not by searching for the secret: a user name equal to the password must stay visible.
      const before = groups[0] ?? "";
      const secret = groups[1] ?? "";
      return before + marker + match.slice(before.length + secret.length);
    });
  }

  return value;
}

export function redactText(input: string): RedactedText {
  const redactions = emptyRedactions();
  // Private blocks go first so a credential inside one is counted once, as private_block.
  const value = redactSecrets(redactPrivateBlocks(input, redactions), redactions);
  return { value, redactions };
}

/** Own data property, like Object.fromEntries: a JSON key such as "__proto__" must not change the prototype. */
function assignChild(target: unknown, key: string | number, value: unknown): void {
  Object.defineProperty(target as object, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Recursively sanitizes Agent/user strings while preserving the value's JSON-compatible shape. It walks with an
 * explicit stack, so a value nested tens of thousands of levels deep cannot overflow the call stack.
 */
export function redactValue<T>(input: T): RedactedValue<T> {
  const redactions = emptyRedactions();
  const redactLeaf = (value: unknown): unknown => {
    if (typeof value !== "string") return value;
    const result = redactText(value);
    combineRedactions(redactions, result.redactions);
    return result.value;
  };
  const isContainer = (value: unknown): value is object => typeof value === "object" && value !== null;
  // A container is created empty when its parent reaches it and filled when it is popped, so key order is kept.
  const createContainer = (value: object): unknown => (Array.isArray(value) ? new Array(value.length) : {});
  if (!isContainer(input)) {
    return { value: redactLeaf(input) as T, redactions };
  }

  const root = createContainer(input);
  const ancestors = new Set<object>();
  const work: Array<{ source: object; target: unknown } | { exit: object }> = [{ source: input, target: root }];
  while (work.length > 0) {
    const item = work.pop()!;
    if ("exit" in item) {
      ancestors.delete(item.exit);
      continue;
    }
    const { source, target } = item;
    if (ancestors.has(source)) {
      throw new TypeError("Cannot redact a circular value.");
    }
    ancestors.add(source);
    work.push({ exit: source });
    const place = (key: string | number, child: unknown): void => {
      if (isContainer(child)) {
        const created = createContainer(child);
        work.push({ source: child, target: created });
        assignChild(target, key, created);
      } else {
        assignChild(target, key, redactLeaf(child));
      }
    };
    if (Array.isArray(source)) {
      for (let index = 0; index < source.length; index += 1) place(index, source[index]);
    } else {
      for (const [key, child] of Object.entries(source)) place(key, child);
    }
  }

  return { value: root as T, redactions };
}

/**
 * Masks stored JSON text (a `*_json` column). Plain-text rules run first as a cheap check; when they find something,
 * the string values are masked one by one instead, so a match can never span two values or break the JSON syntax
 * (a `<private>` in one value and `</private>` in a later one would otherwise remove the JSON between them). Text that is not JSON stays plain text.
 */
function isValidJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export function redactJsonText(input: string): RedactedText {
  const plain = redactText(input);
  if (plain.redactions.total === 0) {
    return plain;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return plain;
  }
  const structured = redactValue(parsed);
  let base = input;
  if (structured.redactions.total > 0) {
    try {
      base = JSON.stringify(structured.value);
    } catch {
      // JSON.stringify recurses; a value too deep to serialize falls back to the plain-text masking.
      return plain;
    }
  }
  // Key-aware rules (`"password": "…"`) need the JSON syntax around the value, which a per-value pass never sees. They
  // run over the serialized text, and their result is kept only while it is still valid JSON.
  const keyed = emptyRedactions();
  const keyedText = redactSecrets(base, keyed);
  if (keyed.total > 0 && isValidJson(keyedText)) {
    combineRedactions(keyed, structured.redactions);
    return { value: keyedText, redactions: keyed };
  }
  return { value: base, redactions: structured.redactions };
}

export function combineRedactionSummaries(...summaries: readonly RedactionSummary[]): RedactionSummary {
  const result = emptyRedactions();
  for (const summary of summaries) {
    combineRedactions(result, summary);
  }
  return result;
}
