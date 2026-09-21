import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, relative } from "node:path";
import type {
  HandoffImportChangedFilesStatus,
  HandoffImportDecision,
  HandoffImportReason,
  VerificationSummary
} from "@work-intelligence/core";
import { truncateText } from "@work-intelligence/shared";
import { createProjectPathResolver, safeProjectPath } from "@work-intelligence/project-policy";

export const DEFAULT_HANDOFF_DIRECTORY = ".openspec/handoffs";

export interface HandoffImportCandidate {
  sourcePath: string;
  title: string;
  summary: string;
  content: string;
  completedAt?: string;
  recordedDate?: string;
  decision: HandoffImportDecision;
  reason?: HandoffImportReason;
  detail?: string;
  verification?: VerificationSummary;
  changedFiles: string[];
  changedFilesStatus: HandoffImportChangedFilesStatus;
}

export interface HandoffDiscoveryResult {
  handoffDirectory: string;
  directoryFound: boolean;
  truncated: boolean;
  candidates: HandoffImportCandidate[];
}

export interface HandoffDiscoveryOptions {
  handoffDirectory?: string;
  excludePaths?: string[];
  maxFiles?: number;
}

function normalizeRelativePath(projectRoot: string, value: string, label: string): string {
  const absolutePath = safeProjectPath(projectRoot, value);
  if (!absolutePath) {
    throw new Error(`${label} must remain inside the tracked project root: ${value}`);
  }
  const normalized = relative(projectRoot, absolutePath).replaceAll("\\", "/");
  if (!normalized || normalized === ".") {
    throw new Error(`${label} must identify a path inside the tracked project root: ${value}`);
  }
  return normalized;
}

function normalizeSelectionPath(projectRoot: string, value: string): string {
  return normalizeRelativePath(projectRoot, value.trim(), "Handoff path");
}

function isExcluded(sourcePath: string, excludePaths: string[]): boolean {
  return excludePaths.some((excludePath) => {
    const left = sourcePath.toLowerCase();
    const right = excludePath.toLowerCase().replace(/\/$/, "");
    return left === right || left.startsWith(`${right}/`);
  });
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function titleFromContent(content: string, sourcePath: string): string {
  const heading = content.match(/^\s*#\s+(.+?)\s*$/m)?.[1]?.trim();
  const fallback = basename(sourcePath).replace(/\.md$/i, "");
  return truncateText(heading || fallback, 300);
}

function findStatusSignals(content: string): string[] {
  const signals = [...content.matchAll(/^\s*(?:#{1,6}\s*)?(?:final\s+)?status(?:\s+signals?)?\s*[:：|]\s*(.+?)\s*$/gim)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));

  const heading = content.match(/^\s*#{1,6}\s*(?:final\s+)?status\s*$/im);
  if (heading) {
    const followingLines = content
      .slice((heading.index ?? 0) + heading[0].length)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const nextLine = followingLines.find((line) => !line.startsWith("#"));
    if (nextLine) {
      signals.push(nextLine.replace(/^[-*]\s+/, "").trim());
    }
  }

  return [...new Set(signals)];
}

function classifyHandoff(title: string, statusSignals: string[]): {
  decision: HandoffImportDecision;
  reason?: HandoffImportReason;
  detail?: string;
} {
  const statusText = [title, ...statusSignals].join(" ");
  if (/\bblocked\b|\bblocking\b|阻塞|被阻擋/i.test(statusText)) {
    return { decision: "excluded", reason: "blocked", detail: "Blocked handoffs are excluded from historical import." };
  }
  if (/\bpending\b|\bin[- ]progress\b|\bnot started\b|待處理|進行中|未開始/i.test(statusText)) {
    return { decision: "excluded", reason: "pending", detail: "Pending or in-progress handoffs are excluded from historical import." };
  }
  if (/\bcomplete(?:d)?\b|\baccepted\b|\bresolved\b|\bdone\b|\bimplemented\b|\bready\b/i.test(statusText)) {
    return { decision: "eligible" };
  }
  if (/\bplanning\b|\bplanned\b|\bdraft\b|\bproposal\b|規劃|計畫/i.test(statusText)) {
    return { decision: "excluded", reason: "planning_only", detail: "Planning-only handoffs are excluded from historical import." };
  }
  return {
    decision: "excluded",
    reason: "no_explicit_completion",
    detail: "No explicit completed, accepted, resolved, or implemented status was found."
  };
}

function parseRecordedDate(content: string): string | undefined {
  const value = content.match(/(?:recorded\s+date|recorded|記錄日期)\s*[:：]?\s*(\d{4}-\d{2}-\d{2})/i)?.[1];
  return value;
}

function parseCompletedAt(content: string, filePath: string, recordedDate?: string): string | undefined {
  if (recordedDate) {
    return `${recordedDate}T12:00:00.000Z`;
  }
  try {
    return statSync(filePath).mtime.toISOString();
  } catch {
    return undefined;
  }
}

function parseVerification(content: string): VerificationSummary {
  const explicit = content.match(/\bverification(?:\s+status)?\s*[:：=]\s*(passed|failed|not[ _-]?run)\b/i)?.[1]?.toLowerCase();
  const failedEvidence = /(?:result|verification|tests?|checks?|typecheck|build)[^\n]{0,100}\b(?:failed|failure|errors?\s*[:=]?\s*[1-9]\d*)\b/i.test(content);
  const passedEvidence = /(?:result|verification|tests?|checks?|typecheck|build)[^\n]{0,100}\b(?:passed|pass|0\s+errors?|success(?:ful)?)\b/i.test(content);
  const notRunEvidence = /\bverification\b[^\n]{0,60}\bnot[ _-]?run\b/i.test(content);

  const status = explicit?.replace(/[ _-]/g, "_") ?? (failedEvidence ? "failed" : passedEvidence ? "passed" : notRunEvidence ? "not_run" : "not_run");
  if (status === "passed") {
    return { status: "passed", summary: "Historical handoff reports a passed verification; no new check was executed by the importer." };
  }
  if (status === "failed") {
    return { status: "failed", summary: "Historical handoff reports a failed verification; no new check was executed by the importer." };
  }
  return { status: "not_run", summary: "Historical handoff import did not execute a new verification command." };
}

function normalizeFileCandidate(projectRoot: string, value: string): string {
  let normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  const projectName = basename(projectRoot).toLowerCase();
  if (normalized.toLowerCase().startsWith(`${projectName}/`)) {
    normalized = normalized.slice(projectName.length + 1);
  }
  return normalized;
}

function fileTokenFromLine(line: string): string | undefined {
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
  if (!value.includes("/") && !value.includes("\\") && !/\.(?:[a-z0-9]{1,12})$/i.test(value) && !/^(?:README|LICENSE|Dockerfile)(?:\..*)?$/i.test(value)) {
    return undefined;
  }
  return value;
}

function extractChangedFiles(content: string, projectRoot: string): string[] {
  const values: string[] = [];
  const add = (value: string): void => {
    const normalized = normalizeFileCandidate(projectRoot, value);
    if (!normalized) {
      return;
    }
    const identity = normalized.toLowerCase();
    if (!values.some((item) => item.toLowerCase() === identity)) {
      values.push(normalized);
    }
  };

  const inline = content.match(/(?:changedFiles|changed files)\s*[:=]\s*\[([\s\S]*?)\]/i)?.[1];
  if (inline) {
    for (const match of inline.matchAll(/["'`]([^"'`]+)["'`]/g)) {
      if (match[1]) {
        add(match[1]);
      }
    }
  }

  const sectionPattern = /^\s*#{1,6}\s*(?:changed files?|files changed|modified files?|files modified|變更檔案|修改檔案)\s*:?\s*$/gim;
  for (const match of content.matchAll(sectionPattern)) {
    const start = (match.index ?? 0) + match[0].length;
    const remainder = content.slice(start);
    const nextHeading = remainder.search(/^\s*#{1,6}\s+/m);
    const section = remainder.slice(0, nextHeading >= 0 ? nextHeading : undefined);
    for (const line of section.split("\n")) {
      const token = fileTokenFromLine(line);
      if (token) {
        add(token);
      }
    }
  }
  return values;
}

function summaryFromContent(content: string, sourcePath: string): string {
  const firstUsefulLine = content
    .replace(/```[\s\S]*?```/g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, "").trim())
    .find((line) => line.length >= 24 && !line.startsWith("#") && !/^(?:status|recorded date|verification)\s*[:：]/i.test(line));
  const detail = firstUsefulLine ? ` ${truncateText(firstUsefulLine, 1_200)}` : "";
  return `Historical handoff imported from ${sourcePath}.${detail}`;
}

function parseCandidate(projectRoot: string, filePath: string, sourcePath: string): HandoffImportCandidate {
  try {
    const content = readFileSync(filePath, "utf8").slice(0, 200_000);
    const title = titleFromContent(content, sourcePath);
    const statusSignals = findStatusSignals(content);
    const classification = classifyHandoff(title, statusSignals);
    const recordedDate = parseRecordedDate(content);
    const changedFiles = extractChangedFiles(content, projectRoot);
    return {
      sourcePath,
      title,
      summary: summaryFromContent(content, sourcePath),
      content,
      completedAt: parseCompletedAt(content, filePath, recordedDate),
      recordedDate,
      decision: classification.decision,
      reason: classification.reason,
      detail: classification.detail,
      verification: parseVerification(content),
      changedFiles,
      changedFilesStatus: changedFiles.length > 0 ? "detected" : "not_found"
    };
  } catch (error) {
    return {
      sourcePath,
      title: basename(sourcePath).replace(/\.md$/i, ""),
      summary: "",
      content: "",
      decision: "error",
      reason: "unreadable",
      detail: error instanceof Error ? error.message : "The handoff file could not be read.",
      changedFiles: [],
      changedFilesStatus: "not_read"
    };
  }
}

function excludedCandidate(sourcePath: string): HandoffImportCandidate {
  return {
    sourcePath,
    title: basename(sourcePath).replace(/\.md$/i, ""),
    summary: "",
    content: "",
    decision: "excluded",
    reason: "excluded_by_user",
    detail: "Excluded by the user; source content was not read.",
    changedFiles: [],
    changedFilesStatus: "not_read"
  };
}

export function discoverHandoffCandidates(projectRoot: string, options: HandoffDiscoveryOptions = {}): HandoffDiscoveryResult {
  const pathResolver = createProjectPathResolver(projectRoot);
  const handoffDirectory = normalizeRelativePath(
    projectRoot,
    options.handoffDirectory?.trim() || DEFAULT_HANDOFF_DIRECTORY,
    "Handoff directory"
  );
  const absoluteDirectory = pathResolver.safeExistingPath(handoffDirectory) ?? pathResolver.safePath(handoffDirectory);
  if (!absoluteDirectory) {
    throw new Error("Handoff directory must remain inside the tracked project root.");
  }

  const excludePaths = (options.excludePaths ?? []).map((value) => normalizeSelectionPath(projectRoot, value));
  const maxFiles = Math.min(Math.max(options.maxFiles ?? 100, 1), 500);
  const candidates: HandoffImportCandidate[] = [];
  let truncated = false;

  const walk = (directoryPath: string, directoryRelativePath: string): void => {
    let entries;
    try {
      entries = readdirSync(directoryPath, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      if (directoryPath === absoluteDirectory && isNotFound(error)) {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      if (candidates.length >= maxFiles) {
        truncated = true;
        return;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      const sourcePath = `${directoryRelativePath}/${entry.name}`.replaceAll("\\", "/");
      if (entry.isDirectory()) {
        if (!isExcluded(sourcePath, excludePaths)) {
          walk(`${directoryPath}/${entry.name}`, sourcePath);
        }
        if (truncated) {
          return;
        }
        continue;
      }
      if (!entry.name.toLowerCase().endsWith(".md")) {
        continue;
      }
      if (isExcluded(sourcePath, excludePaths)) {
        candidates.push(excludedCandidate(sourcePath));
        continue;
      }
      const filePath = pathResolver.safeExistingPath(sourcePath);
      if (!filePath) {
        candidates.push({
          ...excludedCandidate(sourcePath),
          decision: "error",
          reason: "invalid_path",
          detail: "The discovered handoff path is outside the tracked project root."
        });
        continue;
      }
      candidates.push(parseCandidate(projectRoot, filePath, sourcePath));
    }
  };

  walk(absoluteDirectory, handoffDirectory);
  candidates.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  return {
    handoffDirectory,
    directoryFound: candidates.length > 0 || (() => {
      try {
        readdirSync(absoluteDirectory);
        return true;
      } catch {
        return false;
      }
    })(),
    truncated,
    candidates
  };
}

/** Service boundary used by the storage facade; policy checks remain outside this reader. */
export class HandoffImportService {
  public discover(projectRoot: string, options: HandoffDiscoveryOptions = {}): HandoffDiscoveryResult {
    return discoverHandoffCandidates(projectRoot, options);
  }
}
