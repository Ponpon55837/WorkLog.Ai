<script setup lang="ts">
import { useProjects } from "../../composables/useProjects";
import UiButton from "../ui/UiButton.vue";
import UiDialog from "../ui/UiDialog.vue";
import UiField from "../ui/UiField.vue";
import UiTextInput from "../ui/UiTextInput.vue";

const open = defineModel<boolean>("open", { required: true });
const { projectName, projectRoot, addingProject, addProject } = useProjects();

async function submit(): Promise<void> {
  if (await addProject()) {
    open.value = false;
  }
}
</script>

<template>
  <UiDialog :open="open" title="加入專案" description="Registry 只存在中央 SQLite，不會把設定檔寫進專案 repo。加入後預設為未註冊。" :busy="addingProject" @close="open = false">
    <form id="add-project-form" class="add-project" data-testid="add-project-form" @submit.prevent="submit">
      <UiField label="專案名稱"><UiTextInput v-model="projectName" placeholder="例如：Assistant Console" required autofocus /></UiField>
      <UiField label="Workspace 根目錄" hint="專案 repo 的絕對路徑"><UiTextInput v-model="projectRoot" placeholder="C:\Users\you\project" mono required /></UiField>
    </form>
    <template #footer>
      <UiButton :disabled="addingProject" @click="open = false">取消</UiButton>
      <UiButton variant="primary" type="submit" form="add-project-form" :loading="addingProject">加入專案</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.add-project {
  display: grid;
  gap: var(--space-4);
}
</style>
