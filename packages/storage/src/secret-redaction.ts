import type { RedactionSummary, SensitiveDataKind } from "@work-intelligence/core";

export interface RedactedText {
  value: string;
  redactions: RedactionSummary;
}

export interface RedactedValue<T> {
  value: T;
  redactions: RedactionSummary;
}

type Detector = {
  kind: SensitiveDataKind;
  pattern: RegExp;
  group?: number;
  skip?: (value: string) => boolean;
};

/**
 * `<private>` and `</private>` (case-insensitive, no attributes or inner whitespace). One literal-only regex scanned
 * once, so finding every block is linear in the input length with no backtracking.
 */
const PRIVATE_TAG = /<(\/?)private>/gi;
const PRIVATE_BLOCK_MARKER = "[REDACTED:private_block]";

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

const DETECTORS: readonly Detector[] = [
  {
    kind: "private_key",
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g,
  },
  {
    kind: "github_token",
    pattern: /(?<![A-Za-z0-9_])(?:github_pat_[A-Za-z0-9_]{50,255}|gh[pousr]_[A-Za-z0-9]{36,255})(?![A-Za-z0-9_])/g,
  },
  {
    kind: "anthropic_token",
    pattern: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,255}(?![A-Za-z0-9_-])/g,
  },
  {
    kind: "openai_token",
    pattern: /(?<![A-Za-z0-9_-])sk-(?!ant-)[A-Za-z0-9_-]{20,255}(?![A-Za-z0-9_-])/g,
  },
  {
    kind: "slack_token",
    pattern: /(?<![A-Za-z0-9_])xox[abprs]-[A-Za-z0-9-]{20,255}(?![A-Za-z0-9_-])/g,
  },
  {
    kind: "google_api_key",
    pattern: /(?<![A-Za-z0-9_])AIza[A-Za-z0-9_-]{30,100}(?![A-Za-z0-9_-])/g,
  },
  {
    kind: "aws_access_key",
    pattern: /(?<![A-Za-z0-9_])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9_])/g,
  },
  {
    kind: "aws_secret_key",
    pattern: /(\baws_secret_access_key\s*[:=]\s*["']?)([A-Za-z0-9/+=]{40})(?=["'\s,;}]|$)/gi,
    group: 2,
  },
  {
    kind: "connection_string_password",
    pattern: /((?:[A-Za-z][A-Za-z0-9+.-]*:\/\/)[^:\s/@]+:)([^\s/@]{8,})(@[^\s/]+)/g,
    group: 2,
  },
  {
    kind: "jwt",
    pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9_-])/g,
  },
  {
    kind: "environment_secret",
    pattern: /(\b(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*["']?)([A-Za-z0-9_./+=:-]{8,})(?=["'\s,;}]|$)/gi,
    group: 2,
    skip: isIdentifierLike,
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

  for (const detector of DETECTORS) {
    value = value.replace(detector.pattern, (...args: unknown[]) => {
      const match = String(args[0] ?? "");
      const capture = detector.group === undefined ? match : String(args[detector.group] ?? "");
      if (!capture || detector.skip?.(capture)) {
        return match;
      }
      addRedaction(redactions, detector.kind);
      if (detector.group === undefined) {
        return `[REDACTED:${detector.kind}]`;
      }
      const captureOffset = match.indexOf(capture);
      if (captureOffset < 0) {
        return match;
      }
      return (
        match.slice(0, captureOffset) + `[REDACTED:${detector.kind}]` + match.slice(captureOffset + capture.length)
      );
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
