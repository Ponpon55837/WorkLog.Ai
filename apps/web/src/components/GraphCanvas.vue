<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { GraphEdge, GraphNode } from "@work-intelligence/core";
import type { GraphVisualEdge, GraphVisualNode } from "../composables/useGraph";

/**
 * Lane-based SVG graph (one column per node kind). Lanes stretch to the available width, only
 * nodes near the viewport are rendered, and the lane header stays sticky while scrolling. A
 * selected node keeps its direct neighbours bright and dims everything else. A docked panel may
 * overlay the right edge (`overlayWidth`); the canvas then adds scroll room and reveals nodes left of it.
 */
const props = defineProps<{
  nodes: readonly GraphVisualNode[];
  edges: readonly GraphVisualEdge[];
  height: number;
  nodeKindOrder: readonly GraphNode["kind"][];
  nodeKindLabels: Readonly<Record<GraphNode["kind"], string>>;
  edgeKindLabels: Readonly<Record<GraphEdge["kind"], string>>;
  nodeLabel: (node: GraphNode, maxDisplayUnits: number) => string;
  nodeDescription: (node: GraphNode, maxDisplayUnits: number) => string;
  selectedId?: string;
  /** Search hits; when non-empty, nodes outside it are shown as context only. */
  matchIds?: ReadonlySet<string>;
  /** Width of a fixed panel covering the right side of the window (0 when none). */
  overlayWidth?: number;
}>();

const emit = defineEmits<{ select: [node: GraphNode]; clear: [] }>();

const viewport = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewportHeight = ref(660);
const viewportWidth = ref(1_100);
const hoveredId = ref<string | null>(null);
const obscuredRight = ref(0);
const laneHeaderHeight = 44;
const overscan = 232;
const minLaneWidth = 220;
const nodeHeight = 40;
let resizeObserver: ResizeObserver | undefined;

const laneWidth = computed(() =>
  Math.max(minLaneWidth, Math.floor(viewportWidth.value / Math.max(props.nodeKindOrder.length, 1))),
);
// Extra room on the right lets nodes in the last lanes scroll out from under the overlaying panel.
const canvasWidth = computed(() => laneWidth.value * props.nodeKindOrder.length + obscuredRight.value);
const nodeWidth = computed(() => laneWidth.value - 36);
const laneHeaderStyle = computed(() => ({
  width: `${canvasWidth.value}px`,
  gridTemplateColumns: `repeat(${props.nodeKindOrder.length}, ${laneWidth.value}px) auto`,
}));
// ~6.4px per display unit at 12px (CJK counts as 2 units), minus the 12px text inset on each side.
const labelUnits = computed(() => Math.max(12, Math.floor((nodeWidth.value - 24) / 6.4)));

function laneCentre(lane: number): number {
  return lane * laneWidth.value + laneWidth.value / 2;
}

function updateObscuredRight(): void {
  const element = viewport.value;
  const overlay = props.overlayWidth ?? 0;
  if (!element || overlay <= 0) {
    obscuredRight.value = 0;
    return;
  }
  const right = element.getBoundingClientRect().right;
  obscuredRight.value = Math.max(0, Math.round(right - (window.innerWidth - overlay)));
}

function updateViewportSize(): void {
  // Lane width uses the whole canvas: the panel overlays it instead of squeezing the lanes.
  viewportHeight.value = viewport.value?.clientHeight || 660;
  viewportWidth.value = viewport.value?.clientWidth || 1_100;
  updateObscuredRight();
}

function handleScroll(event: Event): void {
  scrollTop.value = (event.currentTarget as HTMLElement).scrollTop;
}

function clipId(value: string): string {
  return `graph-node-clip-${encodeURIComponent(value).replace(/%/g, "_")}`;
}

function edgePath(item: GraphVisualEdge): string {
  const half = nodeWidth.value / 2;
  const x1 = laneCentre(item.from.lane) + half;
  const x2 = laneCentre(item.to.lane) - half;
  const bend = Math.max((x2 - x1) / 2, 24);
  return `M${x1},${item.from.y} C${x1 + bend},${item.from.y} ${x2 - bend},${item.to.y} ${x2},${item.to.y}`;
}

const focusNeighbourIds = computed(() => {
  const focus = props.selectedId;
  if (!focus) {
    return null;
  }
  const ids = new Set<string>([focus]);
  for (const item of props.edges) {
    if (item.from.node.id === focus) {
      ids.add(item.to.node.id);
    } else if (item.to.node.id === focus) {
      ids.add(item.from.node.id);
    }
  }
  return ids;
});

function touches(item: GraphVisualEdge, id: string | null | undefined): boolean {
  return Boolean(id) && (item.from.node.id === id || item.to.node.id === id);
}

function nodeClasses(item: GraphVisualNode): (string | Record<string, boolean>)[] {
  const focus = focusNeighbourIds.value;
  const matches = props.matchIds;
  return [
    "graph-canvas__node",
    `graph-canvas__node--${item.node.kind}`,
    {
      "is-selected": item.node.id === props.selectedId,
      "is-dimmed": focus ? !focus.has(item.node.id) : false,
      "is-context": !focus && Boolean(matches?.size) && !matches?.has(item.node.id),
      "is-match": Boolean(matches?.has(item.node.id)),
    },
  ];
}

function edgeClasses(item: GraphVisualEdge): Record<string, boolean> {
  const focus = props.selectedId;
  return {
    "graph-canvas__edge": true,
    "is-highlighted": touches(item, focus) || touches(item, hoveredId.value),
    "is-dimmed": Boolean(focus) && !touches(item, focus),
  };
}

const renderedNodes = computed(() => {
  const top = scrollTop.value - laneHeaderHeight - overscan;
  const bottom = scrollTop.value + viewportHeight.value - laneHeaderHeight + overscan;
  return props.nodes.filter((item) => item.y >= top && item.y <= bottom);
});

const renderedNodeIds = computed(() => new Set(renderedNodes.value.map((item) => item.node.id)));
// An edge is drawn when either end is on screen, so a link to a far-away node is not cut off.
const renderedEdges = computed(() =>
  props.edges.filter(
    (item) => renderedNodeIds.value.has(item.from.node.id) || renderedNodeIds.value.has(item.to.node.id),
  ),
);

/** Brings the selected node into view (e.g. when it was picked from the panel's relation list). */
async function revealSelected(): Promise<void> {
  const target = props.nodes.find((item) => item.node.id === props.selectedId);
  const element = viewport.value;
  if (!target || !element) {
    return;
  }
  await nextTick();
  updateObscuredRight();
  const nodeTop = target.y + laneHeaderHeight - nodeHeight / 2;
  const nodeBottom = target.y + laneHeaderHeight + nodeHeight / 2;
  const visibleTop = element.scrollTop + laneHeaderHeight;
  const visibleBottom = element.scrollTop + element.clientHeight;
  const centreX = laneCentre(target.lane);
  // Only the part of the canvas left of an overlaying panel counts as visible.
  const visibleWidth = Math.max(nodeWidth.value, element.clientWidth - obscuredRight.value);
  const horizontallyVisible =
    centreX - nodeWidth.value / 2 >= element.scrollLeft &&
    centreX + nodeWidth.value / 2 <= element.scrollLeft + visibleWidth;
  if (nodeTop >= visibleTop && nodeBottom <= visibleBottom && horizontallyVisible) {
    return;
  }
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  element.scrollTo({
    top: Math.max(0, target.y + laneHeaderHeight - element.clientHeight / 2),
    left: horizontallyVisible ? element.scrollLeft : Math.max(0, centreX - visibleWidth / 2),
    behavior: reduceMotion ? "auto" : "smooth",
  });
}

watch(
  () => props.selectedId,
  () => void revealSelected(),
);
watch(
  () => props.overlayWidth,
  () => {
    updateObscuredRight();
    void revealSelected();
  },
);

onMounted(() => {
  updateViewportSize();
  window.addEventListener("resize", updateObscuredRight);
  if (typeof ResizeObserver === "undefined") {
    return;
  }
  resizeObserver = new ResizeObserver(updateViewportSize);
  if (viewport.value) {
    resizeObserver.observe(viewport.value);
  }
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  window.removeEventListener("resize", updateObscuredRight);
});
</script>

<template>
  <div
    ref="viewport"
    :class="['graph-canvas', { 'has-focus': selectedId }]"
    data-testid="graph-viewport"
    role="group"
    aria-label="Work Intelligence 結構化工作關係圖"
    @scroll="handleScroll"
    @keydown.esc="emit('clear')"
  >
    <div class="graph-canvas__lanes" data-testid="graph-lane-header" aria-hidden="true" :style="laneHeaderStyle">
      <span v-for="kind in nodeKindOrder" :key="kind">{{ nodeKindLabels[kind] }}</span>
    </div>
    <svg
      class="graph-canvas__svg"
      :viewBox="`0 0 ${canvasWidth} ${height}`"
      :style="{ width: `${canvasWidth}px` }"
      preserveAspectRatio="xMinYMin meet"
    >
      <defs>
        <marker
          id="graph-arrow"
          markerWidth="7"
          markerHeight="7"
          refX="6"
          refY="3.5"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path d="M0,0 L7,3.5 L0,7 z" class="graph-canvas__arrow"></path>
        </marker>
        <clipPath
          v-for="item in renderedNodes"
          :id="clipId(item.node.id)"
          :key="clipId(item.node.id)"
          clipPathUnits="userSpaceOnUse"
        >
          <rect :x="-nodeWidth / 2 + 12" y="-17" :width="nodeWidth - 24" height="34" rx="3"></rect>
        </clipPath>
      </defs>
      <path
        v-for="item in renderedEdges"
        :key="item.edge.id"
        :class="edgeClasses(item)"
        :d="edgePath(item)"
        marker-end="url(#graph-arrow)"
      >
        <title>{{ edgeKindLabels[item.edge.kind] }}</title>
      </path>
      <g
        v-for="item in renderedNodes"
        :key="item.node.id"
        :class="nodeClasses(item)"
        :transform="`translate(${laneCentre(item.lane)}, ${item.y})`"
        role="button"
        tabindex="0"
        :aria-label="`查看${nodeKindLabels[item.node.kind]}：${item.node.label}`"
        :aria-pressed="item.node.id === selectedId"
        @click="emit('select', item.node)"
        @keydown.enter="emit('select', item.node)"
        @keydown.space.prevent="emit('select', item.node)"
        @mouseenter="hoveredId = item.node.id"
        @mouseleave="hoveredId = null"
      >
        <title>{{ item.node.label }} · {{ nodeKindLabels[item.node.kind] }}</title>
        <!-- Opaque base so edges passing behind a node never show through its tinted fill. -->
        <rect
          class="graph-canvas__node-base"
          :x="-nodeWidth / 2"
          :y="-nodeHeight / 2"
          :width="nodeWidth"
          :height="nodeHeight"
          rx="6"
        ></rect>
        <rect
          class="graph-canvas__node-box"
          :x="-nodeWidth / 2"
          :y="-nodeHeight / 2"
          :width="nodeWidth"
          :height="nodeHeight"
          rx="6"
        ></rect>
        <text class="graph-canvas__label" :x="-nodeWidth / 2 + 12" y="-3" :clip-path="`url(#${clipId(item.node.id)})`">
          {{ nodeLabel(item.node, labelUnits) }}
        </text>
        <text class="graph-canvas__meta" :x="-nodeWidth / 2 + 12" y="13" :clip-path="`url(#${clipId(item.node.id)})`">
          {{ nodeDescription(item.node, labelUnits) }}
        </text>
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
  fill: none;
  stroke: var(--border);
  stroke-width: 1.4;
  transition:
    opacity 0.15s,
    stroke 0.15s;
}

.graph-canvas__edge.is-highlighted {
  stroke: var(--accent);
  stroke-width: 2;
}

.graph-canvas__edge.is-dimmed {
  opacity: 0.12;
}

.graph-canvas__node {
  cursor: pointer;
  outline: none;
  transition: opacity 0.15s;
}

.graph-canvas__node.is-dimmed {
  opacity: 0.25;
}

.graph-canvas__node.is-context {
  opacity: 0.55;
}

.graph-canvas__node-base {
  fill: var(--bg-inset);
}

.graph-canvas__node-box {
  fill: var(--bg-subtle);
  stroke: var(--border);
  stroke-width: 1.2;
}

.graph-canvas__node--project .graph-canvas__node-box {
  fill: var(--success-soft);
  stroke: var(--success-border);
}
.graph-canvas__node--session .graph-canvas__node-box {
  fill: var(--accent-soft);
  stroke: var(--accent-border);
}
.graph-canvas__node--knowledge .graph-canvas__node-box {
  fill: var(--done-soft);
  stroke: var(--done-border);
}
.graph-canvas__node--evidence .graph-canvas__node-box {
  fill: var(--attention-soft);
  stroke: var(--attention-border);
}

.graph-canvas__node:hover .graph-canvas__node-box,
.graph-canvas__node:focus-visible .graph-canvas__node-box {
  stroke: var(--fg-muted);
  stroke-width: 1.8;
}

.graph-canvas__node.is-match .graph-canvas__node-box {
  stroke: var(--attention);
  stroke-width: 2;
}

.graph-canvas__node.is-selected .graph-canvas__node-box {
  stroke: var(--accent);
  stroke-width: 2.4;
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

@media (prefers-reduced-motion: reduce) {
  .graph-canvas__edge,
  .graph-canvas__node {
    transition: none;
  }
}
</style>
