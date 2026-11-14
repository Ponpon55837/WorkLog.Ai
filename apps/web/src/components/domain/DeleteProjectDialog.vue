<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Trash2 } from "lucide-vue-next";
import type { ProjectRecord } from "@work-intelligence/core";
import UiButton from "../ui/UiButton.vue";
import UiDialog from "../ui/UiDialog.vue";
import UiField from "../ui/UiField.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiTextInput from "../ui/UiTextInput.vue";
import { t } from "../../i18n";

const props = defineProps<{
  open: boolean;
  project: ProjectRecord | null;
  busy?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  confirm: [project: ProjectRecord, confirmationName: string];
}>();

const typedName = ref("");

const canDelete = computed(() => !!props.project && typedName.value === props.project.name && !props.busy);

function confirmDeletion(): void {
  if (canDelete.value && props.project) {
    emit("confirm", props.project, typedName.value);
  }
}

watch(
  () => [props.open, props.project?.id] as const,
  ([open]) => {
    if (open) {
      typedName.value = "";
    }
  },
);
</script>

<template>
  <UiDialog
    :open="open && !!project"
    :title="t('projects.permanentlyDeleteProjectData')"
    :description="t('projects.thisRemovesTheProjectAnd')"
    size="md"
    :busy="busy"
    @close="emit('close')"
  >
    <template v-if="project">
      <UiFlash tone="attention" :title="t('projects.aFullDatabaseBackupIs')">
        {{ t("projects.deletionHappensOnlyAfterA", { name: project.name }) }}
      </UiFlash>
      <!-- The visible label is the input's name (WCAG 2.5.3); the hint keeps the exact project name in view. -->
      <UiField
        :label="t('projects.typeTheProjectNameTo')"
        :hint="t('projects.typeToConfirmPermanentDeletion', { name: project.name })"
      >
        <UiTextInput
          v-model="typedName"
          :maxlength="120"
          :required="true"
          :autofocus="true"
          :placeholder="project.name"
          :label="t('projects.typeTheProjectNameTo')"
        />
      </UiField>
    </template>
    <template #footer>
      <UiButton :disabled="busy" @click="emit('close')">{{ t("common.cancel") }}</UiButton>
      <UiButton variant="danger" :icon="Trash2" :disabled="!canDelete" :loading="busy" @click="confirmDeletion">
        {{ t("projects.deletePermanently") }}
      </UiButton>
    </template>
  </UiDialog>
</template>
