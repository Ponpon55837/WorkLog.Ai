<script setup lang="ts">
import { computed } from "vue";
import { useSessionEditor } from "../../composables/useSessionEditor";
import { workSummarySectionLabels } from "../../utils/labels";
import { verificationStatus } from "../../utils/status";
import UiButton from "../ui/UiButton.vue";
import UiDialog from "../ui/UiDialog.vue";
import UiField from "../ui/UiField.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiSelect from "../ui/UiSelect.vue";
import UiTextarea from "../ui/UiTextarea.vue";
import { t } from "../../i18n";

/**
 * Edits a Session's summary, five-section workSummary, and verification in place (same Session
 * id). Only changed fields are sent; every update keeps an audit row, as when an Agent corrects it.
 */
const {
  sessionEditor,
  sessionEditorForm,
  sessionEditorSaving,
  sessionEditorError,
  closeSessionEditor,
  saveSessionEditor,
} = useSessionEditor();

const sectionHints: Record<string, string> = {
  nextSteps: t("session.writeOnlyKnownLimitsUnfinished"),
};
const description = computed(() =>
  t("session.editsThisSessionInPlace", { value: sessionEditor.value?.title ?? "Session" }),
);
// 未回報 stays selectable only while the Session has no reported verification; it cannot be set.
const verificationOptions = computed(() => [
  ...(sessionEditor.value?.verification
    ? []
    : [{ value: "not_supplied" as const, label: t("session.notReportedUnchanged") }]),
  ...(["passed", "failed", "not_run"] as const).map((value) => ({ value, label: verificationStatus[value].label })),
]);
</script>

<template>
  <UiDialog
    :open="Boolean(sessionEditor)"
    :title="t('session.editSession')"
    :description="description"
    size="lg"
    :busy="sessionEditorSaving"
    @close="closeSessionEditor"
  >
    <form id="session-editor-form" class="session-editor" @submit.prevent="saveSessionEditor">
      <UiFlash v-if="sessionEditorError" tone="danger">{{ sessionEditorError }}</UiFlash>
      <UiField :label="t('session.summary')" :hint="t('session.oneSentenceOutcomeFirst')"
        ><UiTextarea v-model="sessionEditorForm.summary" :rows="3" :maxlength="20000" required autofocus
      /></UiField>
      <UiField
        v-for="section in workSummarySectionLabels"
        :key="section.key"
        :label="section.label"
        :hint="sectionHints[section.key] ?? t('session.oneItemPerLineLeave')"
        ><UiTextarea v-model="sessionEditorForm.sections[section.key]" :rows="3"
      /></UiField>
      <div class="session-editor__verification">
        <UiField :label="t('session.verificationStatus')" :hint="t('session.writeOnlyWhatActuallyHappened')"
          ><UiSelect
            v-model="sessionEditorForm.verificationStatus"
            :label="t('session.verificationStatus')"
            :options="verificationOptions"
        /></UiField>
        <UiField :label="t('session.verificationNotes')" :hint="t('session.optionalWhatActuallyRanThe')"
          ><UiTextarea v-model="sessionEditorForm.verificationSummary" :rows="2" :maxlength="2000"
        /></UiField>
      </div>
    </form>
    <template #footer>
      <UiButton :disabled="sessionEditorSaving" @click="closeSessionEditor">{{ t("common.cancel") }}</UiButton>
      <UiButton variant="primary" type="submit" form="session-editor-form" :loading="sessionEditorSaving">{{
        t("common.saveChanges")
      }}</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.session-editor {
  display: grid;
  gap: var(--space-4);
}

.session-editor__verification {
  display: grid;
  gap: var(--space-4);
  padding-top: var(--space-4);
  border-top: 1px solid var(--border-muted);
}
</style>
