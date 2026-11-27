<script setup lang="ts">
import { X } from "lucide-vue-next";
import type { FilterChip } from "./types";
import UiButton from "./UiButton.vue";
import { t } from "../../i18n";

/** The filters a list currently applies, each removable on its own; `clearable` adds a clear-all link. */
defineProps<{ chips: readonly FilterChip[]; clearable?: boolean }>();

const emit = defineEmits<{ remove: [key: string]; clear: [] }>();
</script>

<template>
  <div v-if="chips.length" class="ui-filter-chips" role="group" :aria-label="t('ui.appliedFilters')">
    <span v-for="chip in chips" :key="chip.key" class="ui-filter-chips__chip">
      <span class="ui-filter-chips__text" :title="chip.label">{{ chip.label }}</span>
      <button
        type="button"
        class="ui-filter-chips__remove"
        :aria-label="t('ui.removeFilter', { filter: chip.label })"
        @click="emit('remove', chip.key)"
      >
        <X :size="12" :stroke-width="2" aria-hidden="true" />
      </button>
    </span>
    <UiButton v-if="clearable" variant="link" size="sm" @click="emit('clear')">{{ t("common.clearFilters") }}</UiButton>
  </div>
</template>

<style scoped>
.ui-filter-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border-muted);
}

.ui-filter-chips__chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  max-width: 100%;
  min-width: 0;
  height: 24px;
  padding: 0 var(--space-1) 0 var(--space-2);
  border-radius: var(--radius-pill);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--text-xs);
  font-weight: 500;
}

.ui-filter-chips__text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ui-filter-chips__remove {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-pill);
  background: none;
  color: inherit;
}

.ui-filter-chips__remove:hover {
  background: var(--accent-border);
}
</style>
