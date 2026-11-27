import {
  collectDiagnosticsWithStats,
  type DiagnosticsDocument,
  type DiagnosticsInputs,
} from "./diagnostics-collect.js";
import { createCountingRedactor, type DiagnosticsCounts, type RedactionContext } from "./diagnostics-redact.js";
import { SCAN_RULES, scanText, type ScanRule } from "./diagnostics-scan.js";

export { collectDiagnostics, dropErrorDetail, isOwnOutputLine, OWN_OUTPUT_PREFIXES } from "./diagnostics-collect.js";
export type { DiagnosticsDocument, DiagnosticsInputs, McpLeaseDiagnosticsInput } from "./diagnostics-collect.js";
export { createCountingRedactor, createRedactor, emptyDiagnosticsCounts } from "./diagnostics-redact.js";
export type {
  CountingRedactor,
  DiagnosticsCategory,
  DiagnosticsCounts,
  RedactionContext,
} from "./diagnostics-redact.js";
export { SCAN_MASK, SCAN_RULES, scanText } from "./diagnostics-scan.js";
export type { ScanResult, ScanRule } from "./diagnostics-scan.js";

export const DIAGNOSTICS_MAX_BYTES = 1024 * 1024;

const MAX_TEXT_UNITS = 4096;

export interface DiagnosticsReport {
  readonly categories: DiagnosticsCounts;
  readonly maskedInScan: number;
  readonly omittedOutputLines: number;
  readonly droppedDetails?: number;
  readonly truncatedBytes: number;
}

export interface BuiltDiagnostics {
  readonly text: string;
  readonly report: DiagnosticsReport;
}

export interface DiagnosticsBuildInputs extends DiagnosticsInputs, RedactionContext {}

export interface DiagnosticsOptions {
  readonly maxBytes?: number;
  readonly scanRules?: readonly ScanRule[];
}

export class DiagnosticsError extends Error {
  readonly code = "DIAGNOSTICS_SCAN_FAILED";

  constructor() {
    super("the diagnostics still held something that must not be exported");
    this.name = "DiagnosticsError";
  }
}

function mapStrings<T>(value: T, transform: (text: string) => string): T {
  if (typeof value === "string") return transform(value) as T;
  if (Array.isArray(value)) return value.map((entry: unknown) => mapStrings(entry, transform)) as T;
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]: [string, unknown]) => [key, mapStrings(entry, transform)]),
    ) as T;
  return value;
}

function isSameDocument(text: string, document: DiagnosticsDocument): boolean {
  try {
    return JSON.stringify(JSON.parse(text)) === JSON.stringify(document);
  } catch {
    return false;
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

export function clipText(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  let cut = Math.max(0, maxUnits - 1);
  if (cut > 0 && isHighSurrogate(text.charCodeAt(cut - 1))) cut -= 1;
  return `${text.slice(0, cut)}…`;
}

function serialize(document: DiagnosticsDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

interface Clipped {
  readonly document: DiagnosticsDocument;
  readonly clippedBytes: number;
}

function clipDocument(document: DiagnosticsDocument): Clipped {
  let clippedBytes = 0;
  const clipped = mapStrings(document, (text) => {
    const shorter = clipText(text, MAX_TEXT_UNITS);
    clippedBytes += byteLength(text) - byteLength(shorter);
    return shorter;
  });
  return { document: clipped, clippedBytes };
}

interface Fitted {
  readonly document: DiagnosticsDocument;
  readonly droppedBytes: number;
}

function dropToFit(document: DiagnosticsDocument, maxBytes: number): Fitted {
  const fitsLimit = (candidate: DiagnosticsDocument): boolean => byteLength(serialize(candidate)) <= maxBytes;
  if (fitsLimit(document)) return { document, droppedBytes: 0 };

  const { recentOutput, recentErrors } = document;
  const kept = (outputKept: number, errorsKept: number): DiagnosticsDocument => ({
    ...document,
    recentOutput: recentOutput.slice(recentOutput.length - outputKept),
    recentErrors: recentErrors.slice(recentErrors.length - errorsKept),
    truncated: { outputLines: recentOutput.length - outputKept, errors: recentErrors.length - errorsKept },
  });
  const largestFit = (total: number, fits: (count: number) => boolean): number => {
    let low = 0;
    let high = total;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(middle)) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  const outputKept = largestFit(recentOutput.length, (count) => fitsLimit(kept(count, recentErrors.length)));
  const errorsKept =
    outputKept === 0 ? largestFit(recentErrors.length, (count) => fitsLimit(kept(0, count))) : recentErrors.length;
  const dropped = [
    ...recentOutput.slice(0, recentOutput.length - outputKept),
    ...recentErrors.slice(0, recentErrors.length - errorsKept),
  ];
  const droppedBytes = dropped.reduce((total, entry) => total + byteLength(JSON.stringify(entry)), 0);
  return { document: kept(outputKept, errorsKept), droppedBytes };
}

export function buildDiagnostics(inputs: DiagnosticsBuildInputs, options: DiagnosticsOptions = {}): BuiltDiagnostics {
  const { maxBytes = DIAGNOSTICS_MAX_BYTES, scanRules = SCAN_RULES } = options;
  const { document: collected, droppedDetails } = collectDiagnosticsWithStats(inputs);

  const redactor = createCountingRedactor(inputs);
  const redacted = mapStrings(collected, redactor.redact);

  const { document: clipped, clippedBytes } = clipDocument(redacted);

  const scanFound: DiagnosticsCounts = { paths: 0, authCodes: 0, tokens: 0, emails: 0 };
  let maskedInScan = 0;
  const scanned = mapStrings(clipped, (text) => {
    const result = scanText(text, scanRules);
    for (const category of Object.keys(scanFound) as (keyof DiagnosticsCounts)[])
      scanFound[category] += result.found[category];
    maskedInScan += result.total;
    return result.text;
  });

  const { document, droppedBytes } = dropToFit(scanned, maxBytes);
  // Check the strings, not the serialized text: JSON doubles a backslash, so a harmless `\dist\x` would look like a share.
  let leftover = 0;
  mapStrings(document, (value) => {
    leftover += scanText(value, scanRules).total;
    return value;
  });
  const text = serialize(document);
  if (leftover > 0 || !isSameDocument(text, document)) throw new DiagnosticsError();

  return {
    text,
    report: {
      categories: {
        paths: redactor.counts.paths + scanFound.paths,
        authCodes: redactor.counts.authCodes + scanFound.authCodes,
        tokens: redactor.counts.tokens + scanFound.tokens,
        emails: redactor.counts.emails + scanFound.emails,
      },
      maskedInScan,
      omittedOutputLines: collected.omittedOutputLines,
      ...(droppedDetails > 0 ? { droppedDetails } : {}),
      truncatedBytes: clippedBytes + droppedBytes,
    },
  };
}
