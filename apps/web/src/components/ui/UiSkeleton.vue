<script setup lang="ts">
withDefaults(defineProps<{ variant?: "row" | "card" | "text"; count?: number }>(), { variant: "row", count: 3 });
</script>

<template>
  <div :class="['ui-skeleton', `ui-skeleton--${variant}`]" aria-busy="true" aria-label="載入中">
    <div v-for="index in count" :key="index" class="ui-skeleton__item">
      <template v-if="variant === 'row'">
        <span class="ui-skeleton__dot"></span>
        <span class="ui-skeleton__lines">
          <span class="ui-skeleton__line" style="width: 55%"></span>
          <span class="ui-skeleton__line ui-skeleton__line--thin" style="width: 35%"></span>
        </span>
      </template>
      <template v-else-if="variant === 'card'">
        <span class="ui-skeleton__line ui-skeleton__line--thin" style="width: 40%"></span>
        <span class="ui-skeleton__line ui-skeleton__line--tall" style="width: 30%"></span>
      </template>
      <span v-else class="ui-skeleton__line" :style="{ width: `${90 - index * 12}%` }"></span>
    </div>
  </div>
</template>

<style scoped>
.ui-skeleton--row .ui-skeleton__item {
  display: flex;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--border-muted);
}

.ui-skeleton--row .ui-skeleton__item:first-child {
  border-top: 0;
}

.ui-skeleton--card {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: var(--space-4);
}

.ui-skeleton--card .ui-skeleton__item {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.ui-skeleton--text .ui-skeleton__item {
  padding: var(--space-1) 0;
}

.ui-skeleton__lines {
  display: grid;
  flex: 1;
  gap: var(--space-2);
}

.ui-skeleton__dot,
.ui-skeleton__line {
  display: block;
  border-radius: var(--radius);
  background: linear-gradient(90deg, var(--bg-muted), var(--bg-hover), var(--bg-muted));
  background-size: 200% 100%;
  animation: ui-shimmer 1.4s ease-in-out infinite;
}

.ui-skeleton__dot {
  width: 16px;
  height: 16px;
  border-radius: 50%;
}

.ui-skeleton__line { height: 12px; }
.ui-skeleton__line--thin { height: 10px; }
.ui-skeleton__line--tall { height: 24px; }

@keyframes ui-shimmer {
  from { background-position: 100% 0; }
  to { background-position: -100% 0; }
}

@media (prefers-reduced-motion: reduce) {
  .ui-skeleton__dot,
  .ui-skeleton__line {
    animation: none;
  }
}
</style>
