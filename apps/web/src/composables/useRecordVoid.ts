import { storeToRefs } from "pinia";
import { useRecordVoidStore, type VoidTarget } from "../stores/record-void";
import { errorMessage } from "../utils/format";
import { useSessionsStore } from "../stores/sessions";
import { confirmAction } from "./useConfirm";
import { useToast } from "./useToast";

export type { VoidTarget } from "../stores/record-void";

const voidedMessages = { session: "Session 已作廢。", evidence: "Evidence 已標示為錯誤。", diagram: "圖表已作廢。" };
const restoreCopy = {
  session: { title: "還原這筆 Session？", message: "還原後會重新出現在工作歷程、報告、圖譜與 Agent 檢索。" },
  evidence: { title: "還原這筆 Evidence？", message: "還原後會重新出現在報告與圖譜。" },
  diagram: { title: "還原這張圖表？", message: "還原後會重新顯示圖形。" },
};
const restoredMessages = { session: "Session 已還原。", evidence: "Evidence 已還原。", diagram: "圖表已還原。" };

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
    throw new Error("找不到這筆資料，可能已被刪除。");
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
    useRecordVoidStore().voidError = "請填寫作廢原因。";
    return;
  }
  useRecordVoidStore().voidSaving = true;
  useRecordVoidStore().voidError = "";
  try {
    await applyVoid(target, true, reason);
  } catch (error) {
    useRecordVoidStore().voidError = errorMessage(error, "無法作廢。");
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
    confirmLabel: "還原",
  });
  if (!confirmed) {
    return;
  }
  try {
    await applyVoid(target, false);
  } catch (error) {
    useToast().showToast(errorMessage(error, "無法還原。"), "danger");
    return;
  }
  afterChange(restoredMessages[target.type]);
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
  };
}
