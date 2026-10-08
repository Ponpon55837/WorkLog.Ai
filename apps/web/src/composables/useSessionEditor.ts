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

/** Opens the in-place editor for a Session's title, summary, and five-section workSummary. */
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
  const title = form.title.trim();
  if (!title) {
    useSessionEditorStore().sessionEditorError = t("session.theTitleCannotBeEmpty");
    return;
  }
  const summary = form.summary.trim();
  if (!summary) {
    useSessionEditorStore().sessionEditorError = t("session.theSummaryCannotBeEmpty");
    return;
  }
  const original = toForm(session);
  const changedSections = workSummarySectionLabels
    .map(({ key }) => key)
    .filter((key) => form.sections[key] !== original.sections[key]);
  const titleChanged = title !== session.title.trim();
  const summaryChanged = summary !== session.summary.trim();
  const verificationStatus = form.verificationStatus;
  const verificationChanged =
    verificationStatus !== original.verificationStatus ||
    form.verificationSummary.trim() !== original.verificationSummary.trim();
  if (verificationChanged && verificationStatus === "not_supplied") {
    useSessionEditorStore().sessionEditorError = t("session.chooseAVerificationStatusPassed");
    return;
  }
  if (!titleChanged && !summaryChanged && changedSections.length === 0 && !verificationChanged) {
    closeSessionEditor();
    return;
  }

  useSessionEditorStore().sessionEditorSaving = true;
  useSessionEditorStore().sessionEditorError = "";
  try {
    const edits: SessionEditorSaveInput = { sessionId: session.id };
    if (titleChanged) {
      edits.title = title;
    }
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
    useSessionEditorStore().sessionEditorError = errorMessage(error, t("session.couldNotUpdateTheSession"));
    useSessionEditorStore().sessionEditorSaving = false;
    return;
  }

  useSessionEditorStore().sessionEditorSaving = false;
  closeSessionEditor();
  useToast().showToast(t("session.sessionUpdated"));
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
