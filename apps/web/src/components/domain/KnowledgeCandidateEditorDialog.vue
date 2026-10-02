<script setup lang="ts">
import { computed } from "vue";
import { useKnowledgeCandidates } from "../../composables/useKnowledgeCandidates";
import { knowledgeKindLabels } from "../../utils/labels";
import UiButton from "../ui/UiButton.vue";
import UiDialog from "../ui/UiDialog.vue";
import UiField from "../ui/UiField.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiSelect from "../ui/UiSelect.vue";
import UiTextInput from "../ui/UiTextInput.vue";
import UiTextarea from "../ui/UiTextarea.vue";
import { t } from "../../i18n";

/** Edits an Agent's Knowledge candidate before accepting it; the accepted version is what gets recorded. */
const props = defineProps<{ projectRoot?: string }>();

const { candidateEditor, candidateForm, candidateSaving, candidateError, closeCandidateEditor, saveCandidateEditor } =
  useKnowledgeCandidates();

const kindOptions = Object.entries(knowledgeKindLabels).map(([value, label]) => ({
  value: value as keyof typeof knowledgeKindLabels,
  label,
}));
const description = computed(() =>
  candidateEditor.value?.sessionTitle
    ? t("來源：{sessionTitle}", { sessionTitle: candidateEditor.value.sessionTitle })
    : t("Agent 提出的候選"),
);
</script>

<template>
  <UiDialog
    :open="Boolean(candidateEditor)"
    :title="t('修改後接受 Knowledge 候選')"
    :description="description"
    size="lg"
    :busy="candidateSaving"
    @close="closeCandidateEditor"
  >
    <form
      id="knowledge-candidate-form"
      class="candidate-editor"
      @submit.prevent="saveCandidateEditor(props.projectRoot)"
    >
      <UiFlash v-if="candidateError" tone="danger">{{ candidateError }}</UiFlash>
      <UiField :label="t('標題')"
        ><UiTextInput v-model="candidateForm.title" :maxlength="300" required autofocus
      /></UiField>
      <UiField :label="t('類型')"
        ><UiSelect v-model="candidateForm.kind" :options="kindOptions" :label="t('Knowledge 類型')"
      /></UiField>
      <UiField :label="t('內容')"
        ><UiTextarea v-model="candidateForm.body" :rows="6" :maxlength="20000" required
      /></UiField>
      <UiField :label="t('標籤')" :hint="t('以逗號分隔')"><UiTextInput v-model="candidateForm.tags" /></UiField>
      <UiField :label="t('適用路徑')" :hint="t('每行一個專案內的路徑或 glob')"
        ><UiTextarea v-model="candidateForm.appliesTo" :rows="3" mono
      /></UiField>
    </form>
    <template #footer>
      <UiButton :disabled="candidateSaving" @click="closeCandidateEditor">{{ t("取消") }}</UiButton>
      <UiButton variant="primary" type="submit" form="knowledge-candidate-form" :loading="candidateSaving">{{
        t("接受並加入 Knowledge")
      }}</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.candidate-editor {
  display: grid;
  gap: var(--space-4);
}
</style>
