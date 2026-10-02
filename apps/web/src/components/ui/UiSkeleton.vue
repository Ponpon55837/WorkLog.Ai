<script setup lang="ts">
import { computed } from "vue";
import UiSpinner from "./UiSpinner.vue";
import { t } from "../../i18n";

/**
 * Placeholder shapes for content that is still loading, with a visible "loading" caption so a slow load never
 * reads as an empty page. `label` names what is loading; `quiet` drops the caption inside small panels.
 */
const props = withDefaults(
  defineProps<{ variant?: "row" | "card" | "text"; count?: number; label?: string; quiet?: boolean }>(),
  { variant: "row", count: 3 },
);

const caption = computed(() => props.label ?? t("ui.loadingData"));
</script>

<template>
  <!-- aria-label is not allowed on a role-less div, so the status role carries the caption text instead. -->
  <div :class="['ui-skeleton', `ui-skeleton--${variant}`]" role="status" aria-busy="true">
    <span v-if="quiet" class="sr-only">{{ caption }}</span>
    <span v-else class="ui-skeleton__caption"
      ><UiSpinner :size="14" :label="caption" aria-hidden="true" />{{ caption }}</span
    >
    <div v-for="index in count" :key="index" class="ui-skeleton__item" aria-hidden="true">
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
.ui-skeleton {
  animation: wi-fade-in var(--duration-base) var(--ease-out);
}

.ui-skeleton__caption {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--fg-muted);
  font-size: var(--text-sm);
}

.ui-skeleton--row .ui-skeleton__caption,
.ui-skeleton--text .ui-skeleton__caption {
  padding: var(--space-3) var(--space-4) 0;
}

.ui-skeleton--card .ui-skeleton__caption {
  grid-column: 1 / -1;
}

.ui-skeleton--text .ui-skeleton__caption {
  padding: 0 0 var(--space-2);
}

.ui-skeleton--row .ui-skeleton__item {
  display: flex;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--border-muted);
}

.ui-skeleton--row .ui-skeleton__item:nth-child(2) {
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
  /* The highlight uses the border colour so the sweep is visible on both themes. */
  background: linear-gradient(90deg, var(--bg-muted) 25%, var(--border) 50%, var(--bg-muted) 75%);
  background-size: 200% 100%;
  animation: ui-shimmer 1.4s ease-in-out infinite;
}

.ui-skeleton__dot {
  width: 16px;
  height: 16px;
  border-radius: 50%;
}

.ui-skeleton__line {
  height: 12px;
}
.ui-skeleton__line--thin {
  height: 10px;
}
.ui-skeleton__line--tall {
  height: 24px;
}

@keyframes ui-shimmer {
  from {
    background-position: 100% 0;
  }
  to {
    background-position: -100% 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .ui-skeleton__dot,
  .ui-skeleton__line {
    animation: none;
  }
}
</style>
