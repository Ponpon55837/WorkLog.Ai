<script setup lang="ts">
import { computed } from "vue";
import { useConfirmState } from "../../composables/useConfirm";
import UiButton from "./UiButton.vue";
import UiDialog from "./UiDialog.vue";

const { pending, settle } = useConfirmState();
const open = computed(() => Boolean(pending.value));
</script>

<template>
  <UiDialog :open="open" :title="pending?.title ?? ''" size="sm" @close="settle(false)">
    <p v-if="pending?.message" class="ui-confirm__message">{{ pending.message }}</p>
    <template #footer>
      <UiButton autofocus @click="settle(false)">{{ pending?.cancelLabel ?? "取消" }}</UiButton>
      <UiButton :variant="pending?.danger ? 'danger' : 'primary'" @click="settle(true)">{{
        pending?.confirmLabel ?? "確認"
      }}</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.ui-confirm__message {
  color: var(--fg);
  font-size: var(--text-md);
  line-height: 1.6;
}
</style>
