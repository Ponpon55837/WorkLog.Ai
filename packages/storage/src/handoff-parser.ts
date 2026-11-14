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
// Native scans: they run outside the interpreter's per-character bookkeeping, which matters because a 200,000-character
// text is walked several times (and test coverage makes every JavaScript loop iteration much slower).
const NON_WHITESPACE = /\S/g;
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/g;
const LAST_LINE_TERMINATOR = /[\n\r\u2028\u2029][^\n\r\u2028\u2029]*$/;
// A line lead: the start of the text or a line break, the whitespace after it, then the first other character.
const LINE_LEAD = /(?:^|[\n\r\u2028\u2029])\s*(?=\S)/g;
// A description separator that starts after this many characters cannot leave a token of at most 1,000 characters.
const FILE_TOKEN_SEPARATOR_SCAN_LIMIT = 1_000;
const MAX_FILE_TOKEN_LENGTH = 1_000;

type LineLeadVisitor = (index: number, lineStart: number) => number | undefined;

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
  NON_WHITESPACE.lastIndex = from;
  const match = NON_WHITESPACE.exec(text);
  return match ? match.index : text.length;
}

function indexOfLineTerminator(text: string, from: number): number {
  LINE_TERMINATOR.lastIndex = from;
  const match = LINE_TERMINATOR.exec(text);
  return match ? match.index : text.length;
}

function lastLineTerminatorIn(text: string, from: number, to: number): number {
  const match = LAST_LINE_TERMINATOR.exec(text.slice(from, to));
  return match ? from + match.index : -1;
}

/** End of the text on a line once the whitespace before the line break is dropped (`.+?\s*$` on one line). */
function trimmedLineEnd(text: string, start: number, lineEnd: number): number {
  return start + text.slice(start, lineEnd).trimEnd().length;
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

// Last text given to scanLineLeads with its trailing whitespace trimmed.
let leadBodySource = "";
let leadBody = "";

/**
 * Visits every first non-whitespace character that a multiline `^\s*` can reach: the character has only whitespace
 * before it on its line. `visit` gets that index and the first line start that reaches it, and returns undefined to
 * keep scanning or the index to continue from (a match end). The start of the text counts as a line start only when
 * scanning from 0.
 */
function scanLineLeads(text: string, from: number, visit: LineLeadVisitor): void {
  // The trimmed text is cached: sections call this many times on the same text and trimming is O(length) each time.
  if (leadBodySource !== text) {
    leadBodySource = text;
    leadBody = text.trimEnd();
  }
  const body = leadBody;
  const limit = body.length;
  let next = from;
  while (next < limit) {
    LINE_LEAD.lastIndex = next;
    const match = LINE_LEAD.exec(body);
    if (!match) {
      return;
    }
    const lead = match.index + match[0].length;
    const resume = visit(lead, match.index === 0 && from === 0 ? 0 : match.index + 1);
    next = Math.max(resume ?? lead + 1, lead + 1);
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
    scanLineLeads(text, anchor + 1, (index, lineStart) => {
      if (!isHeadingStartAt(text, index)) {
        return undefined;
      }
      result = { lead: lineStart, index };
      return text.length;
    });
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
  scanLineLeads(content, 0, (index) => {
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

/** Right edges of one line, computed once for every file token read from lines that end at the same place. */
interface LineTail {
  end: number;
  /** The smallest line start that used this tail; scans stop here, so later (larger) starts reuse them. */
  floor: number;
  /** End of the line without trailing whitespace. */
  trimmedEnd: number;
  withoutBackticksEnd?: number;
  contentEnd?: number;
  arrowIndex?: number;
  arrowToken?: { value: string | undefined };
}

function isUpperCaseOrQuestionMark(code: number): boolean {
  return code === 0x3f || (code >= 0x41 && code <= 0x5a);
}

function skipWhitespaceUntil(text: string, from: number, limit: number): number {
  let index = from;
  while (index < limit && isWhitespaceAt(text, index)) {
    index += 1;
  }
  return index;
}

/** Index of the first whitespace run in [start, end) followed by `-`, an em dash, or `:` and more whitespace. */
function findDescriptionSeparator(text: string, start: number, end: number, limit = Infinity): number {
  let index = start;
  while (index < end && index <= start + limit) {
    if (!isWhitespaceAt(text, index)) {
      index += 1;
      continue;
    }
    const runEnd = skipWhitespaceUntil(text, index, end);
    const marker = runEnd < end ? text.charAt(runEnd) : "";
    if (
      ((marker === "-" || marker === "—") && runEnd + 1 < end && isWhitespaceAt(text, runEnd + 1)) ||
      (marker === ":" && runEnd + 2 < end && isWhitespaceAt(text, runEnd + 1) && isWhitespaceAt(text, runEnd + 2))
    ) {
      return index;
    }
    index = runEnd;
  }
  return -1;
}

/** The checks that decide whether the cleaned-up value of a line is a file path. */
function fileTokenFromValue(value: string): string | undefined {
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

/** Cuts a value at its description separator (` - note`, ` : note`) and applies the path checks. */
function fileTokenFromRange(
  text: string,
  start: number,
  end: number,
  findSeparator: (start: number, end: number) => number = (from, to) =>
    findDescriptionSeparator(text, from, to, FILE_TOKEN_SEPARATOR_SCAN_LIMIT),
): string | undefined {
  let valueStart = start;
  let valueEnd = end;
  const separator = findSeparator(start, end);
  if (separator > start) {
    valueEnd = separator;
    valueStart = skipWhitespaceUntil(text, valueStart, valueEnd);
    while (valueEnd > valueStart && isWhitespaceAt(text, valueEnd - 1)) {
      valueEnd -= 1;
    }
  }
  // Longer than any token, so it is not sliced out of a text that may be 200,000 characters long.
  return valueEnd - valueStart > MAX_FILE_TOKEN_LENGTH
    ? undefined
    : fileTokenFromValue(text.slice(valueStart, valueEnd));
}

/**
 * Reads file tokens from lines of `text` given as [start, end) ranges, with the result of `fileTokenFromLine` for
 * `text.slice(start, end)`. Lines that start at different places but end at the same place (a section reached from many
 * headings that no `\n` separates) share their right side, so everything that looks at the right edge is computed once
 * per line end and only the work on the left of each line is repeated. Starts must not decrease for one line end.
 */
function createFileTokenReader(text: string): (start: number, end: number) => string | undefined {
  let tail: LineTail | undefined;
  let terminatorFrom = 0;
  let terminatorAt = -1;
  const nextTerminator = (from: number): number => {
    if (terminatorAt < 0 || from < terminatorFrom || from > terminatorAt) {
      terminatorFrom = from;
      terminatorAt = indexOfLineTerminator(text, from);
    }
    return terminatorAt;
  };
  // The first separator at or after `from` on lines that end at `end`; later starts reuse it while it is still ahead of them,
  // so lines that share a long right side are not each scanned for 1000 characters.
  let separatorEnd = -1;
  let separatorFrom = 0;
  let separatorAt = -1;
  const separatorWithin = (start: number, end: number): number => {
    if (separatorEnd !== end || start < separatorFrom || (separatorAt >= 0 && separatorAt < start)) {
      separatorEnd = end;
      separatorFrom = start;
      separatorAt = findDescriptionSeparator(text, start, end);
    }
    return separatorAt >= 0 && separatorAt <= start + FILE_TOKEN_SEPARATOR_SCAN_LIMIT ? separatorAt : -1;
  };
  const tailOf = (start: number, end: number): LineTail => {
    if (tail && tail.end === end && start >= tail.floor) {
      return tail;
    }
    let trimmedEnd = end;
    while (trimmedEnd > start && isWhitespaceAt(text, trimmedEnd - 1)) {
      trimmedEnd -= 1;
    }
    tail = { end, floor: start, trimmedEnd };
    return tail;
  };
  const withoutBackticksEnd = (line: LineTail): number => {
    if (line.withoutBackticksEnd === undefined) {
      let edge = line.trimmedEnd;
      while (edge > line.floor && text.charCodeAt(edge - 1) === 0x60) {
        edge -= 1;
      }
      line.withoutBackticksEnd = edge;
    }
    return line.withoutBackticksEnd;
  };
  const contentEnd = (line: LineTail): number => {
    if (line.contentEnd === undefined) {
      let edge = withoutBackticksEnd(line);
      while (edge > line.floor && isWhitespaceAt(text, edge - 1)) {
        edge -= 1;
      }
      line.contentEnd = edge;
    }
    return line.contentEnd;
  };
  // None of the clean-up on the left of a line removes `=` or `>`, so the last `=>` is the same for every start.
  const lastArrow = (line: LineTail): number => {
    if (line.arrowIndex === undefined) {
      line.arrowIndex = -1;
      for (let index = line.end - 2; index >= line.floor; index -= 1) {
        if (text.charCodeAt(index) === 0x3d && text.charCodeAt(index + 1) === 0x3e) {
          line.arrowIndex = index;
          break;
        }
      }
    }
    return line.arrowIndex;
  };

  return (start, end) => {
    const line = tailOf(start, end);
    const first = skipWhitespaceUntil(text, start, line.trimmedEnd);
    if (first >= line.trimmedEnd || (text.startsWith("``", first) && first + 1 < line.trimmedEnd)) {
      return undefined;
    }
    const valueEnd = contentEnd(line);
    const arrow = lastArrow(line);
    if (arrow >= first) {
      // The text after the last `=>` is the value, whatever stands before it.
      if (line.arrowToken === undefined) {
        const arrowValueStart = skipWhitespaceUntil(text, arrow + 2, valueEnd);
        line.arrowToken = {
          value:
            arrowValueStart >= valueEnd
              ? undefined
              : fileTokenFromRange(text, arrowValueStart, valueEnd, separatorWithin),
        };
      }
      return line.arrowToken.value;
    }

    let valueStart = first;
    // A list marker (`-`, `*`, `+`, `1.`, `1)`) and the whitespace after it, when the rest has no line break.
    let markerEnd = valueStart;
    if (["-", "*", "+"].includes(text.charAt(valueStart))) {
      markerEnd = valueStart + 1;
    } else {
      while (markerEnd < line.trimmedEnd && text.charCodeAt(markerEnd) >= 0x30 && text.charCodeAt(markerEnd) <= 0x39) {
        markerEnd += 1;
      }
      const delimiter = markerEnd < line.trimmedEnd ? text.charAt(markerEnd) : "";
      markerEnd = markerEnd > valueStart && (delimiter === "." || delimiter === ")") ? markerEnd + 1 : valueStart;
    }
    if (markerEnd > valueStart) {
      const textStart = skipWhitespaceUntil(text, markerEnd, line.trimmedEnd);
      if (textStart > markerEnd && nextTerminator(textStart) >= line.trimmedEnd) {
        valueStart = textStart;
      }
    }
    // A checkbox (`[ ]`, `[x]`) and the whitespace after it.
    if (
      text.charCodeAt(valueStart) === 0x5b &&
      " xX".includes(text.charAt(valueStart + 1)) &&
      text.charCodeAt(valueStart + 2) === 0x5d &&
      valueStart + 3 < line.trimmedEnd &&
      isWhitespaceAt(text, valueStart + 3)
    ) {
      valueStart = skipWhitespaceUntil(text, valueStart + 3, line.trimmedEnd);
    }
    valueStart = skipWhitespaceUntil(text, valueStart, line.trimmedEnd);
    // Backticks around the value.
    while (valueStart < line.trimmedEnd && text.charCodeAt(valueStart) === 0x60) {
      valueStart += 1;
    }
    if (valueStart >= line.trimmedEnd) {
      return undefined;
    }
    valueStart = skipWhitespaceUntil(text, valueStart, withoutBackticksEnd(line));
    if (valueStart >= valueEnd) {
      return undefined;
    }
    // A one or two character status prefix such as `M ` or `??`.
    let prefixLength = 0;
    while (prefixLength < 2 && valueStart + prefixLength < valueEnd) {
      if (!isUpperCaseOrQuestionMark(text.charCodeAt(valueStart + prefixLength))) {
        break;
      }
      prefixLength += 1;
    }
    for (let length = prefixLength; length >= 1; length -= 1) {
      if (valueStart + length < valueEnd && isWhitespaceAt(text, valueStart + length)) {
        valueStart = skipWhitespaceUntil(text, valueStart + length, valueEnd);
        break;
      }
    }
    return valueStart >= valueEnd ? undefined : fileTokenFromRange(text, valueStart, valueEnd, separatorWithin);
  };
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
  scanLineLeads(source, 0, (index) => {
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
  scanLineLeads(source, 0, (index) => {
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
  return createFileTokenReader(line)(0, line.length);
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
  const readFileToken = createFileTokenReader(source);
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
      const token = readFileToken(lineStart, lineEnd);
      if (token) {
        add(token);
      }
      if (values.length >= MAX_PARSED_CHANGED_FILES || lineEnd >= end || repeated) {
        break;
      }
      lineStart = lineEnd + 1;
    }
  };

  scanLineLeads(source, 0, (index) => {
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
