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
  nextSteps: "只寫已知的限制、未完成項目或未驗證情境，不寫建議或計畫。",
};
const description = computed(
  () => `${sessionEditor.value?.title ?? "Session"} · 直接修改這筆 Session，不會建立新的 Session。`,
);
// 未回報 stays selectable only while the Session has no reported verification; it cannot be set.
const verificationOptions = computed(() => [
  ...(sessionEditor.value?.verification ? [] : [{ value: "not_supplied" as const, label: "未回報（維持不變）" }]),
  ...(["passed", "failed", "not_run"] as const).map((value) => ({ value, label: verificationStatus[value].label })),
]);
</script>

<template>
  <UiDialog
    :open="Boolean(sessionEditor)"
    title="編輯 Session"
    :description="description"
    size="lg"
    :busy="sessionEditorSaving"
    @close="closeSessionEditor"
  >
    <form id="session-editor-form" class="session-editor" @submit.prevent="saveSessionEditor">
      <UiFlash v-if="sessionEditorError" tone="danger">{{ sessionEditorError }}</UiFlash>
      <UiField label="主摘要" hint="一句話，先寫結果。"
        ><UiTextarea v-model="sessionEditorForm.summary" :rows="3" :maxlength="20000" required autofocus
      /></UiField>
      <UiField
        v-for="section in workSummarySectionLabels"
        :key="section.key"
        :label="section.label"
        :hint="sectionHints[section.key] ?? '每行一項；留白代表這段沒有內容。'"
        ><UiTextarea v-model="sessionEditorForm.sections[section.key]" :rows="3"
      /></UiField>
      <div class="session-editor__verification">
        <UiField label="Verification 狀態" hint="只寫實際結果；沒跑測試請選「未執行」，不要選「通過」。"
          ><UiSelect
            v-model="sessionEditorForm.verificationStatus"
            label="Verification 狀態"
            :options="verificationOptions"
        /></UiField>
        <UiField label="Verification 說明" hint="選填：實際跑了什麼、結果或未驗證的範圍。"
          ><UiTextarea v-model="sessionEditorForm.verificationSummary" :rows="2" :maxlength="2000"
        /></UiField>
      </div>
    </form>
    <template #footer>
      <UiButton :disabled="sessionEditorSaving" @click="closeSessionEditor">取消</UiButton>
      <UiButton variant="primary" type="submit" form="session-editor-form" :loading="sessionEditorSaving"
        >儲存變更</UiButton
      >
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
