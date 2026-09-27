import { ref } from "vue";
import type { VoidTargetType } from "@work-intelligence/core";
import { errorMessage } from "../utils/format";
import { useSessionsStore } from "../stores/sessions";
import { confirmAction } from "./useConfirm";
import { useToast } from "./useToast";

/** Sessions and Evidence keep a void audit; a diagram keeps its void time and reason on the row. */
export type VoidTarget = { type: VoidTargetType | "diagram"; id: string; sessionId: string; title: string };

const voidedMessages = { session: "Session 已作廢。", evidence: "Evidence 已標示為錯誤。", diagram: "圖表已作廢。" };
const restoreCopy = {
  session: { title: "還原這筆 Session？", message: "還原後會重新出現在工作歷程、報告、圖譜與 Agent 檢索。" },
  evidence: { title: "還原這筆 Evidence？", message: "還原後會重新出現在報告與圖譜。" },
  diagram: { title: "還原這張圖表？", message: "還原後會重新顯示圖形。" },
};
const restoredMessages = { session: "Session 已還原。", evidence: "Evidence 已還原。", diagram: "圖表已還原。" };

const voidTarget = ref<VoidTarget | null>(null);
const voidReason = ref("");
const voidSaving = ref(false);
const voidError = ref("");

function openVoidDialog(target: VoidTarget): void {
  voidTarget.value = target;
  voidReason.value = "";
  voidError.value = "";
}

function closeVoidDialog(): void {
  if (voidSaving.value) {
    return;
  }
  voidTarget.value = null;
  voidError.value = "";
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
  const target = voidTarget.value;
  const reason = voidReason.value.trim();
  if (!target) {
    return;
  }
  if (!reason) {
    voidError.value = "請填寫作廢原因。";
    return;
  }
  voidSaving.value = true;
  voidError.value = "";
  try {
    await applyVoid(target, true, reason);
  } catch (error) {
    voidError.value = errorMessage(error, "無法作廢。");
    voidSaving.value = false;
    return;
  }
  voidSaving.value = false;
  voidTarget.value = null;
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
