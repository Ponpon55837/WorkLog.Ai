import {
  observeGitChangedFileChanges,
  type GitObservedChanges,
  type GitRunner,
  type WorkIntelligenceStore,
} from "@work-intelligence/storage";

export type FinalizeInput = Parameters<WorkIntelligenceStore["finalizeSession"]>[0];

/**
 * What Git reports for the changed files a finalize call gave no status for. Policy, backfill and duplicate checks
 * happen in the store's plan (untracked projects never reach Git); any failure here only omits the observation.
 */
export async function observeFinalizeChangedFiles(
  store: WorkIntelligenceStore,
  input: FinalizeInput,
  baseCommit: string | undefined,
  runGit?: GitRunner,
): Promise<GitObservedChanges | undefined> {
  try {
    const plan = store.prepareChangedFileObservation(input, { baseCommit });
    return plan ? await observeGitChangedFileChanges(plan, { runGit }) : undefined;
  } catch {
    return undefined;
  }
}
