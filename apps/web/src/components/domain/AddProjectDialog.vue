<script setup lang="ts">
import { FolderOpen } from "lucide-vue-next";
import { useProjects } from "../../composables/useProjects";
import UiButton from "../ui/UiButton.vue";
import UiDialog from "../ui/UiDialog.vue";
import UiField from "../ui/UiField.vue";
import UiTextInput from "../ui/UiTextInput.vue";

const open = defineModel<boolean>("open", { required: true });
const { projectName, projectRoot, addingProject, addProject, pickingFolder, pickProjectFolder } = useProjects();

async function submit(): Promise<void> {
  if (await addProject()) {
    open.value = false;
  }
}
</script>

<template>
  <UiDialog
    :open="open"
    title="加入專案"
    description="Registry 只存在中央 SQLite，不會把設定檔寫進專案 repo。加入後預設為未註冊。"
    :busy="addingProject"
    @close="open = false"
  >
    <form id="add-project-form" class="add-project" data-testid="add-project-form" @submit.prevent="submit">
      <UiField label="專案名稱"
        ><UiTextInput v-model="projectName" placeholder="例如：Assistant Console" required autofocus
      /></UiField>
      <UiField
        label="Workspace 根目錄"
        :hint="pickingFolder ? '請在跳出的視窗中選擇資料夾。' : '按「選擇資料夾」挑選專案 repo，或直接輸入絕對路徑。'"
      >
        <div class="add-project__root">
          <UiTextInput v-model="projectRoot" placeholder="/Users/you/project" mono required />
          <UiButton :icon="FolderOpen" :loading="pickingFolder" @click.prevent="pickProjectFolder">選擇資料夾</UiButton>
        </div>
      </UiField>
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
