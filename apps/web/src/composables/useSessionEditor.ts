import { storeToRefs } from "pinia";
import type { WorkSessionRecord, WorkSummarySections } from "@work-intelligence/core";
import { toForm, useSessionEditorStore } from "../stores/session-editor";
import { errorMessage } from "../utils/format";
import { workSummarySectionLabels } from "../utils/labels";
import { useSessionsStore, type SessionEditorSaveInput } from "../stores/sessions";
import { useToast } from "./useToast";
import { t } from "../i18n";

function sectionItems(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Opens the in-place editor for a Session's summary and five-section workSummary. */
function openSessionEditor(session: WorkSessionRecord): void {
  useSessionEditorStore().sessionEditor = session;
  useSessionEditorStore().sessionEditorForm = toForm(session);
  useSessionEditorStore().sessionEditorError = "";
}

function closeSessionEditor(): void {
  if (useSessionEditorStore().sessionEditorSaving) {
    return;
  }
  useSessionEditorStore().sessionEditor = null;
  useSessionEditorStore().sessionEditorError = "";
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
  const session = useSessionEditorStore().sessionEditor;
  if (!session) {
    return;
  }
  const form = useSessionEditorStore().sessionEditorForm;
  const summary = form.summary.trim();
  if (!summary) {
    useSessionEditorStore().sessionEditorError = t("主摘要不能留白。");
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
    useSessionEditorStore().sessionEditorError = t("請選擇 Verification 狀態（通過、失敗或未執行）才能填寫說明。");
    return;
  }
  if (!summaryChanged && changedSections.length === 0 && !verificationChanged) {
    closeSessionEditor();
    return;
  }

  useSessionEditorStore().sessionEditorSaving = true;
  useSessionEditorStore().sessionEditorError = "";
  try {
    const edits: SessionEditorSaveInput = { sessionId: session.id };
    if (summaryChanged) {
      edits.summary = { idempotencyKey: newIdempotencyKey("summary", session.id), value: summary };
    }
    if (changedSections.length > 0) {
      edits.workSummary = {
        idempotencyKey: newIdempotencyKey("work-summary", session.id),
        sections: Object.fromEntries(
          changedSections.map((key) => [key, sectionItems(form.sections[key])]),
        ) as Partial<WorkSummarySections>,
      };
    }
    if (verificationChanged && verificationStatus !== "not_supplied") {
      const summaryText = form.verificationSummary.trim();
      edits.verification = {
        status: verificationStatus,
        ...(summaryText ? { summary: summaryText } : {}),
      };
    }
    await useSessionsStore().saveSessionEdits(edits);
  } catch (error) {
    useSessionEditorStore().sessionEditorError = errorMessage(error, t("無法更新 Session 摘要。"));
    useSessionEditorStore().sessionEditorSaving = false;
    return;
  }

  useSessionEditorStore().sessionEditorSaving = false;
  closeSessionEditor();
  useToast().showToast(t("Session 已更新。"));
}

export function useSessionEditor() {
  const { sessionEditor, sessionEditorForm, sessionEditorSaving, sessionEditorError } =
    storeToRefs(useSessionEditorStore());
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
