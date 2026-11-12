import type { RedactionSummary, SensitiveDataKind } from "@work-intelligence/core";

export interface RedactedText {
  value: string;
  redactions: RedactionSummary;
}

export interface RedactedValue<T> {
  value: T;
  redactions: RedactionSummary;
}

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
  pattern: RegExp;
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
/** A literal some detector needs, searched once; text without any (most stored text) skips every detector. */
const ANY_DETECTOR_LITERAL =
  /-----BEGIN |github_pat_|gh[pousr]_|sk-|xox|AIza|AKIA|ASIA|aws_secret_access_key|:\/\/|eyJ|api[_-]?key|secret|token|password/i;
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

const DETECTORS: readonly Detector[] = [
  {
    kind: "private_key",
    // The lookahead takes the text up to the first footer (group 1) or, when no footer follows, the rest of the input
    // (group 2), so a header without a footer is scanned once and every later header (which has no footer either) is
    // skipped instead of each scanning to the end.
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----(?=([\s\S]+?-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----)|([\s\S]*))\1\2/g,
    accept: (groups) => groups[0] !== undefined,
    mayMatch: (text) => text.includes("-----BEGIN "),
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
    kind: "google_api_key",
    // Same as slack_token: `-AIza-AIza…` starts a candidate at every prefix, so the body is taken atomically.
    pattern: /(?<![A-Za-z0-9_])AIza(?=([A-Za-z0-9_-]{30,100}))\1(?![A-Za-z0-9_-])/g,
    mayMatch: (text) => text.includes("AIza"),
  },
  {
    kind: "aws_access_key",
    pattern: /(?<![A-Za-z0-9_])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9_])/g,
    mayMatch: (text) => text.includes("AKIA") || text.includes("ASIA"),
  },
  {
    kind: "aws_secret_key",
    pattern: /(\baws_secret_access_key\s*[:=]\s*["']?)([A-Za-z0-9/+=]{40})(?=["'\s,;}]|$)/gi,
    masksGroup: true,
    mayMatch: (text) => /aws_secret_access_key/i.test(text),
  },
  {
    kind: "connection_string_password",
    // A match starts only where a scheme-character run starts (leading digits, `+`, `.` or `-` are kept in group 1 and
    // the scheme still begins at the run's first letter), so a long word without `://` is scanned once, not once per
    // letter. The user and password stop at `/`, so each `://` scans its own stretch of text.
    pattern: /(?<![A-Za-z0-9+.-])([0-9+.-]*[A-Za-z][A-Za-z0-9+.-]*:\/\/[^:\s/@]+:)([^\s/@]{8,})(@[^\s/]+)/g,
    masksGroup: true,
    mayMatch: (text) => text.includes("://"),
  },
  {
    kind: "jwt",
    pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9_-])/g,
    mayMatch: (text) => text.includes("eyJ"),
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

export function redactText(input: string): RedactedText {
  const redactions = emptyRedactions();
  // Private blocks go first so a credential inside one is counted once, as private_block.
  let value = redactPrivateBlocks(input, redactions);
  if (!ANY_DETECTOR_LITERAL.test(value)) {
    return { value, redactions };
  }

  for (const detector of DETECTORS) {
    if (!detector.mayMatch(value)) continue;
    value = value.replace(detector.pattern, (match: string, ...rest: unknown[]) => {
      const source = rest[rest.length - 1] as string;
      const offset = rest[rest.length - 2] as number;
      const groups = rest.slice(0, -2) as Array<string | undefined>;
      if (detector.accept && !detector.accept(groups, source.charAt(offset + match.length))) {
        return match;
      }
      addRedaction(redactions, detector.kind);
      const marker = `[REDACTED:${detector.kind}]`;
      if (!detector.masksGroup) {
        return marker;
      }
      // Cut by group lengths, not by searching for the secret: a user name equal to the password must stay visible.
      const before = groups[0] ?? "";
      const secret = groups[1] ?? "";
      return before + marker + match.slice(before.length + secret.length);
    });
  }

  return { value, redactions };
}

/** Recursively sanitizes Agent/user strings while preserving the value's JSON-compatible shape. */
export function redactValue<T>(input: T): RedactedValue<T> {
  const redactions = emptyRedactions();
  const visit = (value: unknown): unknown => {
    if (typeof value === "string") {
      const result = redactText(value);
      combineRedactions(redactions, result.redactions);
      return result.value;
    }
    if (Array.isArray(value)) {
      return value.map(visit);
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
    }
    return value;
  };

  return { value: visit(input) as T, redactions };
}

/**
 * Masks stored JSON text (a `*_json` column). Plain-text rules run first as a cheap check; when they find something,
 * the string values are masked one by one instead, so a match can never span two values or break the JSON syntax
 * (a `<private>` in one value and `</private>` in a later one would otherwise remove the JSON between them). Text that is not JSON stays plain text.
 */
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
  return {
    value: structured.redactions.total === 0 ? input : JSON.stringify(structured.value),
    redactions: structured.redactions,
  };
}

export function combineRedactionSummaries(...summaries: readonly RedactionSummary[]): RedactionSummary {
  const result = emptyRedactions();
  for (const summary of summaries) {
    combineRedactions(result, summary);
  }
  return result;
}
