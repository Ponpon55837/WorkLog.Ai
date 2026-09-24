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
  const heading = content
    .slice(0, MAX_HANDOFF_CONTENT_LENGTH)
    .match(/^\s*#\s+(.+?)\s*$/m)?.[1]
    ?.trim();
  const fallback = basename(sourcePath).replace(/\.md$/i, "");
  return truncateText(heading || fallback, 300);
}

export function findStatusSignals(content: string): string[] {
  const source = stripFencedCodeBlocks(content);
  const signals: string[] = [];
  for (const match of source.matchAll(
    /^\s*(?:#{1,6}\s*)?(?:final\s+)?status(?:\s+signals?)?\s*[:：|]\s*(.+?)\s*$/gim,
  )) {
    const value = match[1]?.trim();
    if (value) {
      signals.push(value);
    }
    if (signals.length >= MAX_HANDOFF_STATUS_SIGNALS) {
      break;
    }
  }

  const heading = source.match(/^\s*#{1,6}\s*(?:final\s+)?status\s*$/im);
  if (heading) {
    const followingLines = source
      .slice((heading.index ?? 0) + heading[0].length)
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
    .match(/(?:recorded\s+date|recorded|記錄日期)\s*[:：]?\s*(\d{4}-\d{2}-\d{2})/i)?.[1];
}

export function parseVerification(content: string): VerificationSummary {
  const source = stripFencedCodeBlocks(content);
  const explicit = source
    .match(/\bverification(?:\s+status)?\s*[:：=]\s*(passed|failed|not[ _-]?run)\b/i)?.[1]
    ?.toLowerCase();
  const failedEvidence =
    /(?:result|verification|tests?|checks?|typecheck|build)[^\n]{0,100}\b(?:failed|failure|errors?\s*[:=]?\s*[1-9]\d*)\b/i.test(
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
  const listItem = value.match(/^(?:[-*+]|\d+[.)])\s+(.*)$/);
  if (listItem) {
    value = listItem[1] ?? "";
  }
  value = value.replace(/^\[[ xX]\]\s+/, "").trim();
  value = value.replace(/^`+|`+$/g, "").trim();
  value = value.replace(/^[A-Z?]{1,2}\s+/, "");
  if (value.includes("=>")) {
    value = value.split("=>").at(-1)?.trim() ?? value;
  }
  const descriptionIndex = value.search(/\s+(?:-|—|:\s)\s+/);
  if (descriptionIndex > 0) {
    value = value.slice(0, descriptionIndex).trim();
  }
  if (!value || value.length > 1_000 || /^https?:\/\//i.test(value)) {
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
  const source = stripFencedCodeBlocks(content);
  const values: string[] = [];
  const add = (value: string): void => {
    if (values.length >= MAX_PARSED_CHANGED_FILES) {
      return;
    }
    const normalized = normalizeFileCandidate(projectRoot, value);
    if (!normalized) {
      return;
    }
    const identity = normalized.toLowerCase();
    if (!values.some((item) => item.toLowerCase() === identity)) {
      values.push(normalized);
    }
  };

  const inline = source.match(/(?:changedFiles|changed files)\s*[:=]\s*\[([\s\S]*?)\]/i)?.[1];
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

  const sectionPattern =
    /^\s*#{1,6}\s*(?:changed files?|files changed|modified files?|files modified|變更檔案|修改檔案)\s*:?\s*$/gim;
  for (const match of source.matchAll(sectionPattern)) {
    if (values.length >= MAX_PARSED_CHANGED_FILES) {
      break;
    }
    const start = (match.index ?? 0) + match[0].length;
    const remainder = source.slice(start);
    const nextHeading = remainder.search(/^\s*#{1,6}\s+/m);
    const section = remainder.slice(0, nextHeading >= 0 ? nextHeading : undefined);
    for (const line of section.split("\n")) {
      const token = fileTokenFromLine(line);
      if (token) {
        add(token);
      }
      if (values.length >= MAX_PARSED_CHANGED_FILES) {
        break;
      }
    }
  }
  return values;
}

export function summaryFromContent(content: string, sourcePath: string): string {
  const firstUsefulLine = stripFencedCodeBlocks(content)
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
  const statusSignals = findStatusSignals(content);
  return {
    title,
    summary: summaryFromContent(content, sourcePath),
    recordedDate: parseRecordedDate(content),
    verification: parseVerification(content),
    changedFiles: extractChangedFiles(content, projectRoot),
    classification: classifyHandoff(title, statusSignals),
  };
}
