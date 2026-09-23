<script setup lang="ts">
import UiCopyButton from "./UiCopyButton.vue";

/** Copyable natural-language instruction for an Agent. Never put tool names, IDs or JSON here. */
defineProps<{ text: string; successMessage?: string }>();
</script>

<template>
  <div class="ui-command-block">
    <span class="ui-command-block__text">{{ text }}</span>
    <UiCopyButton :text="text" :success-message="successMessage" size="sm" label="複製 Agent 指令" />
  </div>
</template>

<style scoped>
.ui-command-block {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-inset);
}

.ui-command-block__text {
  flex: 1 1 240px;
  min-width: 0;
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  overflow-wrap: anywhere;
}
</style>
