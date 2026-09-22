<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch, type ComponentPublicInstance } from "vue";

const props = withDefaults(
  defineProps<{
    items: readonly unknown[];
    enabled?: boolean;
    estimateItemHeight?: number;
    overscan?: number;
    ariaLabel?: string;
    maxHeight?: string;
  }>(),
  {
    enabled: false,
    estimateItemHeight: 96,
    overscan: 4,
    ariaLabel: "可捲動清單",
    maxHeight: "min(68vh, 720px)"
  }
);

defineSlots<{
  default(props: { item: any; index: number }): any;
}>();

const viewport = ref<HTMLElement | null>(null);
const viewportHeight = ref(480);
const scrollTop = ref(0);
const heights = reactive(new Map<number, number>());
const itemElements = new Map<number, HTMLElement>();
let itemResizeObserver: ResizeObserver | undefined;
let viewportResizeObserver: ResizeObserver | undefined;

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
    return { index, item: props.items[index] };
  })
);

const topSpacerHeight = computed(() => offsets.value[startIndex.value] ?? 0);
const bottomSpacerHeight = computed(() => Math.max(0, totalHeight.value - (offsets.value[endIndex.value] ?? totalHeight.value)));

function updateViewportHeight(): void {
  viewportHeight.value = viewport.value?.clientHeight || 480;
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
  void nextTick(updateViewportHeight);
}

watch(() => props.items, resetLayout);
watch(() => props.enabled, () => {
  resetLayout();
  void nextTick(updateViewportHeight);
});

onMounted(() => {
  updateViewportHeight();
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
});
</script>

<template>
  <div
    ref="viewport"
    class="virtual-list"
    :class="{ 'virtual-list-disabled': !enabled }"
    :style="enabled ? { maxHeight } : undefined"
    :role="enabled ? 'list' : undefined"
    :aria-label="enabled ? ariaLabel : undefined"
    @scroll="handleScroll"
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
        :ref="(element) => setItemElement(entry.index, element)"
      >
        <slot :item="entry.item" :index="entry.index" />
      </div>
      <div class="virtual-list-spacer" :style="{ height: `${bottomSpacerHeight}px` }" aria-hidden="true"></div>
    </template>
  </div>
</template>
