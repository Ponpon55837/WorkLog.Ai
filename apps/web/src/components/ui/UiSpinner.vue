<script setup lang="ts">
import { computed } from "vue";
import { t } from "../../i18n";

const props = withDefaults(defineProps<{ size?: number; label?: string }>(), { size: 16 });

// Resolved here rather than in withDefaults so the default follows the current locale.
const text = computed(() => props.label ?? t("載入中"));
</script>

<template>
  <span class="ui-spinner" role="status" :style="{ width: `${size}px`, height: `${size}px` }">
    <span class="sr-only">{{ text }}</span>
  </span>
</template>

<style scoped>
.ui-spinner {
  display: inline-block;
  flex: 0 0 auto;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: ui-spin 0.8s linear infinite;
}

@keyframes ui-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
