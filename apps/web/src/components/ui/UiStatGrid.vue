<script setup lang="ts">
/**
 * Responsive grid for UiStatCard. `columns` is the wide layout (2 to 5); five columns first
 * drop to three below 1280px. Below 960px every layout is two columns, and the gap tightens below 640px,
 * where the five-column layout (whose cards carry long notes) becomes a single column.
 */
withDefaults(defineProps<{ columns?: 2 | 3 | 4 | 5 }>(), { columns: 4 });
</script>

<template>
  <div :class="['ui-stat-grid', `ui-stat-grid--${columns}`]"><slot /></div>
</template>

<style scoped>
.ui-stat-grid {
  display: grid;
  gap: var(--space-4);
}

.ui-stat-grid--2 {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.ui-stat-grid--3 {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.ui-stat-grid--4 {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.ui-stat-grid--5 {
  grid-template-columns: repeat(5, minmax(0, 1fr));
}

@media (max-width: 1279px) {
  .ui-stat-grid--5 {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 959px) {
  .ui-stat-grid--3,
  .ui-stat-grid--4,
  .ui-stat-grid--5 {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 639px) {
  .ui-stat-grid {
    gap: var(--space-2);
  }

  .ui-stat-grid--5 {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
