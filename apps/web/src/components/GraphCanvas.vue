<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { GraphEdge, GraphNode } from "@work-intelligence/core";
import type { GraphVisualEdge, GraphVisualNode } from "../composables/useGraph";

/**
 * Lane-based SVG graph (one column per node kind). Only nodes near the viewport are rendered;
 * the lane header stays sticky while scrolling.
 */
const props = defineProps<{
  nodes: readonly GraphVisualNode[];
  edges: readonly GraphVisualEdge[];
  width: number;
  height: number;
  nodeKindOrder: readonly GraphNode["kind"][];
  nodeKindLabels: Readonly<Record<GraphNode["kind"], string>>;
  edgeKindLabels: Readonly<Record<GraphEdge["kind"], string>>;
  nodeLabel: (value: string) => string;
  nodeDescription: (node: GraphNode) => string;
  selectedId?: string;
}>();

const emit = defineEmits<{ select: [node: GraphNode] }>();

const viewport = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewportHeight = ref(660);
const laneHeaderHeight = 44;
const overscan = 232;
let resizeObserver: ResizeObserver | undefined;

function updateViewportHeight(): void {
  viewportHeight.value = viewport.value?.clientHeight || 660;
}

function handleScroll(event: Event): void {
  scrollTop.value = (event.currentTarget as HTMLElement).scrollTop;
}

function clipId(value: string): string {
  return `graph-node-clip-${encodeURIComponent(value).replace(/%/g, "_")}`;
}

const renderedNodes = computed(() => {
  const top = scrollTop.value - laneHeaderHeight - overscan;
  const bottom = scrollTop.value + viewportHeight.value - laneHeaderHeight + overscan;
  return props.nodes.filter((item) => item.y >= top && item.y <= bottom);
});

const renderedNodeIds = computed(() => new Set(renderedNodes.value.map((item) => item.node.id)));
const renderedEdges = computed(() =>
  props.edges.filter((item) => renderedNodeIds.value.has(item.from.node.id) && renderedNodeIds.value.has(item.to.node.id))
);

onMounted(() => {
  updateViewportHeight();
  if (typeof ResizeObserver === "undefined") {
    return;
  }
  resizeObserver = new ResizeObserver(updateViewportHeight);
  if (viewport.value) {
    resizeObserver.observe(viewport.value);
  }
});

onBeforeUnmount(() => resizeObserver?.disconnect());
</script>

<template>
  <div ref="viewport" class="graph-canvas" data-testid="graph-viewport" role="group" aria-label="Work Intelligence 結構化工作關係圖" @scroll="handleScroll">
    <div class="graph-canvas__lanes" data-testid="graph-lane-header" aria-hidden="true" :style="{ width: `${width}px` }">
      <span v-for="kind in nodeKindOrder" :key="kind">{{ nodeKindLabels[kind] }}</span>
    </div>
    <svg class="graph-canvas__svg" :viewBox="`0 0 ${width} ${height}`" :style="{ width: `${width}px` }" preserveAspectRatio="xMinYMin meet">
      <defs>
        <marker id="graph-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="strokeWidth">
          <path d="M0,0 L7,3.5 L0,7 z" class="graph-canvas__arrow"></path>
        </marker>
        <clipPath v-for="item in renderedNodes" :id="clipId(item.node.id)" :key="clipId(item.node.id)" clipPathUnits="userSpaceOnUse">
          <rect x="-80" y="-17" width="160" height="34" rx="3"></rect>
        </clipPath>
      </defs>
      <line
        v-for="item in renderedEdges"
        :key="item.edge.id"
        :class="['graph-canvas__edge', { 'is-highlighted': selectedId && (item.from.node.id === selectedId || item.to.node.id === selectedId) }]"
        :x1="item.from.x + 92"
        :y1="item.from.y"
        :x2="item.to.x - 92"
        :y2="item.to.y"
        marker-end="url(#graph-arrow)"
      >
        <title>{{ edgeKindLabels[item.edge.kind] }}</title>
      </line>
      <g
        v-for="item in renderedNodes"
        :key="item.node.id"
        :class="['graph-canvas__node', `graph-canvas__node--${item.node.kind}`, { 'is-selected': item.node.id === selectedId }]"
        :transform="`translate(${item.x}, ${item.y})`"
        role="button"
        tabindex="0"
        :aria-label="`查看${nodeKindLabels[item.node.kind]}：${item.node.label}`"
        :aria-pressed="item.node.id === selectedId"
        @click="emit('select', item.node)"
        @keydown.enter="emit('select', item.node)"
        @keydown.space.prevent="emit('select', item.node)"
      >
        <title>{{ item.node.label }} · {{ nodeKindLabels[item.node.kind] }}</title>
        <rect x="-92" y="-20" width="184" height="40" rx="6"></rect>
        <text class="graph-canvas__label" x="-80" y="-3" :clip-path="`url(#${clipId(item.node.id)})`">{{ nodeLabel(item.node.label) }}</text>
        <text class="graph-canvas__meta" x="-80" y="13" :clip-path="`url(#${clipId(item.node.id)})`">{{ nodeDescription(item.node) }}</text>
      </g>
    </svg>
  </div>
</template>

<style scoped>
.graph-canvas {
  position: relative;
  height: max(420px, calc(100vh - 300px));
  overflow: auto;
  overscroll-behavior: contain;
  background: var(--bg-inset);
}

.graph-canvas__lanes {
  position: sticky;
  top: 0;
  z-index: 2;
  display: grid;
  grid-template-columns: repeat(5, 220px);
  align-items: center;
  height: 44px;
  border-bottom: 1px solid var(--border-muted);
  background: var(--bg-inset);
  color: var(--fg-muted);
  font-size: var(--text-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-align: center;
}

.graph-canvas__svg {
  display: block;
  height: auto;
}

.graph-canvas__arrow {
  fill: var(--border-strong);
}

.graph-canvas__edge {
  stroke: var(--border);
  stroke-width: 1.4;
}

.graph-canvas__edge.is-highlighted {
  stroke: var(--accent);
  stroke-width: 2;
}

.graph-canvas__node {
  cursor: pointer;
  outline: none;
}

.graph-canvas__node rect {
  fill: var(--bg-subtle);
  stroke: var(--border);
  stroke-width: 1.2;
}

.graph-canvas__node--project rect { fill: var(--success-soft); stroke: var(--success-border); }
.graph-canvas__node--session rect { fill: var(--accent-soft); stroke: var(--accent-border); }
.graph-canvas__node--knowledge rect { fill: var(--done-soft); stroke: var(--done-border); }
.graph-canvas__node--evidence rect { fill: var(--attention-soft); stroke: var(--attention-border); }

.graph-canvas__node:hover rect,
.graph-canvas__node:focus-visible rect {
  stroke: var(--fg-muted);
  stroke-width: 1.8;
}

.graph-canvas__node.is-selected rect {
  stroke: var(--accent);
  stroke-width: 2.2;
}

.graph-canvas__label,
.graph-canvas__meta {
  pointer-events: none;
}

.graph-canvas__label {
  fill: var(--fg);
  font-size: 12px;
  font-weight: 600;
}

.graph-canvas__meta {
  fill: var(--fg-muted);
  font-size: 12px;
}
</style>
