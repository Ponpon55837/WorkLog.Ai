<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";

/** Page title block. Title and eyebrow default to the current route meta. */
const props = defineProps<{ title?: string; eyebrow?: string; description?: string }>();
const route = useRoute();
const resolvedTitle = computed(() => props.title ?? route.meta.title ?? "");
const resolvedEyebrow = computed(() => props.eyebrow ?? route.meta.eyebrow);
</script>

<template>
  <header class="page-header">
    <div class="page-header__copy">
      <div v-if="resolvedEyebrow" class="page-header__eyebrow">{{ resolvedEyebrow }}</div>
      <h1>{{ resolvedTitle }}</h1>
      <p v-if="description || $slots.description">
        <slot name="description">{{ description }}</slot>
      </p>
    </div>
    <div v-if="$slots.actions" class="page-header__actions"><slot name="actions" /></div>
  </header>
</template>

<style scoped>
.page-header {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-4);
  margin-bottom: var(--space-6);
  padding-bottom: var(--space-4);
  border-bottom: 1px solid var(--border-muted);
}

.page-header__copy {
  min-width: 0;
}

.page-header__eyebrow {
  color: var(--fg-muted);
  font-size: var(--text-xs);
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.page-header h1 {
  margin-top: var(--space-1);
  color: var(--fg);
  font-size: var(--text-xl);
  font-weight: 600;
  line-height: 1.3;
}

.page-header p {
  margin-top: var(--space-1);
  color: var(--fg-muted);
  font-size: var(--text-md);
}

.page-header__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
</style>
