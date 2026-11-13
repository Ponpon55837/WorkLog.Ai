import type { WorkIntelligenceStore } from "@work-intelligence/storage";

type ChangedFileChangesFollowUp = NonNullable<
  Extract<ReturnType<WorkIntelligenceStore["finalizeSession"]>, { outcome: "finalized" }>["changedFileChangesFollowUp"]
>;

/** The receipt already carries suggestedCall, so the instruction is one short line. */
const RECEIPT_MESSAGE =
  "changedFiles lack a change status; send changedFileChanges (renamed needs previousPath) from the real diff, never guess.";

/** What the request told the Agent already, so the receipt does not echo it back. */
interface ChangeStatusRequest {
  changedFiles?: readonly string[];
  changedFileChanges?: readonly unknown[];
}

/**
 * The receipt form of the follow-up. The Agent knows which paths it sent: when it sent no statuses and the server
 * filled none, every path it listed is missing, so only the count is returned; the path list appears when some
 * paths are covered and the Agent cannot tell which. The session id is already in the receipt.
 */
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
