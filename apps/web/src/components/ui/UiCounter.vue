<script setup lang="ts">
withDefaults(defineProps<{ count: number | string; tone?: "default" | "attention" }>(), { tone: "default" });
</script>

<template>
  <span :class="['ui-counter', `ui-counter--${tone}`]">{{ count }}</span>
</template>

<style scoped>
.ui-counter {
  display: inline-block;
  min-width: 20px;
  padding: 0 6px;
  border-radius: var(--radius-pill);
  background: var(--neutral-soft);
  color: var(--fg);
  font-size: var(--text-xs);
  font-weight: 500;
  line-height: 18px;
  text-align: center;
}

.ui-counter--attention {
  background: var(--attention-counter);
}
</style>
