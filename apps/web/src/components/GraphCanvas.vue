<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, computed } from "vue";
import type { GraphEdge, GraphNode } from "@work-intelligence/core";

type GraphVisualNode = {
  node: GraphNode;
  x: number;
  y: number;
};

type GraphVisualEdge = {
  edge: GraphEdge;
  from: GraphVisualNode;
  to: GraphVisualNode;
};

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
}>();

const emit = defineEmits<{
  select: [node: GraphNode];
}>();

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

function graphNodeClipId(value: string): string {
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

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
});
</script>

<template>
  <div ref="viewport" class="graph-viewport" data-testid="graph-viewport" role="img" aria-label="Work Intelligence 結構化工作關係圖" @scroll="handleScroll">
    <div class="graph-lane-header" data-testid="graph-lane-header" aria-hidden="true">
      <span v-for="kind in nodeKindOrder" :key="kind">{{ nodeKindLabels[kind] }}</span>
    </div>
    <svg class="graph-svg" :viewBox="`0 0 ${width} ${height}`" preserveAspectRatio="xMinYMin meet">
      <defs>
        <marker id="graph-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="strokeWidth">
          <path d="M0,0 L7,3.5 L0,7 z" fill="#6d92b3"></path>
        </marker>
        <clipPath
          v-for="item in renderedNodes"
          :id="graphNodeClipId(item.node.id)"
          :key="graphNodeClipId(item.node.id)"
          clipPathUnits="userSpaceOnUse"
        >
          <rect x="-80" y="-17" width="160" height="34" rx="3"></rect>
        </clipPath>
      </defs>
      <line
        v-for="item in renderedEdges"
        :key="item.edge.id"
        class="graph-edge"
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
        :class="['graph-svg-node', `graph-svg-node-${item.node.kind}`, { clickable: true }]"
        :transform="`translate(${item.x}, ${item.y})`"
        role="button"
        tabindex="0"
        :aria-label="`查看${nodeKindLabels[item.node.kind]}：${item.node.label}`"
        @click="emit('select', item.node)"
        @keydown.enter="emit('select', item.node)"
        @keydown.space.prevent="emit('select', item.node)"
      >
        <title>{{ item.node.label }} · {{ nodeKindLabels[item.node.kind] }}</title>
        <rect x="-92" y="-20" width="184" height="40" rx="10"></rect>
        <text class="graph-node-label" x="-78" y="-3" :clip-path="`url(#${graphNodeClipId(item.node.id)})`">{{ nodeLabel(item.node.label) }}</text>
        <text class="graph-node-meta" x="-78" y="12" :clip-path="`url(#${graphNodeClipId(item.node.id)})`">{{ nodeDescription(item.node) }}</text>
      </g>
    </svg>
  </div>
</template>
