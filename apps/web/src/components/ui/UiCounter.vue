<script setup lang="ts">
withDefaults(defineProps<{ count: number | string; tone?: "default" | "attention" }>(), { tone: "default" });
</script>

<template>
  <!-- Keyed by the value so a changed count re-runs the pop and draws the eye to it. -->
  <span :key="count" :class="['ui-counter', `ui-counter--${tone}`]">{{ count }}</span>
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
  font-variant-numeric: tabular-nums;
  animation: wi-pop var(--duration-base) var(--ease-out);
}

.ui-counter--attention {
  background: var(--attention-counter);
}
</style>
