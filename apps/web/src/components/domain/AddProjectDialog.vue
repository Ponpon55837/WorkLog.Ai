<script setup lang="ts">
import { ref } from "vue";
import { storeToRefs } from "pinia";
import { FolderOpen } from "lucide-vue-next";
import { useProjectsStore } from "../../stores/projects";
import UiButton from "../ui/UiButton.vue";
import UiDialog from "../ui/UiDialog.vue";
import UiField from "../ui/UiField.vue";
import UiTextInput from "../ui/UiTextInput.vue";
import { t } from "../../i18n";

const open = defineModel<boolean>("open", { required: true });

const projectsStore = useProjectsStore();
const { addingProject } = storeToRefs(projectsStore);
const { addProject, pickProjectFolder } = projectsStore;

const projectName = ref("");
const projectRoot = ref("");
const pickingFolder = ref(false);

async function submit(): Promise<void> {
  if (await addProject({ name: projectName.value, rootPath: projectRoot.value })) {
    projectName.value = "";
    projectRoot.value = "";
    open.value = false;
  }
}

async function pickFolder(): Promise<void> {
  pickingFolder.value = true;
  try {
    const selection = await pickProjectFolder();
    if (selection) {
      projectRoot.value = selection.path;
      if (!projectName.value.trim()) {
        projectName.value = selection.name;
      }
    }
  } finally {
    pickingFolder.value = false;
  }
}
</script>

<template>
  <UiDialog
    :open="open"
    :title="t('common.addProject')"
    :description="t('projects.theRegistryLivesOnlyIn')"
    :busy="addingProject"
    @close="open = false"
  >
    <form id="add-project-form" class="add-project" data-testid="add-project-form" @submit.prevent="submit">
      <UiField :label="t('projects.projectName')"
        ><UiTextInput v-model="projectName" :placeholder="t('projects.eGAssistantConsole')" required autofocus
      /></UiField>
      <UiField
        :label="t('projects.workspaceRoot')"
        :hint="pickingFolder ? t('projects.chooseAFolderInThe') : t('projects.pressChooseFolderToPick')"
      >
        <div class="add-project__root">
          <UiTextInput v-model="projectRoot" placeholder="/Users/you/project" mono required />
          <UiButton :icon="FolderOpen" :loading="pickingFolder" @click.prevent="pickFolder">{{
            t("projects.chooseFolder")
          }}</UiButton>
        </div>
      </UiField>
    </form>
    <template #footer>
      <UiButton :disabled="addingProject" @click="open = false">{{ t("common.cancel") }}</UiButton>
      <UiButton variant="primary" type="submit" form="add-project-form" :loading="addingProject">{{
        t("common.addProject")
      }}</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.add-project {
  display: grid;
  gap: var(--space-4);
}

.add-project__root {
  display: flex;
  gap: var(--space-2);
}

.add-project__root > :first-child {
  flex: 1;
  min-width: 0;
}

@media (max-width: 639px) {
  .add-project__root {
    flex-direction: column;
  }
}
</style>
