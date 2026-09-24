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

/** Edits an Agent's Knowledge candidate before accepting it; the accepted version is what gets recorded. */
const props = defineProps<{ projectRoot?: string }>();

const { candidateEditor, candidateForm, candidateSaving, candidateError, closeCandidateEditor, saveCandidateEditor } =
  useKnowledgeCandidates();

const kindOptions = Object.entries(knowledgeKindLabels).map(([value, label]) => ({
  value: value as keyof typeof knowledgeKindLabels,
  label,
}));
const description = computed(() =>
  candidateEditor.value?.sessionTitle ? `來源：${candidateEditor.value.sessionTitle}` : "Agent 提出的候選",
);
</script>

<template>
  <UiDialog
    :open="Boolean(candidateEditor)"
    title="修改後接受 Knowledge 候選"
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
      <UiField label="標題"><UiTextInput v-model="candidateForm.title" :maxlength="300" required autofocus /></UiField>
      <UiField label="類型"
        ><UiSelect v-model="candidateForm.kind" :options="kindOptions" label="Knowledge 類型"
      /></UiField>
      <UiField label="內容"><UiTextarea v-model="candidateForm.body" :rows="6" :maxlength="20000" required /></UiField>
      <UiField label="標籤" hint="以逗號分隔"><UiTextInput v-model="candidateForm.tags" /></UiField>
      <UiField label="適用路徑" hint="每行一個專案內的路徑或 glob"
        ><UiTextarea v-model="candidateForm.appliesTo" :rows="3" mono
      /></UiField>
    </form>
    <template #footer>
      <UiButton :disabled="candidateSaving" @click="closeCandidateEditor">取消</UiButton>
      <UiButton variant="primary" type="submit" form="knowledge-candidate-form" :loading="candidateSaving"
        >接受並加入 Knowledge</UiButton
      >
    </template>
  </UiDialog>
</template>

<style scoped>
.candidate-editor {
  display: grid;
  gap: var(--space-4);
}
</style>
