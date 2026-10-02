<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import { t } from "../../i18n";

/**
 * Compact one-row page title: eyebrow, title and a one-line description share a row with the actions,
 * so the page's data starts right below. Title and eyebrow default to the current route meta.
 */
const props = defineProps<{ title?: string; eyebrow?: string; description?: string }>();
const route = useRoute();
const resolvedTitle = computed(() => props.title ?? t(route.meta.title ?? ""));
const resolvedEyebrow = computed(() => props.eyebrow ?? route.meta.eyebrow);
</script>

<template>
  <header class="page-header">
    <div class="page-header__copy">
      <span v-if="resolvedEyebrow" class="page-header__eyebrow">{{ resolvedEyebrow }}</span>
      <h1>{{ resolvedTitle }}</h1>
      <p v-if="description || $slots.description" class="page-header__description" :title="description">
        <slot name="description">{{ description }}</slot>
      </p>
    </div>
    <div v-if="$slots.actions" class="page-header__actions"><slot name="actions" /></div>
  </header>
</template>

<style scoped>
/* When the actions leave the title less than 360px, they wrap below instead of hiding the description. */
.page-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3) var(--space-4);
  min-height: 32px;
  margin-bottom: var(--space-3);
}

.page-header__copy {
  display: flex;
  flex: 1 1 360px;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
}

.page-header__eyebrow {
  flex: none;
  color: var(--fg-muted);
  font-size: var(--text-xs);
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.page-header h1 {
  flex: none;
  color: var(--fg);
  font-size: var(--text-lg);
  font-weight: 600;
  line-height: 1.4;
}

/* One line: the full text stays available on hover instead of pushing the data down. */
.page-header__description {
  min-width: 0;
  overflow: hidden;
  color: var(--fg-muted);
  font-size: var(--text-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.page-header__actions {
  display: flex;
  flex: 0 1 auto;
  flex-wrap: wrap;
  max-width: 100%;
  align-items: center;
  gap: var(--space-2);
}

/*
 * Phones: the app bar already names the page, so drop the eyebrow and give the description its own line. It
 * stays one line so a longer description (a custom report range) never pushes the controls below it.
 */
@media (max-width: 639px) {
  .page-header__copy {
    flex-wrap: wrap;
    row-gap: 0;
  }

  .page-header__eyebrow {
    display: none;
  }

  .page-header__description {
    flex-basis: 100%;
  }

  /* Actions take their own full row so their controls keep a stable width. */
  .page-header__actions {
    flex: 1 1 100%;
  }
}
</style>
