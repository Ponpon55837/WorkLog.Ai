<script setup lang="ts">
import { computed } from "vue";
import { useKnowledge } from "../../composables/useKnowledge";
import { knowledgeKindLabels, knowledgeStatusLabels } from "../../utils/labels";
import UiButton from "../ui/UiButton.vue";
import UiDialog from "../ui/UiDialog.vue";
import UiField from "../ui/UiField.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiSelect from "../ui/UiSelect.vue";
import UiTextInput from "../ui/UiTextInput.vue";
import UiTextarea from "../ui/UiTextarea.vue";

const {
  knowledgeEditor,
  knowledgeEditorForm,
  knowledgeEditorSaving,
  knowledgeEditorError,
  closeKnowledgeEditor,
  saveKnowledge,
} = useKnowledge();

const kindOptions = Object.entries(knowledgeKindLabels).map(([value, label]) => ({
  value: value as keyof typeof knowledgeKindLabels,
  label,
}));
const statusOptions = Object.entries(knowledgeStatusLabels).map(([value, label]) => ({
  value: value as keyof typeof knowledgeStatusLabels,
  label,
}));
const description = computed(
  () => `${knowledgeEditor.value?.projectName ?? "Tracked project"} · 只修改中央 registry，不會讀取或修改來源 repo。`,
);
</script>

<template>
  <UiDialog
    :open="Boolean(knowledgeEditor)"
    title="編輯 Knowledge"
    :description="description"
    size="lg"
    :busy="knowledgeEditorSaving"
    @close="closeKnowledgeEditor"
  >
    <form id="knowledge-editor-form" class="knowledge-editor" @submit.prevent="saveKnowledge">
      <UiFlash v-if="knowledgeEditorError" tone="danger">{{ knowledgeEditorError }}</UiFlash>
      <UiField label="標題"
        ><UiTextInput v-model="knowledgeEditorForm.title" :maxlength="300" required autofocus
      /></UiField>
      <div class="knowledge-editor__row">
        <UiField label="類型"
          ><UiSelect v-model="knowledgeEditorForm.kind" :options="kindOptions" label="Knowledge 類型"
        /></UiField>
        <UiField label="狀態" hint="封存不會刪除記錄，只會從預設搜尋與 Graph 隱藏。"
          ><UiSelect v-model="knowledgeEditorForm.status" :options="statusOptions" label="Knowledge 狀態"
        /></UiField>
      </div>
      <UiField label="內容"
        ><UiTextarea v-model="knowledgeEditorForm.body" :rows="8" :maxlength="20000" required
      /></UiField>
      <div class="knowledge-editor__row">
        <UiField label="標籤" hint="以逗號分隔"
          ><UiTextInput v-model="knowledgeEditorForm.tags" placeholder="architecture, registry"
        /></UiField>
        <UiField label="參考資料" hint="每行一個 reference"
          ><UiTextarea v-model="knowledgeEditorForm.references" :rows="3" mono
        /></UiField>
      </div>
    </form>
    <template #footer>
      <UiButton :disabled="knowledgeEditorSaving" @click="closeKnowledgeEditor">取消</UiButton>
      <UiButton variant="primary" type="submit" form="knowledge-editor-form" :loading="knowledgeEditorSaving"
        >儲存變更</UiButton
      >
    </template>
  </UiDialog>
</template>

<style scoped>
.knowledge-editor {
  display: grid;
  gap: var(--space-4);
}

.knowledge-editor__row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4);
}

@media (max-width: 639px) {
  .knowledge-editor__row {
    grid-template-columns: 1fr;
  }
}
</style>
