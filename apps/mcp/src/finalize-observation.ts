import {
  observeGitChangedFileChanges,
  type GitObservedChanges,
  type GitRunner,
  type WorkIntelligenceStore,
} from "@work-intelligence/storage";

export type FinalizeInput = Parameters<WorkIntelligenceStore["finalizeSession"]>[0];

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
