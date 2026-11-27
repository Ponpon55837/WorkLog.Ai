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

/** Every pattern must run in time linear in the input: it runs synchronously over every stored string. */
type Detector = {
  kind: SensitiveDataKind;
  pattern?: RegExp;
  scan?: (text: string) => SecretRange[];
  masksGroup?: boolean;
  accept?: (groups: ReadonlyArray<string | undefined>, next: string) => boolean;
  mayMatch: (text: string) => boolean;
};

const PRIVATE_TAG = /<(\/?)private>/gi;
const PRIVATE_BLOCK_MARKER = "[REDACTED:private_block]";
const ENVIRONMENT_SECRET_KEYWORD = /api[_-]?key|secret|token|password/i;
const ANY_DETECTOR_LITERAL =
  /-----BEGIN |PuTTY-User-Key-File|github_pat_|gh[pousr]_|sk-|sk_live_|sk_test_|rk_live_|rk_test_|xox|xapp-|hooks\.slack\.com|AIza|ya29\.|GOCSPX-|AKIA|ASIA|aws_secret_access_key|:\/\/|eyJ|[?&]key=|api[_-]?key|secret|token|passw|pwd|passphrase|credential|authorization|cookie|accountkey|sharedaccess|signature/i;
const ANY_CASE_SENSITIVE_LITERAL = /glpat-|npm_|SG\.|hf_|SK[0-9a-f]{32}/;
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

const TYPE_KEYWORDS = new Set([
  "string",
  "str",
  "number",
  "int",
  "integer",
  "float",
  "double",
  "boolean",
  "bool",
  "bigint",
  "symbol",
  "any",
  "unknown",
  "object",
  "never",
  "void",
  "undefined",
  "buffer",
  "bytes",
  "bytearray",
  "uint8array",
]);
const TYPE_MEMBER = `(?:${[...TYPE_KEYWORDS].join("|")})(?:\\[\\])*\\??`;
const TYPE_ANNOTATION = new RegExp(`^${TYPE_MEMBER}(?:\\|(?:${TYPE_MEMBER}|null\\??))*=?$`, "i");

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
  return (
    value.length >= 8 &&
    (next === "" || SECRET_VALUE_TERMINATOR.test(next)) &&
    !isIdentifierLike(value) &&
    !TYPE_KEYWORDS.has(value.toLowerCase())
  );
}

interface KeyedRule {
  keyword: string;
  /** Only a 40-character base64 value is an AWS secret access key. */
  exactLength?: number;
  /** A bare number is a count (`max_token: 4096`), not a credential. */
  rejectNumeric?: boolean;
  /** `PWD=/home/user` is the shell's working directory. */
  rejectPath?: boolean;
  /** `db_credentials`, not the setting `withCredentials`. */
  separatedOnly?: boolean;
}

const KEYED_MAX_KEY_LENGTH = 64;
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
const LEADING_LITERAL = /^(?:true|false|null|nil|undefined|none|[01])(?=[,;)}\]'`]|$)/i;
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

function isValueEndCode(code: number): boolean {
  return (
    code === 96 ||
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0xff01 && code <= 0xff0f) ||
    (code >= 0xff1a && code <= 0xff20)
  );
}

function isQuoteCode(code: number): boolean {
  return code === 34 || code === 39 || code === 96;
}

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
  return (
    Number(lower) + Number(upper) + Number(digit) >= 2 && (digit || value.length >= BARE_TOKEN_LETTERS_ONLY_LENGTH)
  );
}

function isLiteralSecretValue(value: string, minLength: number): boolean {
  if (value.length < minLength) return false;
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
  if (value.startsWith("$") || value.includes("<") || value.includes(">")) return false;
  if (LEADING_LITERAL.test(value) || TYPE_ANNOTATION.test(value)) return false;
  if (rule.rejectNumeric && /^[0-9]+$/.test(value)) return false;
  if (rule.rejectPath && /^(?:[/~.]|[A-Za-z]:[\\/])/.test(value)) return false;
  return value.length > 128 || (!DOTTED_IDENTIFIER.test(value) && !FUNCTION_CALL.test(value));
}

function readKeyedValue(
  text: string,
  separator: number,
  rule: KeyedRule,
  keyLead: number,
  bareJsonToken: boolean,
): { range?: SecretRange; next: number } {
  const length = text.length;
  let cursor = separator + 1;
  // `=>`
  if (text.charCodeAt(separator) === 61 && text.charCodeAt(cursor) === 62) cursor += 1;
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
  }

  let end = start;
  while (end < length) {
    const code = text.charCodeAt(end);
    if (code === 32 || code === 9 || code === 10 || code === 13 || code === 34 || code === 92) break;
    if (isValueEndCode(code)) break;
    if ((code === 38 && (keyLead === 63 || keyLead === 38)) || (code === 59 && keyLead === 59)) break;
    end += 1;
  }
  // A `)` belongs to the value when it holds a `(`, so `getToken(session)` stays whole.
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
      if (spaces > 0) {
        const after = text.charCodeAt(index + 1);
        if (!(Number.isNaN(after) || isLineSpaceCode(after) || isQuoteCode(after) || after === 92 || after === 62)) {
          index += 1;
          continue;
        }
      }
      keyQuoted = true;
      cursor -= 1;
      // `\"key\":` inside an escaped JSON string.
      if (cursor >= 0 && text.charCodeAt(cursor) === 92) cursor -= 1;
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
    pattern:
      /-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED|PGP) )?PRIVATE KEY(?: BLOCK)?-----(?=([\s\S]+?-----END (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED|PGP) )?PRIVATE KEY(?: BLOCK)?-----)|([\s\S]*))\1\2/gi,
    accept: (groups) => groups[0] !== undefined,
    mayMatch: (text) => /-----BEGIN /i.test(text),
  },
  {
    kind: "private_key",
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
    pattern: /(?<![A-Za-z0-9_])xapp-[0-9]-(?=([A-Za-z0-9-]{20,255}))\1(?![A-Za-z0-9_-])/g,
    mayMatch: (text) => text.includes("xapp-"),
  },
  {
    kind: "slack_token",
    pattern: /(hooks\.slack\.com\/services\/)(T[A-Z0-9]{2,32}\/B[A-Z0-9]{2,32}\/[A-Za-z0-9]{8,64})(?![A-Za-z0-9])/g,
    masksGroup: true,
    mayMatch: (text) => text.includes("hooks.slack.com"),
  },
  {
    kind: "google_api_key",
    // `-AIza-AIza…` starts a candidate at every prefix, so the body is taken atomically.
    pattern: /(?<![A-Za-z0-9_])AIza(?=([A-Za-z0-9_-]{30,100}))\1(?![A-Za-z0-9_-])/g,
    mayMatch: (text) => text.includes("AIza"),
  },
  {
    kind: "google_api_key",
    pattern:
      /(?<![A-Za-z0-9_])(?:ya29\.(?=([A-Za-z0-9_-]{20,500}))\1|GOCSPX-(?=([A-Za-z0-9_-]{20,100}))\2)(?![A-Za-z0-9_-])/g,
    mayMatch: (text) => text.includes("ya29.") || text.includes("GOCSPX-"),
  },
  {
    kind: "aws_access_key",
    // `_` may touch the id: an underscore is a separator in names, not part of the key.
    pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g,
    mayMatch: (text) => text.includes("AKIA") || text.includes("ASIA"),
  },
  {
    kind: "aws_secret_key",
    pattern: /((?<![A-Za-z0-9])aws_secret_access_key["']?\s*[:=]\s*["']?)([A-Za-z0-9/+=]{40})(?=["'\s,;}]|$)/gi,
    masksGroup: true,
    mayMatch: (text) => /aws_secret_access_key/i.test(text),
  },
  {
    kind: "aws_secret_key",
    // Only this position makes a bare 40-character string an AWS secret; a lone one is often a git SHA.
    pattern: /(\[REDACTED:aws_access_key\]["']?[ \t\r\n"',:;=]{1,8})([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/g,
    masksGroup: true,
    mayMatch: (text) => text.includes("[REDACTED:aws_access_key]"),
  },
  {
    kind: "connection_string_password",
    pattern:
      /(?<![A-Za-z0-9+.-])([0-9+.-]*[A-Za-z][A-Za-z0-9+.-]*:\/\/[^:\s/@]*:)([^\s"'?#]{8,256}?)(@[^\s@/?#"'<>]+)(?![^\s/?#"'<>])/g,
    masksGroup: true,
    // `http://localhost:3000/user@example.com` is a port and a path, not a password.
    accept: (groups) => !/^[0-9]{1,5}\//.test(groups[1] ?? "") && !(groups[1] ?? "").startsWith(REDACTED_MARKER_PREFIX),
    mayMatch: (text) => text.includes("://"),
  },
  {
    kind: "connection_string_password",
    pattern: /(?<![A-Za-z0-9+.-])([0-9+.-]*[A-Za-z][A-Za-z0-9+.-]*:\/\/[^:\s/@]+:)([^\s/@]{8,})(@[^\s/]+)/g,
    masksGroup: true,
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
    pattern:
      /(?<![A-Za-z0-9_])(?:(?:sk|rk)_(?:live|test)_(?=([A-Za-z0-9]{16,255}))\1|glpat-(?=([A-Za-z0-9_-]{20,255}))\2|npm_[A-Za-z0-9]{36}|SG\.(?=([A-Za-z0-9_-]{16,255}))\3\.(?=([A-Za-z0-9_-]{16,255}))\4|hf_(?=([A-Za-z0-9]{30,255}))\5|SK[0-9a-f]{32})(?![A-Za-z0-9_-])/g,
    mayMatch: (text) => /sk_live_|sk_test_|rk_live_|rk_test_|glpat-|npm_|SG\.|hf_|SK[0-9a-f]{32}/.test(text),
  },
  {
    kind: "environment_secret",
    pattern:
      /((?<![A-Za-z0-9])authorization["']?[ \t]{0,3}[:=][ \t]{0,3}["']?(?:bearer|basic|token|digest|negotiate)[ \t]{1,4})([^\s"'\\]+)/gi,
    masksGroup: true,
    accept: (groups) => isLiteralSecretValue(groups[1] ?? "", 8) && !(groups[1] ?? "").startsWith("$"),
    mayMatch: (text) => /authorization/i.test(text),
  },
  {
    kind: "environment_secret",
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
    // The value run is taken atomically and checked by `accept`, so `token=token=…` is not re-scanned from every keyword.
    pattern: /(\b(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*["']?)(?=([A-Za-z0-9_./+=:-]*))\2/gi,
    masksGroup: true,
    accept: isAssignedSecretValue,
    mayMatch: (text) => ENVIRONMENT_SECRET_KEYWORD.test(text),
  },
  {
    kind: "environment_secret",
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

/** An unclosed opening tag and a stray closing tag stay as written: records often name the tag itself. */
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

export function countUnclosedPrivateTags(input: string): number {
  if (!input.includes("<")) {
    return 0;
  }
  let open = 0;
  for (const match of input.matchAll(PRIVATE_TAG)) {
    if (match[1] !== "/") {
      open += 1;
    } else if (open > 0) {
      open -= 1;
    }
  }
  return open;
}

function combineRedactions(target: RedactionSummary, source: RedactionSummary): void {
  target.total += source.total;
  for (const [kind, count] of Object.entries(source.byKind) as Array<[SensitiveDataKind, number]>) {
    target.byKind[kind] = (target.byKind[kind] ?? 0) + count;
  }
}

/** Call it on the full text before any length cut, so a block straddling the cut is still removed. */
export function redactPrivateBlocksText(input: string): RedactedText {
  const redactions = emptyRedactions();
  return { value: redactPrivateBlocks(input, redactions), redactions };
}

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

/** Own data property: a JSON key such as "__proto__" must not change the prototype. */
function assignChild(target: unknown, key: string | number, value: unknown): void {
  Object.defineProperty(target as object, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Walks with an explicit stack, so a deeply nested value cannot overflow the call stack. */
export function redactValue<T>(input: T): RedactedValue<T> {
  const redactions = emptyRedactions();
  const redactLeaf = (value: unknown): unknown => {
    if (typeof value !== "string") return value;
    const result = redactText(value);
    combineRedactions(redactions, result.redactions);
    return result.value;
  };
  const isContainer = (value: unknown): value is object => typeof value === "object" && value !== null;
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

// Stored JSON is masked value by value, so a match can never span two values or break the JSON syntax.
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
      return plain;
    }
  }
  // Key-aware rules need the JSON syntax around the value, so they run over the serialized text and are kept only
  // while it stays valid JSON.
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
