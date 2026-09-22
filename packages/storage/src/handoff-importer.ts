import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, relative } from "node:path";
import type {
  HandoffImportChangedFilesStatus,
  HandoffImportDecision,
  HandoffImportReason,
  VerificationSummary
} from "@work-intelligence/core";
import { createProjectPathResolver, safeProjectPath } from "@work-intelligence/project-policy";
import { MAX_HANDOFF_CONTENT_LENGTH, parseHandoffContent } from "./handoff-parser.js";

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

function parseCandidate(projectRoot: string, filePath: string, sourcePath: string): HandoffImportCandidate {
  try {
    const content = readFileSync(filePath, "utf8").slice(0, MAX_HANDOFF_CONTENT_LENGTH);
    const parsed = parseHandoffContent(content, projectRoot, sourcePath);
    return {
      sourcePath,
      title: parsed.title,
      summary: parsed.summary,
      content,
      completedAt: parseCompletedAt(content, filePath, parsed.recordedDate),
      recordedDate: parsed.recordedDate,
      decision: parsed.classification.decision,
      reason: parsed.classification.reason,
      detail: parsed.classification.detail,
      verification: parsed.verification,
      changedFiles: parsed.changedFiles,
      changedFilesStatus: parsed.changedFiles.length > 0 ? "detected" : "not_found"
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
