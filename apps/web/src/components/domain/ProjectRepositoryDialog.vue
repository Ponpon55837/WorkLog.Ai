<script setup lang="ts">
import { ref, watch } from "vue";
import { isSafeRepositoryUrl, type ProjectRecord } from "@work-intelligence/core";
import { useProjectsStore } from "../../stores/projects";
import UiButton from "../ui/UiButton.vue";
import UiDialog from "../ui/UiDialog.vue";
import UiField from "../ui/UiField.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiTextInput from "../ui/UiTextInput.vue";

/** Sets the https repository URL a project's commit SHAs link to; an empty value removes it. */
const props = defineProps<{ project: ProjectRecord | null }>();
const emit = defineEmits<{ close: [] }>();

const projectsStore = useProjectsStore();

const url = ref("");
const saving = ref(false);
const error = ref("");

function close(): void {
  if (!saving.value) emit("close");
}

async function save(): Promise<void> {
  const project = props.project;
  if (!project) return;
  const value = url.value.trim();
  if (value && !isSafeRepositoryUrl(value)) {
    error.value = "請輸入 https:// 開頭、不含帳號或 token 的網址。";
    return;
  }
  saving.value = true;
  error.value = "";
  const saved = await projectsStore.updateProjectRepository(project, value);
  saving.value = false;
  if (saved) emit("close");
}

watch(
  () => props.project,
  (project) => {
    url.value = project?.repositoryUrl ?? "";
    error.value = "";
  },
);
</script>

<template>
  <UiDialog
    :open="Boolean(project)"
    title="儲存庫網址"
    :description="`${project?.name ?? ''} · Session 記錄了 commit 時，會連到這個儲存庫上的 commit 頁面。`"
    :busy="saving"
    @close="close"
  >
    <form id="project-repository-form" class="repository-form" @submit.prevent="save">
      <UiFlash v-if="error" tone="danger">{{ error }}</UiFlash>
      <UiField label="網址" hint="只接受 https://，例如 https://github.com/owner/repo；留白代表移除。">
        <UiTextInput v-model="url" :maxlength="500" mono autofocus placeholder="https://github.com/owner/repo" />
      </UiField>
    </form>
    <template #footer>
      <UiButton :disabled="saving" @click="close">取消</UiButton>
      <UiButton variant="primary" type="submit" form="project-repository-form" :loading="saving">儲存</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.repository-form {
  display: grid;
  gap: var(--space-4);
}
</style>
