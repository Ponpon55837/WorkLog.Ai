<script setup lang="ts">
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
