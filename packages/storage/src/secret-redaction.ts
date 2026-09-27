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

function combineRedactions(target: RedactionSummary, source: RedactionSummary): void {
  target.total += source.total;
  for (const [kind, count] of Object.entries(source.byKind) as Array<[SensitiveDataKind, number]>) {
    target.byKind[kind] = (target.byKind[kind] ?? 0) + count;
  }
}

export function redactText(input: string): RedactedText {
  let value = input;
  const redactions = emptyRedactions();

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

export function combineRedactionSummaries(...summaries: readonly RedactionSummary[]): RedactionSummary {
  const result = emptyRedactions();
  for (const summary of summaries) {
    combineRedactions(result, summary);
  }
  return result;
}
