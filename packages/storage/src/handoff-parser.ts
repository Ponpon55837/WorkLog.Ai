import { basename } from "node:path";
import type { HandoffImportDecision, HandoffImportReason, VerificationSummary } from "@work-intelligence/core";
import { truncateText } from "@work-intelligence/shared";

export type HandoffClassification = {
  decision: HandoffImportDecision;
  reason?: HandoffImportReason;
  detail?: string;
};

export const MAX_HANDOFF_CONTENT_LENGTH = 200_000;
export const MAX_HANDOFF_STATUS_SIGNALS = 32;
export const MAX_PARSED_CHANGED_FILES = 200;

export type ParsedHandoffContent = {
  title: string;
  summary: string;
  recordedDate?: string;
  verification: VerificationSummary;
  changedFiles: string[];
  classification: HandoffClassification;
};

// Every pattern below is applied to one line (or one whitespace run) at a time. A multiline `^\s*...$` regex lets
// `\s*` run across newlines, so a blank-line or long-whitespace input made it rescan the same run from every line
// start (quadratic on the 200,000-character cap). The helpers keep the exact multiline-regex semantics (`\s` crosses
// line breaks, `^` and `$` follow the four JavaScript line terminators) but touch each character a bounded number of
// times.
const STATUS_LINE_HEAD = /(?:#{1,6}\s*)?(?:final\s+)?status(?:\s+signals?)?\s*[:：|]/iy;
const STATUS_HEADING_HEAD = /#{1,6}\s*(?:final\s+)?status/iy;
const CHANGED_FILES_HEADING_HEAD =
  /#{1,6}\s*(?:changed files?|files changed|modified files?|files modified|變更檔案|修改檔案)/iy;
const INLINE_CHANGED_FILES_HEAD = /(?:changedFiles|changed files)\s*[:=]\s*\[/i;
const WHITESPACE_CHARACTER = /\s/;
// A description separator that starts after this many characters cannot leave a token of at most 1,000 characters.
const FILE_TOKEN_SEPARATOR_SCAN_LIMIT = 1_000;
const MAX_FILE_TOKEN_LENGTH = 1_000;

type LineLeadVisitor = (index: number) => number | undefined;

function isLineTerminatorCode(code: number): boolean {
  return code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029;
}

/** Same character set as the regex `\s` (white space plus the line terminators). */
function isWhitespaceAt(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  if (code === 0x20 || (code >= 0x09 && code <= 0x0d)) {
    return true;
  }
  return code >= 0xa0 && WHITESPACE_CHARACTER.test(text.charAt(index));
}

function skipWhitespace(text: string, from: number): number {
  let index = from;
  while (index < text.length && isWhitespaceAt(text, index)) {
    index += 1;
  }
  return index;
}

function indexOfLineTerminator(text: string, from: number, limit = text.length): number {
  for (let index = from; index < limit; index += 1) {
    if (isLineTerminatorCode(text.charCodeAt(index))) {
      return index;
    }
  }
  return limit;
}

function lastLineTerminatorIn(text: string, from: number, to: number): number {
  for (let index = to - 1; index >= from; index -= 1) {
    if (isLineTerminatorCode(text.charCodeAt(index))) {
      return index;
    }
  }
  return -1;
}

/** End of the text on a line once the whitespace before the line break is dropped (`.+?\s*$` on one line). */
function trimmedLineEnd(text: string, start: number, lineEnd: number): number {
  let end = lineEnd;
  while (end > start && isWhitespaceAt(text, end - 1)) {
    end -= 1;
  }
  return end;
}

/**
 * Where `\s*:?\s*$` (multiline) ends after `from`, or -1 when it cannot match. Greedy backtracking prefers the
 * longest whitespace run, so the match ends at the end of the text or before the last line terminator inside the run.
 */
function endOfTrailingWhitespace(text: string, from: number, allowColon: boolean): number {
  const run = skipWhitespace(text, from);
  if (allowColon && text.charCodeAt(run) === 0x3a) {
    const afterColon = skipWhitespace(text, run + 1);
    if (afterColon === text.length) {
      return afterColon;
    }
    const lastBreak = lastLineTerminatorIn(text, run + 1, afterColon);
    if (lastBreak >= 0) {
      return lastBreak;
    }
  } else if (run === text.length) {
    return run;
  }
  return lastLineTerminatorIn(text, from, run);
}

/**
 * Visits every first non-whitespace character that a multiline `^\s*` can reach: the character has only whitespace
 * before it on its line. `visit` returns undefined to keep scanning or the index to continue from (a match end).
 */
function scanLineLeads(text: string, from: number, atLineStart: boolean, visit: LineLeadVisitor): void {
  let index = from;
  let atLead = atLineStart;
  while (index < text.length) {
    if (isLineTerminatorCode(text.charCodeAt(index))) {
      atLead = true;
      index += 1;
    } else if (isWhitespaceAt(text, index)) {
      index += 1;
    } else if (atLead) {
      const resume = visit(index);
      atLead = false;
      index = resume ?? indexOfLineTerminator(text, index + 1);
    } else {
      index = indexOfLineTerminator(text, index + 1);
    }
  }
}

/** Matches `#{1,6}\s+` at `index`. */
function isHeadingStartAt(text: string, index: number): boolean {
  let end = index;
  while (end < text.length && text.charCodeAt(end) === 0x23) {
    end += 1;
  }
  const depth = end - index;
  return depth >= 1 && depth <= 6 && end < text.length && isWhitespaceAt(text, end);
}

/**
 * Finds where the section that starts at `start` ends: the start of the first line from which `^\s*#{1,6}\s+` matches
 * when the section text is searched on its own (its first character counts as a line start). Sections are visited in
 * increasing order, so the last scan result is reused and the whole document is scanned once.
 */
function createSectionEndFinder(text: string): (start: number) => number {
  let scannedAfter = -1;
  let found: { lead: number; index: number } | undefined;
  const scanAfter = (anchor: number): { lead: number; index: number } | undefined => {
    if (scannedAfter >= 0 && anchor >= scannedAfter && (found === undefined || found.index > anchor)) {
      return found;
    }
    let result: { lead: number; index: number } | undefined;
    let lead = -1;
    let index = anchor + 1;
    while (index < text.length && result === undefined) {
      if (isLineTerminatorCode(text.charCodeAt(index))) {
        lead = lead < 0 ? index + 1 : lead;
        index += 1;
      } else if (isWhitespaceAt(text, index)) {
        index += 1;
      } else {
        if (lead >= 0 && isHeadingStartAt(text, index)) {
          result = { lead, index };
        }
        lead = -1;
        index = indexOfLineTerminator(text, index + 1);
      }
    }
    scannedAfter = anchor;
    found = result;
    return result;
  };
  return (start) => {
    const first = skipWhitespace(text, start);
    if (first >= text.length) {
      return text.length;
    }
    if (isHeadingStartAt(text, first)) {
      return start;
    }
    return scanAfter(first)?.lead ?? text.length;
  };
}

/** First heading text of `# title`, "" when the match is only whitespace, undefined when no heading matches. */
function findTitleHeading(content: string): string | undefined {
  let heading: string | undefined;
  scanLineLeads(content, 0, true, (index) => {
    if (content.charCodeAt(index) !== 0x23) {
      return undefined;
    }
    const afterHash = index + 1;
    const textStart = skipWhitespace(content, afterHash);
    if (textStart === afterHash) {
      return undefined;
    }
    if (textStart < content.length) {
      heading = content.slice(textStart, trimmedLineEnd(content, textStart, indexOfLineTerminator(content, textStart)));
      return content.length;
    }
    // The whitespace reaches the end of the text, so `.+?` can only take one of its non-break characters.
    if (indexOfLineTerminatorFree(content, afterHash + 1) >= 0) {
      heading = "";
      return content.length;
    }
    return undefined;
  });
  return heading?.trim();
}

/** Index of the first character at or after `from` that is not a line terminator, or -1. */
function indexOfLineTerminatorFree(text: string, from: number): number {
  for (let index = from; index < text.length; index += 1) {
    if (!isLineTerminatorCode(text.charCodeAt(index))) {
      return index;
    }
  }
  return -1;
}

/** Value of a `status: value` line, which may sit on a later line because `\s*` after the colon crosses breaks. */
function matchStatusLine(text: string, index: number): { value: string; end: number } | undefined {
  STATUS_LINE_HEAD.lastIndex = index;
  const head = STATUS_LINE_HEAD.exec(text);
  if (!head) {
    return undefined;
  }
  const delimiterEnd = index + head[0].length;
  const valueStart = skipWhitespace(text, delimiterEnd);
  if (valueStart < text.length) {
    const valueEnd = trimmedLineEnd(text, valueStart, indexOfLineTerminator(text, valueStart));
    const end = endOfTrailingWhitespace(text, valueEnd, false);
    return { value: text.slice(valueStart, valueEnd), end };
  }
  // Only whitespace follows: `.+?` takes one non-break whitespace character, which trims to an empty value.
  return indexOfLineTerminatorFree(text, delimiterEnd) >= 0 ? { value: "", end: text.length } : undefined;
}

function mayStartStatusLine(character: string): boolean {
  return character === "#" || character === "f" || character === "F" || character === "s" || character === "S";
}

/** Replaces `^(?:[-*+]|\d+[.)])\s+(.*)$`: the rest of the line after the marker, or the value unchanged. */
function withoutListMarker(value: string): string {
  let markerEnd = 0;
  const first = value.charAt(0);
  if (first === "-" || first === "*" || first === "+") {
    markerEnd = 1;
  } else {
    while (markerEnd < value.length && value.charCodeAt(markerEnd) >= 0x30 && value.charCodeAt(markerEnd) <= 0x39) {
      markerEnd += 1;
    }
    const delimiter = value.charAt(markerEnd);
    if (markerEnd === 0 || (delimiter !== "." && delimiter !== ")")) {
      return value;
    }
    markerEnd += 1;
  }
  const textStart = skipWhitespace(value, markerEnd);
  if (textStart === markerEnd || indexOfLineTerminator(value, textStart) < value.length) {
    return value;
  }
  return value.slice(textStart);
}

/** Replaces `.replace(/^`+|`+$/g, "")`, which retried every backtick of a long run. */
function withoutEdgeBackticks(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 0x60) {
    start += 1;
  }
  while (end > start && value.charCodeAt(end - 1) === 0x60) {
    end -= 1;
  }
  return value.slice(start, end);
}

/** Index of the first whitespace run followed by `-`, an em dash, or `:` and more whitespace (`\s+(?:-|—|:\s)\s+`). */
function findDescriptionSeparator(value: string): number {
  let index = 0;
  while (index < value.length && index <= FILE_TOKEN_SEPARATOR_SCAN_LIMIT) {
    if (!isWhitespaceAt(value, index)) {
      index += 1;
      continue;
    }
    const runEnd = skipWhitespace(value, index);
    const marker = value.charAt(runEnd);
    if (
      ((marker === "-" || marker === "—") && runEnd + 1 < value.length && isWhitespaceAt(value, runEnd + 1)) ||
      (marker === ":" &&
        runEnd + 2 < value.length &&
        isWhitespaceAt(value, runEnd + 1) &&
        isWhitespaceAt(value, runEnd + 2))
    ) {
      return index;
    }
    index = runEnd;
  }
  return -1;
}

export function stripFencedCodeBlocks(content: string): string {
  const lines = content.slice(0, MAX_HANDOFF_CONTENT_LENGTH).split(/\r?\n/);
  const visibleLines: string[] = [];
  let activeFence: "```" | "~~~" | undefined;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (activeFence) {
      if (trimmed.startsWith(activeFence)) {
        activeFence = undefined;
      }
      continue;
    }
    if (trimmed.startsWith("```")) {
      activeFence = "```";
      continue;
    }
    if (trimmed.startsWith("~~~")) {
      activeFence = "~~~";
      continue;
    }
    visibleLines.push(line);
  }
  return visibleLines.join("\n");
}

export function titleFromContent(content: string, sourcePath: string): string {
  const heading = findTitleHeading(content.slice(0, MAX_HANDOFF_CONTENT_LENGTH));
  const fallback = basename(sourcePath).replace(/\.md$/i, "");
  return truncateText(heading || fallback, 300);
}

export function findStatusSignals(content: string): string[] {
  return statusSignalsFromSource(stripFencedCodeBlocks(content));
}

function statusSignalsFromSource(source: string): string[] {
  const signals: string[] = [];
  scanLineLeads(source, 0, true, (index) => {
    if (!mayStartStatusLine(source.charAt(index))) {
      return undefined;
    }
    const match = matchStatusLine(source, index);
    if (!match) {
      return undefined;
    }
    if (match.value) {
      signals.push(match.value);
    }
    return signals.length >= MAX_HANDOFF_STATUS_SIGNALS ? source.length : match.end;
  });

  let headingEnd = -1;
  scanLineLeads(source, 0, true, (index) => {
    if (!mayStartStatusLine(source.charAt(index))) {
      return undefined;
    }
    STATUS_HEADING_HEAD.lastIndex = index;
    const head = STATUS_HEADING_HEAD.exec(source);
    const end = head ? endOfTrailingWhitespace(source, index + head[0].length, false) : -1;
    if (end < 0) {
      return undefined;
    }
    headingEnd = end;
    return source.length;
  });
  if (headingEnd >= 0) {
    const followingLines = source
      .slice(headingEnd)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const nextLine = followingLines.find((line) => !line.startsWith("#"));
    if (nextLine && signals.length < MAX_HANDOFF_STATUS_SIGNALS) {
      signals.push(nextLine.replace(/^[-*]\s+/, "").trim());
    }
  }

  return [...new Set(signals)].slice(0, MAX_HANDOFF_STATUS_SIGNALS);
}

export function classifyHandoff(title: string, statusSignals: string[]): HandoffClassification {
  const statusText = [title, ...statusSignals].join(" ");
  if (/\bblocked\b|\bblocking\b|阻塞|被阻擋/i.test(statusText)) {
    return { decision: "excluded", reason: "blocked", detail: "Blocked handoffs are excluded from historical import." };
  }
  if (/\bpending\b|\bin[- ]progress\b|\bnot started\b|待處理|進行中|未開始/i.test(statusText)) {
    return {
      decision: "excluded",
      reason: "pending",
      detail: "Pending or in-progress handoffs are excluded from historical import.",
    };
  }
  if (/\bcomplete(?:d)?\b|\baccepted\b|\bresolved\b|\bdone\b|\bimplemented\b|\bready\b/i.test(statusText)) {
    return { decision: "eligible" };
  }
  if (/\bplanning\b|\bplanned\b|\bdraft\b|\bproposal\b|規劃|計畫/i.test(statusText)) {
    return {
      decision: "excluded",
      reason: "planning_only",
      detail: "Planning-only handoffs are excluded from historical import.",
    };
  }
  return {
    decision: "excluded",
    reason: "no_explicit_completion",
    detail: "No explicit completed, accepted, resolved, or implemented status was found.",
  };
}

export function parseRecordedDate(content: string): string | undefined {
  return content
    .slice(0, MAX_HANDOFF_CONTENT_LENGTH)
    .match(/(?:recorded\s+date|recorded|記錄日期)\s*(?:[:：]\s*)?(\d{4}-\d{2}-\d{2})/i)?.[1];
}

export function parseVerification(content: string): VerificationSummary {
  return verificationFromSource(stripFencedCodeBlocks(content));
}

function verificationFromSource(source: string): VerificationSummary {
  const explicit = source
    .match(/\bverification(?:\s+status)?\s*[:：=]\s*(passed|failed|not[ _-]?run)\b/i)?.[1]
    ?.toLowerCase();
  const failedEvidence =
    /(?:result|verification|tests?|checks?|typecheck|build)[^\n]{0,100}\b(?:failed|failure|errors?\s*(?:[:=]\s*)?[1-9]\d*)\b/i.test(
      source,
    );
  const passedEvidence =
    /(?:result|verification|tests?|checks?|typecheck|build)[^\n]{0,100}\b(?:passed|pass|0\s+errors?|success(?:ful)?)\b/i.test(
      source,
    );
  const notRunEvidence = /\bverification\b[^\n]{0,60}\bnot[ _-]?run\b/i.test(source);

  const status =
    explicit?.replace(/[ _-]/g, "_") ??
    (failedEvidence ? "failed" : passedEvidence ? "passed" : notRunEvidence ? "not_run" : "not_run");
  if (status === "passed") {
    return {
      status: "passed",
      summary: "Historical handoff reports a passed verification; no new check was executed by the importer.",
    };
  }
  if (status === "failed") {
    return {
      status: "failed",
      summary: "Historical handoff reports a failed verification; no new check was executed by the importer.",
    };
  }
  return { status: "not_run", summary: "Historical handoff import did not execute a new verification command." };
}

function normalizeFileCandidate(projectRoot: string, value: string): string {
  let normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((segment) => segment === "..")
  ) {
    return "";
  }
  const projectName = basename(projectRoot).toLowerCase();
  if (normalized.toLowerCase().startsWith(`${projectName}/`)) {
    normalized = normalized.slice(projectName.length + 1);
  }
  return normalized;
}

export function fileTokenFromLine(line: string): string | undefined {
  let value = line.trim();
  if (!value || value.startsWith("``")) {
    return undefined;
  }
  value = withoutListMarker(value);
  value = value.replace(/^\[[ xX]\]\s+/, "").trim();
  value = withoutEdgeBackticks(value).trim();
  value = value.replace(/^[A-Z?]{1,2}\s+/, "");
  if (value.includes("=>")) {
    value = value.split("=>").at(-1)?.trim() ?? value;
  }
  const descriptionIndex = findDescriptionSeparator(value);
  if (descriptionIndex > 0) {
    value = value.slice(0, descriptionIndex).trim();
  }
  if (!value || value.length > MAX_FILE_TOKEN_LENGTH || /^https?:\/\//i.test(value)) {
    return undefined;
  }
  if (
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.split(/[\\/]/).some((segment) => segment === "..")
  ) {
    return undefined;
  }
  if (
    !value.includes("/") &&
    !value.includes("\\") &&
    !/\.(?:[a-z0-9]{1,12})$/i.test(value) &&
    !/^(?:README|LICENSE|Dockerfile)(?:\..*)?$/i.test(value)
  ) {
    return undefined;
  }
  return value;
}

export function extractChangedFiles(content: string, projectRoot: string): string[] {
  return changedFilesFromSource(stripFencedCodeBlocks(content), projectRoot);
}

function changedFilesFromSource(source: string, projectRoot: string): string[] {
  const values: string[] = [];
  const identities = new Set<string>();
  const add = (value: string): void => {
    if (values.length >= MAX_PARSED_CHANGED_FILES) {
      return;
    }
    const normalized = normalizeFileCandidate(projectRoot, value);
    if (!normalized) {
      return;
    }
    const identity = normalized.toLowerCase();
    if (!identities.has(identity)) {
      identities.add(identity);
      values.push(normalized);
    }
  };

  // The first `changedFiles: [` decides: without a closing bracket after it, no later opening can have one either.
  const inlineHead = INLINE_CHANGED_FILES_HEAD.exec(source);
  const inlineStart = inlineHead ? inlineHead.index + inlineHead[0].length : -1;
  const inlineEnd = inlineStart >= 0 ? source.indexOf("]", inlineStart) : -1;
  const inline = inlineEnd >= 0 ? source.slice(inlineStart, inlineEnd) : undefined;
  if (inline) {
    for (const match of inline.matchAll(/["'`]([^"'`]+)["'`]/g)) {
      if (match[1]) {
        add(match[1]);
      }
      if (values.length >= MAX_PARSED_CHANGED_FILES) {
        break;
      }
    }
  }

  const findSectionEnd = createSectionEndFinder(source);
  // Sections that run to the end of a text without "\n" would each search the whole rest again, so the last answer is kept.
  let newlineFrom = 0;
  let newlineAt = source.indexOf("\n");
  const nextNewline = (from: number): number => {
    if (from < newlineFrom || (newlineAt >= 0 && from > newlineAt)) {
      newlineFrom = from;
      newlineAt = source.indexOf("\n", from);
    }
    return newlineAt < 0 ? source.length : newlineAt;
  };
  let previousSection: { start: number; end: number } | undefined;
  const readSection = (start: number): void => {
    const end = findSectionEnd(start);
    // A section that starts inside the previous one and stops at the same heading repeats its lines (only the first
    // line starts at a different place), so reading them again cannot add a value.
    const repeated = previousSection !== undefined && start < previousSection.end && end === previousSection.end;
    previousSection = { start, end };
    let lineStart = start;
    while (true) {
      const lineEnd = Math.min(nextNewline(lineStart), end);
      const token = fileTokenFromLine(source.slice(lineStart, lineEnd));
      if (token) {
        add(token);
      }
      if (values.length >= MAX_PARSED_CHANGED_FILES || lineEnd >= end || repeated) {
        break;
      }
      lineStart = lineEnd + 1;
    }
  };

  scanLineLeads(source, 0, true, (index) => {
    if (values.length >= MAX_PARSED_CHANGED_FILES) {
      return source.length;
    }
    CHANGED_FILES_HEADING_HEAD.lastIndex = index;
    const head = CHANGED_FILES_HEADING_HEAD.exec(source);
    const sectionStart = head ? endOfTrailingWhitespace(source, index + head[0].length, true) : -1;
    if (sectionStart < 0) {
      return undefined;
    }
    readSection(sectionStart);
    return sectionStart;
  });
  return values;
}

export function summaryFromContent(content: string, sourcePath: string): string {
  return summaryFromSource(stripFencedCodeBlocks(content), sourcePath);
}

function summaryFromSource(source: string, sourcePath: string): string {
  const firstUsefulLine = source
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, "").trim())
    .find(
      (line) =>
        line.length >= 24 && !line.startsWith("#") && !/^(?:status|recorded date|verification)\s*[:：]/i.test(line),
    );
  const detail = firstUsefulLine ? ` ${truncateText(firstUsefulLine, 1_200)}` : "";
  return `Historical handoff imported from ${sourcePath}.${detail}`;
}

export function parseHandoffContent(content: string, projectRoot: string, sourcePath: string): ParsedHandoffContent {
  const title = titleFromContent(content, sourcePath);
  // The fenced-block strip splits and joins every line, so it runs once for all the readers below.
  const source = stripFencedCodeBlocks(content);
  const statusSignals = statusSignalsFromSource(source);
  return {
    title,
    summary: summaryFromSource(source, sourcePath),
    recordedDate: parseRecordedDate(content),
    verification: verificationFromSource(source),
    changedFiles: changedFilesFromSource(source, projectRoot),
    classification: classifyHandoff(title, statusSignals),
  };
}
