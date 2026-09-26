<script setup lang="ts" generic="T">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
  type ComponentPublicInstance,
} from "vue";

const props = withDefaults(
  defineProps<{
    items: readonly T[];
    enabled?: boolean;
    estimateItemHeight?: number;
    overscan?: number;
    label?: string;
    maxHeight?: string;
    fitViewport?: boolean;
    fitViewportToPanel?: boolean;
    fillAvailableSpace?: boolean;
  }>(),
  {
    enabled: false,
    estimateItemHeight: 96,
    overscan: 4,
    label: "可捲動清單",
    maxHeight: "min(68vh, 720px)",
    fitViewport: false,
    fitViewportToPanel: false,
    fillAvailableSpace: false,
  },
);

defineSlots<{
  default(props: { item: T; index: number }): unknown;
}>();

const viewport = ref<HTMLElement | null>(null);
const viewportHeight = ref(480);
const fitViewportPanelHeight = ref<number | null>(null);
const fitViewportPanelFillsAvailableSpace = ref(false);
const scrollTop = ref(0);
const heights = reactive(new Map<number, number>());
const itemElements = new Map<number, HTMLElement>();
let itemResizeObserver: ResizeObserver | undefined;
let viewportResizeObserver: ResizeObserver | undefined;
let fitViewportContentObserver: ResizeObserver | undefined;
let fitViewportMain: HTMLElement | null = null;

const offsets = computed(() => {
  const result = [0];
  let offset = 0;
  for (let index = 0; index < props.items.length; index += 1) {
    offset += heights.get(index) ?? props.estimateItemHeight;
    result.push(offset);
  }
  return result;
});

const totalHeight = computed(() => offsets.value.at(-1) ?? 0);

function findIndexAtOffset(offset: number): number {
  if (props.items.length === 0) {
    return 0;
  }

  const values = offsets.value;
  let low = 0;
  let high = values.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((values[middle + 1] ?? Number.POSITIVE_INFINITY) <= offset) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return Math.min(low, props.items.length - 1);
}

const startIndex = computed(() => {
  if (!props.enabled || props.items.length === 0) {
    return 0;
  }
  return Math.max(0, findIndexAtOffset(scrollTop.value) - props.overscan);
});

const endIndex = computed(() => {
  if (!props.enabled || props.items.length === 0) {
    return 0;
  }
  return Math.min(props.items.length, findIndexAtOffset(scrollTop.value + viewportHeight.value) + props.overscan + 1);
});

const visibleItems = computed(() =>
  Array.from({ length: Math.max(0, endIndex.value - startIndex.value) }, (_, offset) => {
    const index = startIndex.value + offset;
    return { index, item: props.items[index]! };
  }),
);

const topSpacerHeight = computed(() => offsets.value[startIndex.value] ?? 0);
const bottomSpacerHeight = computed(() =>
  Math.max(0, totalHeight.value - (offsets.value[endIndex.value] ?? totalHeight.value)),
);
const focusableSelector = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function getFocusableElements(index: number): HTMLElement[] {
  const item = itemElements.get(index);
  if (!item) {
    return [];
  }

  return Array.from(item.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) =>
      !element.hidden && element.getAttribute("aria-hidden") !== "true" && element.getClientRects().length > 0,
  );
}

async function focusItemEdge(index: number, edge: "first" | "last"): Promise<void> {
  const element = viewport.value;
  if (!element) {
    return;
  }

  element.scrollTop = offsets.value[index] ?? 0;
  scrollTop.value = element.scrollTop;
  await nextTick();

  const item = itemElements.get(index);
  if (!item) {
    return;
  }

  const focusableElements = getFocusableElements(index);
  const focusTarget = edge === "first" ? focusableElements[0] : focusableElements.at(-1);
  if (focusTarget) {
    focusTarget.focus({ preventScroll: true });
    return;
  }

  item.tabIndex = -1;
  item.focus({ preventScroll: true });
}

function handleKeydown(event: KeyboardEvent): void {
  if (!props.enabled || event.key !== "Tab" || !(event.target instanceof HTMLElement)) {
    return;
  }

  const item = event.target.closest<HTMLElement>(".virtual-list-item");
  if (!item || !viewport.value?.contains(item)) {
    return;
  }

  const itemIndex = Number(item.dataset.virtualIndex);
  if (!Number.isInteger(itemIndex)) {
    return;
  }

  const focusableElements = getFocusableElements(itemIndex);
  const focusIndex = focusableElements.indexOf(event.target);

  if (event.shiftKey && itemIndex === startIndex.value && focusIndex === 0 && itemIndex > 0) {
    event.preventDefault();
    void focusItemEdge(itemIndex - 1, "last");
    return;
  }

  if (
    !event.shiftKey &&
    itemIndex === endIndex.value - 1 &&
    focusIndex === focusableElements.length - 1 &&
    itemIndex < props.items.length - 1
  ) {
    event.preventDefault();
    void focusItemEdge(itemIndex + 1, "first");
  }
}

function updateViewportHeight(): void {
  viewportHeight.value = viewport.value?.clientHeight || 480;
}

function keepFitViewportPanelVisible(): void {
  const list = viewport.value;
  const panel = list?.closest<HTMLElement>(".ui-box");
  const main = fitViewportMain;
  const footer = panel?.querySelector<HTMLElement>(".ui-box__footer");
  if (
    !props.fitViewport ||
    (props.fitViewportToPanel && fitViewportPanelHeight.value !== null && !fitViewportPanelFillsAvailableSpace.value) ||
    !panel ||
    !footer ||
    !main
  ) {
    return;
  }

  const bottomInset =
    fitViewportPanelFillsAvailableSpace.value && !props.fillAvailableSpace
      ? Number.parseFloat(window.getComputedStyle(document.documentElement).getPropertyValue("--space-6")) || 24
      : 0;
  const overflow = footer.getBoundingClientRect().bottom - (main.getBoundingClientRect().bottom - bottomInset);
  if (overflow > 1) {
    main.scrollTop = Math.min(main.scrollTop + overflow, main.scrollHeight - main.clientHeight);
  }
}

function getDefaultFitViewportHeight(): number {
  const mobile = window.matchMedia("(max-width: 639px)").matches;
  const rem = Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
  const calculated = window.innerHeight - (mobile ? 36 : 30) * rem;
  return mobile ? Math.max(180, calculated) : Math.min(360, Math.max(180, calculated));
}

function updateFitViewportPanelHeight(): void {
  const list = viewport.value;
  const main = fitViewportMain;
  if (!props.fitViewport || !props.fitViewportToPanel || !list || !main) {
    fitViewportPanelFillsAvailableSpace.value = false;
    return;
  }

  const panel = list.closest<HTMLElement>(".ui-box");
  const body = list.parentElement;
  const mainBottom = main.getBoundingClientRect().bottom;
  const listTop = list.getBoundingClientRect().top;
  const footerHeight = panel?.querySelector<HTMLElement>(".ui-box__footer")?.getBoundingClientRect().height ?? 0;
  const borderBottom = panel ? Number.parseFloat(window.getComputedStyle(panel).borderBottomWidth) || 0 : 0;
  const bottomInset =
    Number.parseFloat(window.getComputedStyle(document.documentElement).getPropertyValue("--space-6")) || 24;

  let trailingHeight = 0;
  if (body) {
    const siblings = Array.from(body.children);
    const listIndex = siblings.indexOf(list);
    const lastTrailingSibling = siblings
      .slice(listIndex + 1)
      .reverse()
      .find((element) => element.getBoundingClientRect().height > 0);
    if (lastTrailingSibling) {
      const trailingRect = lastTrailingSibling.getBoundingClientRect();
      const trailingMargin = Number.parseFloat(window.getComputedStyle(lastTrailingSibling).marginBottom) || 0;
      trailingHeight = Math.max(0, trailingRect.bottom + trailingMargin - list.getBoundingClientRect().bottom);
    }
  }

  const fillsAvailableSpace = props.fillAvailableSpace && !window.matchMedia("(max-width: 639px)").matches;

  if (fillsAvailableSpace) {
    // Keep paginated lists the same height and extend them to the viewport edge.
    const rem = Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
    fitViewportPanelHeight.value = Math.max(180, Math.floor(main.clientHeight - 20 * rem + bottomInset - borderBottom));
    fitViewportPanelFillsAvailableSpace.value = true;
    return;
  }

  // Below the current fold, keep the normal list height so page scrolling can reveal the whole Box.
  const nextHeight = Math.floor(mainBottom - bottomInset - listTop - trailingHeight - footerHeight - borderBottom);
  if (nextHeight <= 0) {
    fitViewportPanelHeight.value = null;
    fitViewportPanelFillsAvailableSpace.value = false;
    return;
  }

  if (footerHeight > 0 && nextHeight < getDefaultFitViewportHeight()) {
    fitViewportPanelHeight.value = null;
    fitViewportPanelFillsAvailableSpace.value = false;
    return;
  }

  fitViewportPanelFillsAvailableSpace.value = footerHeight === 0;
  // Reserve room for the footer and any note after the list.
  if (fitViewportPanelHeight.value === null || Math.abs(fitViewportPanelHeight.value - nextHeight) > 1) {
    fitViewportPanelHeight.value = nextHeight;
  }
}

function handleFitViewportResize(): void {
  keepFitViewportPanelVisible();
  updateFitViewportPanelHeight();
}

function handleScroll(event: Event): void {
  scrollTop.value = (event.currentTarget as HTMLElement).scrollTop;
}

function updateMeasuredHeight(element: HTMLElement): void {
  const index = Number(element.dataset.virtualIndex);
  if (!Number.isInteger(index)) {
    return;
  }
  const height = element.getBoundingClientRect().height;
  if (height > 0 && Math.abs((heights.get(index) ?? 0) - height) > 0.5) {
    heights.set(index, height);
  }
}

function setItemElement(index: number, element: Element | ComponentPublicInstance | null): void {
  const previous = itemElements.get(index);
  if (previous && previous !== element) {
    itemResizeObserver?.unobserve(previous);
    itemElements.delete(index);
  }

  if (!(element instanceof HTMLElement)) {
    return;
  }

  element.dataset.virtualIndex = String(index);
  itemElements.set(index, element);
  itemResizeObserver?.observe(element);
  updateMeasuredHeight(element);
}

function resetLayout(): void {
  heights.clear();
  for (const element of itemElements.values()) {
    itemResizeObserver?.unobserve(element);
  }
  itemElements.clear();
  scrollTop.value = 0;
  if (viewport.value) {
    viewport.value.scrollTop = 0;
  }
  void nextTick(() => {
    updateViewportHeight();
    updateFitViewportPanelHeight();
  });
}

watch(() => props.items, resetLayout);
watch(
  () => props.enabled,
  () => {
    resetLayout();
    void nextTick(() => {
      updateViewportHeight();
      updateFitViewportPanelHeight();
    });
  },
);

onMounted(() => {
  updateViewportHeight();
  if (props.fitViewport) {
    fitViewportMain = viewport.value?.closest<HTMLElement>("#main") ?? null;
    const content = fitViewportMain?.querySelector<HTMLElement>(".app-shell__content");
    if (content && typeof ResizeObserver !== "undefined") {
      fitViewportContentObserver = new ResizeObserver(handleFitViewportResize);
      fitViewportContentObserver.observe(content);
      if (fitViewportMain) {
        fitViewportContentObserver.observe(fitViewportMain);
      }
    }
    window.addEventListener("resize", handleFitViewportResize);
    updateFitViewportPanelHeight();
    void nextTick(handleFitViewportResize);
  }
  if (typeof ResizeObserver === "undefined") {
    return;
  }

  itemResizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      updateMeasuredHeight(entry.target as HTMLElement);
    }
  });
  viewportResizeObserver = new ResizeObserver(updateViewportHeight);
  if (viewport.value) {
    viewportResizeObserver.observe(viewport.value);
  }
});

onBeforeUnmount(() => {
  itemResizeObserver?.disconnect();
  viewportResizeObserver?.disconnect();
  fitViewportContentObserver?.disconnect();
  window.removeEventListener("resize", handleFitViewportResize);
  fitViewportMain = null;
});
</script>

<template>
  <div
    ref="viewport"
    class="virtual-list"
    :class="{
      'virtual-list-disabled': !enabled,
      'virtual-list-fit-viewport': fitViewport,
      'virtual-list-fit-viewport-to-panel': fitViewport && fitViewportToPanel && fitViewportPanelHeight !== null,
      'virtual-list-fit-viewport-to-panel-fill': fitViewportPanelFillsAvailableSpace && fitViewportPanelHeight !== null,
      'virtual-list-fit-viewport-to-panel-shared-fill':
        fillAvailableSpace && fitViewport && fitViewportToPanel && fitViewportPanelFillsAvailableSpace,
    }"
    :style="
      enabled && fitViewport && fitViewportToPanel && fitViewportPanelHeight !== null
        ? { '--virtual-list-panel-height': `${fitViewportPanelHeight}px` }
        : enabled && !fitViewport
          ? { maxHeight }
          : undefined
    "
    :role="enabled ? 'list' : undefined"
    :aria-label="enabled ? label : undefined"
    :tabindex="enabled ? 0 : undefined"
    @scroll="handleScroll"
    @keydown="handleKeydown"
  >
    <template v-if="!enabled">
      <template v-for="(item, index) in items" :key="index">
        <slot :item="item" :index="index" />
      </template>
    </template>
    <template v-else>
      <div class="virtual-list-spacer" :style="{ height: `${topSpacerHeight}px` }" aria-hidden="true"></div>
      <div
        v-for="entry in visibleItems"
        :key="entry.index"
        class="virtual-list-item"
        role="listitem"
        :aria-setsize="items.length"
        :aria-posinset="entry.index + 1"
        :ref="(element) => setItemElement(entry.index, element)"
      >
        <slot :item="entry.item" :index="entry.index" />
      </div>
      <div class="virtual-list-spacer" :style="{ height: `${bottomSpacerHeight}px` }" aria-hidden="true"></div>
    </template>
  </div>
</template>

<style scoped>
.virtual-list {
  width: 100%;
}

.virtual-list:not(.virtual-list-disabled) {
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

.virtual-list-fit-viewport {
  height: min(360px, max(180px, calc(100dvh - 30rem)));
  max-height: min(360px, max(180px, calc(100dvh - 30rem)));
}

@media (max-width: 639px) {
  .virtual-list-fit-viewport {
    height: max(180px, calc(100dvh - 36rem));
    max-height: max(180px, calc(100dvh - 36rem));
  }
}

.virtual-list-fit-viewport-to-panel {
  height: min(var(--virtual-list-panel-height, 0px), min(360px, max(180px, calc(100dvh - 30rem))));
  max-height: min(var(--virtual-list-panel-height, 0px), min(360px, max(180px, calc(100dvh - 30rem))));
}

.virtual-list-fit-viewport-to-panel-fill {
  height: min(var(--virtual-list-panel-height, 0px), 720px);
  max-height: min(var(--virtual-list-panel-height, 0px), 720px);
}

@media (max-width: 639px) {
  .virtual-list-fit-viewport-to-panel {
    height: min(var(--virtual-list-panel-height, 0px), max(180px, calc(100dvh - 36rem)));
    max-height: min(var(--virtual-list-panel-height, 0px), max(180px, calc(100dvh - 36rem)));
  }
}

.virtual-list-fit-viewport-to-panel-shared-fill {
  height: var(--virtual-list-panel-height, 0px);
  max-height: var(--virtual-list-panel-height, 0px);
}

.virtual-list-disabled {
  display: contents;
}

.virtual-list-item {
  min-width: 0;
}

.virtual-list-spacer {
  width: 100%;
  pointer-events: none;
}
</style>
