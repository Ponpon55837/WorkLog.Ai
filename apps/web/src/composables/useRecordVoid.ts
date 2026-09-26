import { ref } from "vue";
import type { VoidTargetType } from "@work-intelligence/core";
import { errorMessage } from "../utils/format";
import { useSessionsStore } from "../stores/sessions";
import { confirmAction } from "./useConfirm";
import { useToast } from "./useToast";

export type VoidTarget = { type: VoidTargetType; id: string; sessionId: string; title: string };

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
  afterChange(target.type === "session" ? "Session 已作廢。" : "Evidence 已標示為錯誤。");
}

/** Restores a voided Session or evidence after confirmation; the audit keeps both changes. */
async function restoreRecord(target: VoidTarget): Promise<void> {
  const confirmed = await confirmAction({
    title: target.type === "session" ? "還原這筆 Session？" : "還原這筆 Evidence？",
    message:
      target.type === "session"
        ? "還原後會重新出現在工作歷程、報告、圖譜與 Agent 檢索。"
        : "還原後會重新出現在報告與圖譜。",
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
  afterChange(target.type === "session" ? "Session 已還原。" : "Evidence 已還原。");
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
