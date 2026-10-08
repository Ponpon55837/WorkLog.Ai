import { storeToRefs } from "pinia";
import { useRecordVoidStore, type VoidTarget } from "../stores/record-void";
import { errorMessage } from "../utils/format";
import { useSessionsStore } from "../stores/sessions";
import { confirmAction } from "./useConfirm";
import { useToast } from "./useToast";
import { t, translatedRecord } from "../i18n";

export type { VoidTarget } from "../stores/record-void";

const voidedMessages = translatedRecord({
  session: "session.sessionVoided",
  evidence: "session.evidenceMarkedAsWrong",
  diagram: "session.diagramVoided",
});
const restoreCopy = {
  session: { title: t("session.restoreThisSession"), message: t("session.onceRestoredItReappearsInTheWorkHistory") },
  evidence: { title: t("session.restoreThisEvidence"), message: t("session.onceRestoredItReappearsIn") },
  diagram: { title: t("session.restoreThisDiagram"), message: t("session.onceRestoredTheDiagramIs") },
};
const restoredMessages = translatedRecord({
  session: "session.sessionRestored",
  evidence: "session.evidenceRestored",
  diagram: "session.diagramRestored",
});

function openVoidDialog(target: VoidTarget): void {
  useRecordVoidStore().voidTarget = target;
  useRecordVoidStore().voidReason = "";
  useRecordVoidStore().voidError = "";
}

function closeVoidDialog(): void {
  if (useRecordVoidStore().voidSaving) {
    return;
  }
  useRecordVoidStore().voidTarget = null;
  useRecordVoidStore().voidError = "";
}

async function applyVoid(target: VoidTarget, voided: boolean, reason?: string): Promise<void> {
  const store = useSessionsStore();
  const result =
    target.type === "session"
      ? await store.setSessionVoid({ sessionId: target.id, voided, reason })
      : target.type === "diagram"
        ? await store.setDiagramVoid({ diagramId: target.id, sessionId: target.sessionId, voided, reason })
        : await store.setEvidenceVoid({ evidenceId: target.id, sessionId: target.sessionId, voided, reason });
  if (result.outcome === "not_found") {
    throw new Error(t("session.recordNotFoundItMay"));
  }
  if (result.outcome === "skipped") {
    throw new Error(result.reason);
  }
}

function afterChange(message: string): void {
  useToast().showToast(message);
}

/** Voids the dialog's target; a reason is required so the audit explains why. */
async function submitVoid(): Promise<void> {
  const target = useRecordVoidStore().voidTarget;
  const reason = useRecordVoidStore().voidReason.trim();
  if (!target) {
    return;
  }
  if (!reason) {
    useRecordVoidStore().voidError = t("session.enterAReasonForVoiding");
    return;
  }
  useRecordVoidStore().voidSaving = true;
  useRecordVoidStore().voidError = "";
  try {
    await applyVoid(target, true, reason);
  } catch (error) {
    useRecordVoidStore().voidError = errorMessage(error, t("session.couldNotVoid"));
    useRecordVoidStore().voidSaving = false;
    return;
  }
  useRecordVoidStore().voidSaving = false;
  useRecordVoidStore().voidTarget = null;
  afterChange(voidedMessages[target.type]);
}

/** Restores a voided Session or evidence after confirmation; the audit keeps both changes. */
async function restoreRecord(target: VoidTarget): Promise<void> {
  const confirmed = await confirmAction({
    title: restoreCopy[target.type].title,
    message: restoreCopy[target.type].message,
    confirmLabel: t("session.restore"),
  });
  if (!confirmed) {
    return;
  }
  try {
    await applyVoid(target, false);
  } catch (error) {
    useToast().showToast(errorMessage(error, t("session.couldNotRestore")), "danger");
    return;
  }
  afterChange(restoredMessages[target.type]);
}

/**
 * Permanently deletes a voided Session after a danger confirmation. The server refuses Sessions that are
 * not voided and writes a pre-deletion backup first; Agents have no equivalent.
 */
async function deleteVoidedSession(target: VoidTarget): Promise<void> {
  if (target.type !== "session") {
    return;
  }
  const confirmed = await confirmAction({
    title: t("session.deleteSessionPermanently"),
    message: t("session.deleteSessionPermanentlyMessage", { title: target.title }),
    confirmLabel: t("session.deletePermanently"),
    danger: true,
  });
  if (!confirmed) {
    return;
  }
  try {
    const result = await useSessionsStore().deleteSession(target.id);
    useToast().showToast(t("session.sessionDeleted", { backupFileName: result.backupFileName }), "success");
  } catch (error) {
    useToast().showToast(errorMessage(error, t("session.couldNotDeleteSession")), "danger");
  }
}

export function useRecordVoid() {
  const { voidTarget, voidReason, voidSaving, voidError } = storeToRefs(useRecordVoidStore());
  return {
    voidTarget,
    voidReason,
    voidSaving,
    voidError,
    openVoidDialog,
    closeVoidDialog,
    submitVoid,
    restoreRecord,
    deleteVoidedSession,
  };
}
