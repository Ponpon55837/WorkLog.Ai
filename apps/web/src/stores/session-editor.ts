import { defineStore } from "pinia";
import { ref } from "vue";
import type { ReportVerificationStatus, WorkSessionRecord, WorkSummarySections } from "@work-intelligence/core";
import { workSummarySectionLabels } from "../utils/labels";

type SectionKey = keyof WorkSummarySections;

export type SessionEditorForm = {
  title: string;
  summary: string;
  sections: Record<SectionKey, string>;
  /** not_supplied means "leave unreported": the API only accepts passed, failed, in_progress, or not_run. */
  verificationStatus: ReportVerificationStatus;
  verificationSummary: string;
};

function sectionText(items: readonly string[] | undefined): string {
  return (items ?? []).join("\n");
}

export function toForm(session?: WorkSessionRecord): SessionEditorForm {
  const sections = Object.fromEntries(
    workSummarySectionLabels.map(({ key }) => [key, sectionText(session?.workSummary?.[key])]),
  ) as Record<SectionKey, string>;
  return {
    title: session?.title ?? "",
    summary: session?.summary ?? "",
    sections,
    verificationStatus: session?.verification?.status ?? "not_supplied",
    verificationSummary: session?.verification?.summary ?? "",
  };
}

export const useSessionEditorStore = defineStore("session-editor", () => {
  const sessionEditor = ref<WorkSessionRecord | null>(null);
  const sessionEditorForm = ref<SessionEditorForm>(toForm());
  const sessionEditorSaving = ref(false);
  const sessionEditorError = ref("");

  function $reset(): void {
    sessionEditor.value = null;
    sessionEditorForm.value = toForm();
    sessionEditorSaving.value = false;
    sessionEditorError.value = "";
  }

  return { sessionEditor, sessionEditorForm, sessionEditorSaving, sessionEditorError, $reset };
});
