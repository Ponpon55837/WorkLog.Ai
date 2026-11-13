import type { ChangedFileChange, ChangedFileProvenance, FinalizeSessionInput } from "@work-intelligence/core";
import { createProjectPathResolver } from "@work-intelligence/project-policy";
import type { GitObservedChanges } from "./git-change-observation.js";
import {
  changedFileIdentity,
  changedFilePathsFromChanges,
  excludeBaselineChangedFileChanges,
  excludeBaselineChangedFiles,
  isCommitSha,
  normalizeChangedFileChanges,
  normalizeChangedFiles,
} from "./session-record-codecs.js";

/** What the MCP layer may ask Git about, after policy and duplicate checks. */
export type ChangedFileObservationPlan = {
  rootPath: string;
  paths: string[];
  baseCommit?: string;
};

type ChangedFileList = { files: string[]; provenance: ChangedFileProvenance[] };

export type ObservedChangedFileChangesApplication = {
  files: ChangedFileList;
  changes: ChangedFileChange[];
  applied: ChangedFileChange[];
  base: string;
};

/**
 * The stored changed files of a finalize request that no supplied change covers, as the paths worth asking Git
 * about. Returns undefined when nothing needs observing or the request does not normalize (finalize reports that).
 */
export function planChangedFileObservation(
  rootPath: string,
  input: FinalizeSessionInput,
  baseCommit: string | undefined,
): ChangedFileObservationPlan | undefined {
  try {
    const pathResolver = createProjectPathResolver(rootPath);
    const baseline = new Set(
      normalizeChangedFiles(rootPath, input.baselineChangedFiles, undefined, pathResolver).files.map(
        changedFileIdentity,
      ),
    );
    const supplied = excludeBaselineChangedFileChanges(
      normalizeChangedFileChanges(rootPath, input.changedFileChanges, pathResolver),
      baseline,
    );
    const covered = new Set(changedFilePathsFromChanges(supplied).map(changedFileIdentity));
    const files = excludeBaselineChangedFiles(
      normalizeChangedFiles(
        rootPath,
        [...(input.changedFiles ?? []), ...changedFilePathsFromChanges(supplied)],
        input.changedFilesProvenance,
        pathResolver,
      ),
      baseline,
    ).files;
    const paths = files.filter((file) => !covered.has(changedFileIdentity(file)));
    if (paths.length === 0) return undefined;
    return {
      rootPath,
      paths,
      ...(baseCommit && isCommitSha(baseCommit) ? { baseCommit: baseCommit.toLowerCase() } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Fills statuses for stored changed files that no entry covers, from what the server observed in Git. An Agent's
 * own entries always win; an observed entry outside the final file set (or touching a covered path) is dropped, and
 * the observed data is re-normalized because it crossed a process boundary. A rename's previousPath joins the file
 * list the same way an Agent-supplied rename's does.
 */
export function applyObservedChangedFileChanges(
  projectRoot: string,
  files: ChangedFileList,
  changes: ChangedFileChange[],
  baselineIdentities: Set<string>,
  observed: GitObservedChanges | undefined,
): ObservedChangedFileChangesApplication | undefined {
  if (!observed || observed.changes.length === 0) return undefined;
  const pathResolver = createProjectPathResolver(projectRoot);
  let candidates: ChangedFileChange[];
  try {
    candidates = excludeBaselineChangedFileChanges(
      normalizeChangedFileChanges(projectRoot, observed.changes, pathResolver),
      baselineIdentities,
    );
  } catch {
    return undefined;
  }

  const known = new Set(files.files.map(changedFileIdentity));
  const covered = new Set(changedFilePathsFromChanges(changes).map(changedFileIdentity));
  const applied: ChangedFileChange[] = [];
  for (const candidate of candidates) {
    const pathIdentity = changedFileIdentity(candidate.path);
    const previousIdentity = candidate.previousPath ? changedFileIdentity(candidate.previousPath) : undefined;
    if (!known.has(pathIdentity) || covered.has(pathIdentity)) continue;
    if (previousIdentity && covered.has(previousIdentity)) continue;
    covered.add(pathIdentity);
    if (previousIdentity) covered.add(previousIdentity);
    applied.push(candidate);
  }
  if (applied.length === 0) return undefined;

  const extraPaths = applied.flatMap((change) =>
    change.previousPath && !known.has(changedFileIdentity(change.previousPath)) ? [change.previousPath] : [],
  );
  const nextFiles =
    extraPaths.length > 0
      ? excludeBaselineChangedFiles(
          normalizeChangedFiles(projectRoot, [...files.files, ...extraPaths], files.provenance, pathResolver),
          baselineIdentities,
        )
      : files;
  return { files: nextFiles, changes: [...changes, ...applied], applied, base: observed.base };
}

/** The Traditional Chinese note kept on the Session so a server-observed status stays auditable. */
export function observedChangedFileChangesNote(application: ObservedChangedFileChangesApplication): {
  summary: string;
  details: Record<string, unknown>;
} {
  const base = application.base === "HEAD" ? "HEAD" : application.base.slice(0, 12);
  return {
    summary: `變更狀態取自 MCP 伺服器觀察 Git（相對於 ${base}）：${application.applied.length} 個路徑（Agent 未回報）。`,
    details: {
      field: "changedFileChanges",
      source: "server_observed_git",
      base: application.base,
      paths: application.applied.map((change) => change.path),
    },
  };
}
