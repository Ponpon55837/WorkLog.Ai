import { ref } from "vue";
import type { ReportVerificationStatus, WorkSessionRecord, WorkSummarySections } from "@work-intelligence/core";
import { errorMessage } from "../utils/format";
import { workSummarySectionLabels } from "../utils/labels";
import { useApi } from "./useApi";
import { invalidateActiveQueries } from "./useAppRefresh";
import { useSessionDetail } from "./useSessionDetail";
import { useToast } from "./useToast";

type SectionKey = keyof WorkSummarySections;
type SessionEditorForm = {
  summary: string;
  sections: Record<SectionKey, string>;
  /** not_supplied means "leave unreported": the API only accepts passed, failed, or not_run. */
  verificationStatus: ReportVerificationStatus;
  verificationSummary: string;
};

const sessionEditor = ref<WorkSessionRecord | null>(null);
const sessionEditorForm = ref<SessionEditorForm>(toForm());
const sessionEditorSaving = ref(false);
const sessionEditorError = ref("");

/** One textarea line per workSummary item; the same text round-trips unchanged. */
function sectionText(items: readonly string[] | undefined): string {
  return (items ?? []).join("\n");
}

function sectionItems(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function toForm(session?: WorkSessionRecord): SessionEditorForm {
  const sections = Object.fromEntries(
    workSummarySectionLabels.map(({ key }) => [key, sectionText(session?.workSummary?.[key])]),
  ) as Record<SectionKey, string>;
  return {
    summary: session?.summary ?? "",
    sections,
    verificationStatus: session?.verification?.status ?? "not_supplied",
    verificationSummary: session?.verification?.summary ?? "",
  };
}

/** Opens the in-place editor for a Session's summary and five-section workSummary. */
function openSessionEditor(session: WorkSessionRecord): void {
  sessionEditor.value = session;
  sessionEditorForm.value = toForm(session);
  sessionEditorError.value = "";
}

function closeSessionEditor(): void {
  if (sessionEditorSaving.value) {
    return;
  }
  sessionEditor.value = null;
  sessionEditorError.value = "";
}

function updateFailureMessage(result: { outcome: string; reason?: string }): string {
  return result.outcome === "not_found" ? "找不到這筆 Session。" : (result.reason ?? "無法更新 Session 摘要。");
}

function newIdempotencyKey(kind: string, sessionId: string): string {
  return `web-${kind}-${sessionId}-${crypto.randomUUID()}`;
}

/**
 * Saves only what changed, on the same Session: the summary is replaced, edited sections are
 * patched so untouched sections (and legacy Sessions without workSummary) are preserved, and a
 * verification correction is written through its own audited endpoint.
 */
async function saveSessionEditor(): Promise<void> {
  const session = sessionEditor.value;
  if (!session) {
    return;
  }
  const form = sessionEditorForm.value;
  const summary = form.summary.trim();
  if (!summary) {
    sessionEditorError.value = "主摘要不能留白。";
    return;
  }
  const original = toForm(session);
  const changedSections = workSummarySectionLabels
    .map(({ key }) => key)
    .filter((key) => form.sections[key] !== original.sections[key]);
  const summaryChanged = summary !== session.summary.trim();
  const verificationStatus = form.verificationStatus;
  const verificationChanged =
    verificationStatus !== original.verificationStatus ||
    form.verificationSummary.trim() !== original.verificationSummary.trim();
  if (verificationChanged && verificationStatus === "not_supplied") {
    sessionEditorError.value = "請選擇 Verification 狀態（通過、失敗或未執行）才能填寫說明。";
    return;
  }
  if (!summaryChanged && changedSections.length === 0 && !verificationChanged) {
    closeSessionEditor();
    return;
  }

  sessionEditorSaving.value = true;
  sessionEditorError.value = "";
  const { client } = useApi();
  try {
    if (summaryChanged) {
      const result = await client.updateSessionSummary({
        sessionId: session.id,
        idempotencyKey: newIdempotencyKey("summary", session.id),
        mode: "replace",
        summary,
      });
      if (result.outcome !== "summary_updated") {
        throw new Error(updateFailureMessage(result));
      }
    }
    if (changedSections.length > 0) {
      const workSummary = Object.fromEntries(
        changedSections.map((key) => [key, sectionItems(form.sections[key])]),
      ) as Partial<WorkSummarySections>;
      const result = await client.updateSessionWorkSummary({
        sessionId: session.id,
        idempotencyKey: newIdempotencyKey("work-summary", session.id),
        mode: "patch",
        workSummary,
      });
      if (result.outcome !== "work_summary_updated") {
        throw new Error(updateFailureMessage(result));
      }
    }
    if (verificationChanged && verificationStatus !== "not_supplied") {
      const summaryText = form.verificationSummary.trim();
      const result = await client.updateSessionVerification(session.id, {
        status: verificationStatus,
        ...(summaryText ? { summary: summaryText } : {}),
      });
      if (result.outcome !== "updated") {
        throw new Error(updateFailureMessage(result));
      }
    }
  } catch (error) {
    sessionEditorError.value = errorMessage(error, "無法更新 Session 摘要。");
    sessionEditorSaving.value = false;
    return;
  }

  sessionEditorSaving.value = false;
  closeSessionEditor();
  useToast().showToast("Session 已更新。");
  await useSessionDetail().openSessionDetail(session.id);
  void invalidateActiveQueries().catch(() => undefined);
}

export function useSessionEditor() {
  return {
    sessionEditor,
    sessionEditorForm,
    sessionEditorSaving,
    sessionEditorError,
    openSessionEditor,
    closeSessionEditor,
    saveSessionEditor,
  };
}
