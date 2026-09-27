<script setup lang="ts" generic="T extends string">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { SelectOption } from "./types";
import UiCounter from "./UiCounter.vue";

/** Tab strip. Tabs expose role="tab"; pair each panel with id `${idPrefix}-panel-${value}`. */
const props = defineProps<{ items: readonly SelectOption<T>[]; label: string; idPrefix: string }>();
const model = defineModel<T>({ required: true });

const nav = ref<HTMLElement | null>(null);
/** The underline slides to the selected tab; it only animates after its first placement. */
const indicator = ref({ left: 0, width: 0, visible: false, animated: false });
let resizeObserver: ResizeObserver | undefined;

/** Places the underline under the selected tab (its width changes with counts, so tabs are observed too). */
function placeIndicator(): void {
  const selected = nav.value?.querySelector<HTMLElement>('[aria-selected="true"]');
  if (!selected) {
    indicator.value = { ...indicator.value, visible: false };
    return;
  }
  indicator.value = {
    left: selected.offsetLeft,
    width: selected.offsetWidth,
    visible: true,
    animated: indicator.value.visible,
  };
}

function observeTabs(): void {
  resizeObserver?.disconnect();
  if (typeof ResizeObserver === "undefined" || !nav.value) return;
  resizeObserver = new ResizeObserver(placeIndicator);
  resizeObserver.observe(nav.value);
  for (const tab of nav.value.querySelectorAll("[role='tab']")) resizeObserver.observe(tab);
}

function onKeydown(event: KeyboardEvent, items: readonly SelectOption<T>[]): void {
  const index = items.findIndex((item) => item.value === model.value);
  const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
  if (!step) {
    return;
  }
  event.preventDefault();
  const next = items[(index + step + items.length) % items.length];
  if (next) {
    model.value = next.value;
    (event.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-value="${next.value}"]`)?.focus();
  }
}

watch(model, () => void nextTick(placeIndicator));
watch(
  () => props.items.map((item) => `${item.value}:${item.count ?? ""}`).join("|"),
  () =>
    void nextTick(() => {
      observeTabs();
      placeIndicator();
    }),
);

onMounted(() => {
  observeTabs();
  placeIndicator();
});
onBeforeUnmount(() => resizeObserver?.disconnect());
</script>

<template>
  <nav ref="nav" class="ui-underline-nav" role="tablist" :aria-label="label" @keydown="onKeydown($event, items)">
    <button
      v-for="item in items"
      :id="`${idPrefix}-tab-${item.value}`"
      :key="item.value"
      type="button"
      role="tab"
      :data-value="item.value"
      :aria-selected="model === item.value"
      :aria-controls="`${idPrefix}-panel-${item.value}`"
      :tabindex="model === item.value ? 0 : -1"
      :class="{ 'is-selected': model === item.value }"
      @click="model = item.value"
    >
      <component :is="item.icon" v-if="item.icon" :size="16" :stroke-width="1.75" aria-hidden="true" />
      <span>{{ item.label }}</span>
      <UiCounter v-if="item.count !== undefined" :count="item.count" />
    </button>
    <span
      v-show="indicator.visible"
      :class="['ui-underline-nav__indicator', { 'is-animated': indicator.animated }]"
      :style="{ width: `${indicator.width}px`, transform: `translateX(${indicator.left}px)` }"
      aria-hidden="true"
    ></span>
  </nav>
</template>

<style scoped>
.ui-underline-nav {
  position: relative;
  display: flex;
  gap: var(--space-2);
  margin-bottom: var(--space-6);
  border-bottom: 1px solid var(--border-muted);
  overflow-x: auto;
  scrollbar-width: none;
}

.ui-underline-nav button {
  position: relative;
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--space-2);
  height: 48px;
  padding: 0 var(--space-2);
  border: 0;
  background: none;
  color: var(--fg);
  font-size: var(--text-md);
  white-space: nowrap;
}

.ui-underline-nav button :deep(.lucide) {
  color: var(--fg-muted);
}

.ui-underline-nav button::after {
  content: "";
  position: absolute;
  right: 0;
  bottom: -1px;
  left: 0;
  height: 2px;
  border-radius: var(--radius);
  background: transparent;
}

.ui-underline-nav button:hover::after {
  background: var(--border);
}

.ui-underline-nav button.is-selected {
  font-weight: 600;
}

.ui-underline-nav button::after {
  transition: background-color var(--duration-instant) ease-out;
}

.ui-underline-nav button.is-selected:hover::after {
  background: transparent;
}

.ui-underline-nav__indicator {
  position: absolute;
  bottom: 0;
  left: 0;
  height: 2px;
  border-radius: var(--radius);
  background: var(--underline-active);
  pointer-events: none;
}

.ui-underline-nav__indicator.is-animated {
  transition:
    transform var(--duration-base) var(--ease-out),
    width var(--duration-base) var(--ease-out);
}

.ui-underline-nav button:focus-visible {
  outline-offset: -4px;
}
</style>
