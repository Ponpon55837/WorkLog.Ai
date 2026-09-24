import { ref } from "vue";
import type { VoidTargetType } from "@work-intelligence/core";
import { errorMessage } from "../utils/format";
import { useApi } from "./useApi";
import { requestAppRefresh } from "./useAppRefresh";
import { confirmAction } from "./useConfirm";
import { useProjects } from "./useProjects";
import { useSessionDetail } from "./useSessionDetail";
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
  const { client } = useApi();
  const result =
    target.type === "session"
      ? await client.setSessionVoid({ sessionId: target.id, voided, reason })
      : await client.setEvidenceVoid({ evidenceId: target.id, voided, reason });
  if (result.outcome === "not_found") {
    throw new Error("找不到這筆資料，可能已被刪除。");
  }
  if (result.outcome === "skipped") {
    throw new Error(result.reason);
  }
}

async function afterChange(target: VoidTarget, message: string): Promise<void> {
  useToast().showToast(message);
  await useSessionDetail().openSessionDetail(target.sessionId);
  // Voiding changes the Session totals shown in the sidebar, which only the shared loader refreshes.
  void useProjects().loadDashboard();
  requestAppRefresh();
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
  await afterChange(target, target.type === "session" ? "Session 已作廢。" : "Evidence 已標示為錯誤。");
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
  await afterChange(target, target.type === "session" ? "Session 已還原。" : "Evidence 已還原。");
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
