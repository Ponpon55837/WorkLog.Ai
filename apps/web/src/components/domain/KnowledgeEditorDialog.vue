<script setup lang="ts">
import { computed } from "vue";
import { useKnowledgeActions } from "../../composables/useKnowledge";
import { knowledgeKindLabels, knowledgeStatusLabels } from "../../utils/labels";
import UiButton from "../ui/UiButton.vue";
import UiDialog from "../ui/UiDialog.vue";
import UiField from "../ui/UiField.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiSelect from "../ui/UiSelect.vue";
import UiTextInput from "../ui/UiTextInput.vue";
import UiTextarea from "../ui/UiTextarea.vue";
import { t } from "../../i18n";

const {
  knowledgeEditor,
  knowledgeEditorOpen,
  knowledgeEditorCreating,
  knowledgeEditorProject,
  agentDecisionDraft,
  knowledgeEditorForm,
  knowledgeEditorSaving,
  knowledgeEditorError,
  closeKnowledgeEditor,
  saveKnowledge,
} = useKnowledgeActions();

const kindOptions = Object.entries(knowledgeKindLabels).map(([value, label]) => ({
  value: value as keyof typeof knowledgeKindLabels,
  label,
}));
const statusOptions = Object.entries(knowledgeStatusLabels).map(([value, label]) => ({
  value: value as keyof typeof knowledgeStatusLabels,
  label,
}));
const description = computed(() => {
  if (knowledgeEditorCreating.value) {
    const sourceTitle = agentDecisionDraft.value?.decision.sessionTitle ?? t("common.sourceSession");
    return t("knowledge.savingLinksItToAs", {
      value: knowledgeEditorProject.value?.name ?? t("knowledge.trackedProjectFallback"),
      sourceTitle,
    });
  }
  return t("knowledge.onlyTheCentralRegistryChanges", {
    value: knowledgeEditor.value?.projectName ?? t("knowledge.trackedProjectFallback"),
  });
});
</script>

<template>
  <UiDialog
    :open="knowledgeEditorOpen"
    :title="knowledgeEditorCreating ? t('knowledge.turnAgentDecisionIntoKnowledge') : t('knowledge.editKnowledge')"
    :description="description"
    size="lg"
    :busy="knowledgeEditorSaving"
    @close="closeKnowledgeEditor"
  >
    <form id="knowledge-editor-form" class="knowledge-editor" @submit.prevent="saveKnowledge">
      <UiFlash v-if="knowledgeEditorError" tone="danger">{{ knowledgeEditorError }}</UiFlash>
      <UiField :label="t('knowledge.title')"
        ><UiTextInput v-model="knowledgeEditorForm.title" :maxlength="300" required autofocus
      /></UiField>
      <div class="knowledge-editor__row">
        <UiField :label="t('common.kind')"
          ><UiSelect v-model="knowledgeEditorForm.kind" :options="kindOptions" :label="t('knowledge.knowledgeKind')"
        /></UiField>
        <UiField :label="t('common.status')" :hint="t('knowledge.archivingDeletesNothingItOnly')"
          ><UiSelect
            v-model="knowledgeEditorForm.status"
            :options="statusOptions"
            :label="t('knowledge.knowledgeStatus')"
        /></UiField>
      </div>
      <UiField :label="t('common.body')"
        ><UiTextarea v-model="knowledgeEditorForm.body" :rows="8" :maxlength="20000" required
      /></UiField>
      <div class="knowledge-editor__row">
        <UiField :label="t('knowledge.tags')" :hint="t('knowledge.commaSeparated')"
          ><UiTextInput v-model="knowledgeEditorForm.tags" placeholder="architecture, registry"
        /></UiField>
        <UiField :label="t('knowledge.references')" :hint="t('knowledge.oneReferencePerLine')"
          ><UiTextarea v-model="knowledgeEditorForm.references" :rows="3" mono
        /></UiField>
      </div>
      <UiField :label="t('knowledge.appliesToPaths')" :hint="t('knowledge.onePathOrGlobInsideTheProjectPer')"
        ><UiTextarea v-model="knowledgeEditorForm.appliesTo" :rows="3" mono
      /></UiField>
    </form>
    <template #footer>
      <UiButton :disabled="knowledgeEditorSaving" @click="closeKnowledgeEditor">{{ t("common.cancel") }}</UiButton>
      <UiButton variant="primary" type="submit" form="knowledge-editor-form" :loading="knowledgeEditorSaving">
        {{
          knowledgeEditorCreating
            ? agentDecisionDraft?.knowledgeId
              ? t("knowledge.finishSourceLink")
              : t("knowledge.createAndLinkKnowledge")
            : t("common.saveChanges")
        }}
      </UiButton>
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
