<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Trash2 } from "lucide-vue-next";
import type { ProjectRecord } from "@work-intelligence/core";
import UiButton from "../ui/UiButton.vue";
import UiDialog from "../ui/UiDialog.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiTextInput from "../ui/UiTextInput.vue";

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

watch(
  () => [props.open, props.project?.id] as const,
  ([open]) => {
    if (open) {
      typedName.value = "";
    }
  },
);

function confirmDeletion(): void {
  if (canDelete.value && props.project) {
    emit("confirm", props.project, typedName.value);
  }
}
</script>

<template>
  <UiDialog
    :open="open && !!project"
    title="永久刪除專案資料？"
    description="此操作會從 WorkLog 的中央資料庫移除專案與所有相關工作記錄。"
    size="md"
    :busy="busy"
    @close="emit('close')"
  >
    <template v-if="project">
      <UiFlash tone="attention" title="刪除前會先建立整份資料庫備份">
        備份成功後才會刪除，並依手動備份保留規則管理。這會移除「{{ project.name }}」的
        Sessions、handoff、事件、Evidence、Knowledge、候選、稽核記錄與搜尋資料；其他專案共用且引用這些 Sessions
        的報告或整理請求也會一併移除。專案資料夾與原始檔案不會被刪除。
      </UiFlash>
      <p class="delete-project__label">輸入專案名稱以確認</p>
      <UiTextInput
        v-model="typedName"
        :maxlength="120"
        :required="true"
        :autofocus="true"
        :placeholder="project.name"
        :label="`輸入 ${project.name} 以確認永久刪除`"
      />
    </template>
    <template #footer>
      <UiButton :disabled="busy" @click="emit('close')">取消</UiButton>
      <UiButton variant="danger" :icon="Trash2" :disabled="!canDelete" :loading="busy" @click="confirmDeletion">
        永久刪除
      </UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.delete-project__label {
  display: block;
  margin-bottom: var(--space-2);
  color: var(--fg);
  font-size: var(--text-sm);
  font-weight: 600;
}
</style>
