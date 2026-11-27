import type { WorkIntelligenceStore } from "@work-intelligence/storage";

type ChangedFileChangesFollowUp = NonNullable<
  Extract<ReturnType<WorkIntelligenceStore["finalizeSession"]>, { outcome: "finalized" }>["changedFileChangesFollowUp"]
>;

const RECEIPT_MESSAGE =
  "changedFiles lack a change status; send changedFileChanges (renamed needs previousPath) from the real diff, never guess.";

interface ChangeStatusRequest {
  changedFiles?: readonly string[];
  changedFileChanges?: readonly unknown[];
}

export function compactChangeStatusFollowUp(
  followUp: ChangedFileChangesFollowUp,
  input: ChangeStatusRequest,
  serverFilled: boolean,
): Omit<ChangedFileChangesFollowUp, "sessionId"> | Omit<ChangedFileChangesFollowUp, "sessionId" | "missingPaths"> {
  const { sessionId: _sessionId, missingPaths, message: _message, ...rest } = followUp;
  const everyPathMissing =
    !serverFilled && !(input.changedFileChanges?.length ?? 0) && followUp.missingCount === input.changedFiles?.length;
  const message = RECEIPT_MESSAGE;
  return everyPathMissing ? { ...rest, message } : { ...rest, missingPaths, message };
}
