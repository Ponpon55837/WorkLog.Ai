<script setup lang="ts">
import { computed } from "vue";
import { useRecordVoid } from "../../composables/useRecordVoid";
import UiButton from "../ui/UiButton.vue";
import UiDialog from "../ui/UiDialog.vue";
import UiField from "../ui/UiField.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiTextarea from "../ui/UiTextarea.vue";

/**
 * Asks for the reason before voiding a Session or marking evidence as wrong. Voiding is a
 * reversible soft-delete: the record stays readable and every change is audited.
 */
const { voidTarget, voidReason, voidSaving, voidError, closeVoidDialog, submitVoid } = useRecordVoid();

const isSession = computed(() => voidTarget.value?.type === "session");
const title = computed(() => (isSession.value ? "作廢 Session" : "標示 Evidence 為錯誤"));
const effect = computed(() =>
  isSession.value
    ? "作廢後，這筆 Session 不會出現在工作歷程（可用篩選找回）、Dashboard、報告、圖譜與 Agent 檢索；詳情仍可開啟，隨時可以還原。"
    : "這筆 Evidence 會保留在 Session 詳情並標示原因，但不再出現在報告與圖譜；隨時可以還原。",
);
</script>

<template>
  <UiDialog
    :open="Boolean(voidTarget)"
    :title="title"
    :description="voidTarget?.title"
    :busy="voidSaving"
    @close="closeVoidDialog"
  >
    <form id="record-void-form" class="record-void" @submit.prevent="submitVoid">
      <UiFlash v-if="voidError" tone="danger">{{ voidError }}</UiFlash>
      <p class="record-void__effect">{{ effect }}</p>
      <UiField label="原因" hint="例如：測試時誤記、重複記錄、附錯檔案。會留在作廢紀錄裡。"
        ><UiTextarea v-model="voidReason" :rows="3" :maxlength="1000" required autofocus
      /></UiField>
    </form>
    <template #footer>
      <UiButton :disabled="voidSaving" @click="closeVoidDialog">取消</UiButton>
      <UiButton variant="danger" type="submit" form="record-void-form" :loading="voidSaving">{{
        isSession ? "作廢" : "標示為錯誤"
      }}</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.record-void {
  display: grid;
  gap: var(--space-4);
}

.record-void__effect {
  margin: 0;
  color: var(--fg-muted);
  font-size: var(--text-sm);
  line-height: 1.6;
}
</style>
