<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from "vue";
import { ArrowRight, FileCode2, Layers, Maximize2, Minus, Plus, Route, X } from "lucide-vue-next";
import { storeToRefs } from "pinia";
import { parseArchitectureDiagram } from "@work-intelligence/schema/architecture-diagram";
import UiButton from "../ui/UiButton.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import UiSelect from "../ui/UiSelect.vue";
import { usePreferencesStore } from "../../stores/preferences";
import { layoutArchitecture } from "../../utils/architecture-diagram";
import { editorFileUrl } from "../../utils/code-links";
import { t } from "../../i18n";

/** Read a validated architecture snapshot as grouped cards and authored connections. */
const props = withDefaults(
  defineProps<{ title: string; source: string; interactive?: boolean; projectRoot?: string }>(),
  { interactive: false, projectRoot: "" },
);
const emit = defineEmits<{ expand: [] }>();

const { editor } = storeToRefs(usePreferencesStore());
const markerId = `architecture-${useId().replace(/:/g, "")}`;
const host = ref<HTMLElement | null>(null);
const groupId = ref("");
const selectedId = ref("");
const inspectorOpen = ref(true);
const focusId = ref("");
const pathId = ref("");
const scale = ref(1);
const autoFit = ref(true);
const dragging = ref(false);
let observer: ResizeObserver | undefined;
let drag: { id: number; x: number; y: number; left: number; top: number } | undefined;

const diagram = computed(() => parseArchitectureDiagram(props.source));
const layout = computed(() =>
  diagram.value ? layoutArchitecture(diagram.value, groupId.value, focusId.value) : undefined,
);
const groupLabels = computed(() => new Map(diagram.value?.groups.map((group) => [group.id, group.label]) ?? []));
const groupEntries = computed(
  () =>
    diagram.value?.groups.map((group) => ({
      ...group,
      count: diagram.value!.nodes.filter((node) => node.groupId === group.id).length,
    })) ?? [],
);
const selected = computed(() => diagram.value?.nodes.find((node) => node.id === selectedId.value));
const selectedConnections = computed(() => {
  if (!diagram.value || !selected.value) return [];
  const labels = new Map(diagram.value.nodes.map((node) => [node.id, node.label]));
  return diagram.value.edges
    .filter((edge) => edge.from === selected.value!.id || edge.to === selected.value!.id)
    .map((edge) => ({ ...edge, fromLabel: labels.get(edge.from), toLabel: labels.get(edge.to) }));
});
const path = computed(() => diagram.value?.paths.find((item) => item.id === pathId.value));
const pathEdges = computed(() => new Set(path.value?.edgeIds ?? []));
const pathNodes = computed(() => {
  if (!path.value || !diagram.value) return [];
  const edges = new Map(diagram.value.edges.map((edge) => [edge.id, edge]));
  const ids = [edges.get(path.value.edgeIds[0]!)!.from, ...path.value.edgeIds.map((id) => edges.get(id)!.to)];
  const nodes = new Map(diagram.value.nodes.map((node) => [node.id, node]));
  return ids.map((id) => nodes.get(id)!);
});
const onPath = computed(() => new Set(pathNodes.value.map((node) => node.id)));
const neighbors = computed(() => {
  if (!diagram.value || !selected.value) return [];
  const ids = new Set<string>();
  for (const edge of diagram.value.edges) {
    if (edge.from === selected.value.id) ids.add(edge.to);
    if (edge.to === selected.value.id) ids.add(edge.from);
  }
  return diagram.value.nodes.filter((node) => ids.has(node.id));
});
const groupOptions = computed(() => [
  { value: "", label: t("session.architectureOverview") },
  ...(diagram.value?.groups.map((group) => ({ value: group.id, label: group.label })) ?? []),
]);
const pathOptions = computed(() => [
  { value: "", label: t("session.noAuthoredPath") },
  ...(diagram.value?.paths.map((item) => ({ value: item.id, label: item.label })) ?? []),
]);
const sourceLink = computed(() =>
  selected.value?.source && props.projectRoot
    ? editorFileUrl(editor.value, props.projectRoot, selected.value.source.path)
    : undefined,
);
const zoomLabel = computed(() => t("session.diagramZoom", { percent: Math.round(scale.value * 100) }));

function expand(event: MouseEvent): void {
  if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus();
  emit("expand");
}

function fit(): void {
  const element = host.value;
  if (!element || !layout.value) return;
  autoFit.value = true;
  scale.value = Math.max(
    0.01,
    Math.min((element.clientWidth - 24) / layout.value.width, (element.clientHeight - 24) / layout.value.height, 1),
  );
  element.scrollTo({ left: 0, top: 0 });
}

async function zoom(factor: number): Promise<void> {
  const element = host.value;
  if (!element || !layout.value) return;
  autoFit.value = false;
  const previous = scale.value;
  const x = element.scrollLeft + element.clientWidth / 2;
  const y = element.scrollTop + element.clientHeight / 2;
  scale.value = Math.max(0.01, Math.min(4, previous * factor));
  await nextTick();
  element.scrollTo({
    left: (x * scale.value) / previous - element.clientWidth / 2,
    top: (y * scale.value) / previous - element.clientHeight / 2,
  });
}

function selectNode(id: string): void {
  selectedId.value = id;
  inspectorOpen.value = true;
  if (!layout.value?.nodes.some((item) => item.node.id === id)) {
    groupId.value = "";
    focusId.value = "";
  }
}

function focusNeighbors(): void {
  groupId.value = "";
  pathId.value = "";
  focusId.value = selectedId.value;
}

function overview(): void {
  groupId.value = "";
  focusId.value = "";
  pathId.value = "";
}

function startDrag(event: PointerEvent): void {
  const element = host.value;
  if (
    !props.interactive ||
    !element ||
    event.button !== 0 ||
    !event.isPrimary ||
    (event.target instanceof Element && event.target.closest("button, a"))
  )
    return;
  event.preventDefault();
  element.focus();
  element.setPointerCapture(event.pointerId);
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop };
  dragging.value = true;
}
function moveDrag(event: PointerEvent): void {
  if (!drag || drag.id !== event.pointerId) return;
  host.value?.scrollTo({ left: drag.left + drag.x - event.clientX, top: drag.top + drag.y - event.clientY });
}
function stopDrag(): void {
  drag = undefined;
  dragging.value = false;
}
function onCanvasKey(event: KeyboardEvent): void {
  if (!props.interactive || event.target !== host.value || event.ctrlKey || event.metaKey || event.altKey) return;
  const movement = { ArrowLeft: [-64, 0], ArrowRight: [64, 0], ArrowUp: [0, -64], ArrowDown: [0, 64] }[event.key];
  if (movement) {
    event.preventDefault();
    event.stopPropagation();
    host.value?.scrollBy({ left: movement[0], top: movement[1] });
  } else if (["+", "=", "-", "0"].includes(event.key)) {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "0") fit();
    else void zoom(event.key === "-" ? 1 / 1.25 : 1.25);
  }
}

watch(
  () => props.source,
  () => {
    overview();
    selectedId.value = "";
  },
  { immediate: true },
);
watch(groupId, (id) => {
  if (id) {
    focusId.value = "";
    pathId.value = "";
  }
});
watch(pathId, (id) => {
  if (id) {
    groupId.value = "";
    focusId.value = "";
  }
});
watch(layout, async () => {
  await nextTick();
  fit();
});
onMounted(() => {
  if (!host.value) return;
  observer = new ResizeObserver(() => {
    if (autoFit.value) fit();
  });
  observer.observe(host.value);
  fit();
});
onBeforeUnmount(() => {
  observer?.disconnect();
  stopDrag();
});
</script>

<template>
  <figure class="architecture" data-testid="session-diagram">
    <figcaption>
      <strong>{{ title }}</strong
      ><UiButton v-if="!interactive" size="sm" :icon="Maximize2" @click="expand">{{
        t("session.expandDiagram")
      }}</UiButton>
    </figcaption>
    <template v-if="diagram && layout">
      <div v-if="interactive" class="architecture__toolbar">
        <UiSelect
          v-model="groupId"
          :options="groupOptions"
          :label="t('session.architectureGroups')"
          :icon="Layers"
          size="sm"
        />
        <UiSelect
          v-if="diagram.paths.length"
          v-model="pathId"
          :options="pathOptions"
          :label="t('session.authoredPath')"
          :icon="Route"
          size="sm"
        />
        <UiButton v-if="!inspectorOpen" size="sm" @click="inspectorOpen = true">{{
          t("session.architectureNodeDetails")
        }}</UiButton>
        <UiButton v-if="focusId" size="sm" @click="overview">{{ t("session.architectureOverview") }}</UiButton>
        <div class="architecture__zoom" role="group" :aria-label="t('session.diagramControls')">
          <UiIconButton :icon="Minus" :label="t('session.zoomOut')" @click="zoom(1 / 1.25)" /><output>{{
            zoomLabel
          }}</output
          ><UiIconButton
            :icon="Plus"
            :label="t('session.zoomIn')"
            :disabled="scale >= 4"
            @click="zoom(1.25)"
          /><UiButton size="sm" @click="zoom(1 / scale)">{{ t("session.actualDiagramSize") }}</UiButton
          ><UiButton size="sm" :icon="Maximize2" @click="fit">{{ t("session.fitDiagram") }}</UiButton>
        </div>
      </div>
      <div :class="['architecture__workspace', { 'architecture__workspace--interactive': interactive }]">
        <nav
          v-if="interactive && diagram.groups.length"
          class="architecture__groups"
          :aria-label="t('session.architectureGroups')"
        >
          <h3>{{ t("session.architectureGroups") }}</h3>
          <button type="button" :aria-pressed="!groupId && !focusId" @click="overview">
            {{ t("session.architectureOverview") }}<span>{{ diagram.nodes.length }}</span>
          </button>
          <button
            v-for="group in groupEntries"
            :key="group.id"
            type="button"
            :aria-pressed="groupId === group.id"
            @click="groupId = group.id"
          >
            {{ group.label }}<span>{{ group.count }}</span>
          </button>
        </nav>
        <div class="architecture__center">
          <div class="architecture__scope">
            {{ t("session.architectureNodeCount", { visible: layout.nodes.length, total: diagram.nodes.length }) }}
          </div>
          <div
            ref="host"
            :class="['architecture__canvas', { 'is-interactive': interactive, 'is-dragging': dragging }]"
            :role="interactive ? 'region' : 'img'"
            :aria-label="interactive ? t('session.diagramCanvas', { title }) : title"
            :tabindex="interactive ? 0 : undefined"
            @keydown="onCanvasKey"
            @pointerdown="startDrag"
            @pointermove="moveDrag"
            @pointerup="stopDrag"
            @pointercancel="stopDrag"
            @lostpointercapture="stopDrag"
          >
            <div
              class="architecture__surface"
              :style="{ width: `${layout.width * scale}px`, height: `${layout.height * scale}px` }"
            >
              <div
                class="architecture__graph"
                :style="{ width: `${layout.width}px`, height: `${layout.height}px`, transform: `scale(${scale})` }"
              >
                <svg class="architecture__edges" :width="layout.width" :height="layout.height" aria-hidden="true">
                  <defs>
                    <marker
                      :id="markerId"
                      viewBox="0 0 10 10"
                      refX="9"
                      refY="5"
                      markerWidth="6"
                      markerHeight="6"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 0 L 10 5 L 0 10 z" />
                    </marker>
                  </defs>
                  <g v-for="group in layout.groups" :key="group.id" class="architecture__boundary">
                    <rect :x="group.x" :y="group.y" :width="group.width" :height="group.height" rx="6" />
                    <text :x="group.x + 12" :y="group.y + 22">{{ group.label }}</text>
                  </g>
                  <path
                    v-for="edge in layout.edges"
                    :key="edge.id"
                    :d="edge.d"
                    :class="['architecture__edge', { 'is-on-path': pathEdges.has(edge.id) }]"
                    :marker-end="`url(#${markerId})`"
                  >
                    <title>{{ edge.label }}</title>
                  </path>
                </svg>
                <button
                  v-for="item in layout.nodes"
                  :key="item.node.id"
                  type="button"
                  :class="['architecture__node', { 'is-on-path': onPath.has(item.node.id) }]"
                  :style="{ left: `${item.x}px`, top: `${item.y}px` }"
                  :aria-pressed="selectedId === item.node.id"
                  :aria-label="t('session.inspectArchitectureNode', { label: item.node.label })"
                  :tabindex="interactive ? 0 : -1"
                  :title="item.node.label"
                  @click="interactive ? selectNode(item.node.id) : expand($event)"
                >
                  <strong>{{ item.node.label }}</strong
                  ><span>{{ item.node.description || groupLabels.get(item.node.groupId ?? "") }}</span
                  ><small v-if="item.node.source"
                    ><FileCode2 :size="12" aria-hidden="true" />{{ item.node.source.path.split("/").pop() }}</small
                  >
                </button>
              </div>
            </div>
          </div>
          <p v-if="interactive" class="architecture__hint">{{ t("session.diagramNavigation") }}</p>
          <div v-if="interactive && path" class="architecture__path" :aria-label="t('session.authoredPath')">
            <strong>{{ path.label }}</strong
            ><span>{{ t("session.authoredPathNote") }}</span>
            <ol>
              <li v-for="(node, index) in pathNodes" :key="`${node.id}-${index}`">
                <button type="button" @click="selectNode(node.id)">{{ node.label }}</button
                ><ArrowRight v-if="index < pathNodes.length - 1" :size="14" aria-hidden="true" />
              </li>
            </ol>
          </div>
        </div>
        <aside
          v-if="interactive && inspectorOpen"
          class="architecture__inspector"
          :aria-label="t('session.architectureNodeDetails')"
        >
          <header>
            <h3>{{ t("session.architectureNodeDetails") }}</h3>
            <UiIconButton
              :icon="X"
              :label="t('session.closeArchitectureInspector')"
              size="sm"
              @click="inspectorOpen = false"
            />
          </header>
          <template v-if="selected"
            ><h4>{{ selected.label }}</h4>
            <p v-if="selected.description">{{ selected.description }}</p>
            <p v-if="selected.groupId">{{ groupLabels.get(selected.groupId) }}</p>
            <div v-if="selected.source" class="architecture__source">
              <h4>{{ t("session.architectureSource") }}</h4>
              <a v-if="sourceLink" :href="sourceLink" rel="noopener noreferrer">{{ selected.source.path }}</a
              ><code v-else>{{ selected.source.path }}</code
              ><span v-if="selected.source.line">{{
                t("session.architectureSourceLine", { line: selected.source.line })
              }}</span>
            </div>
            <UiButton size="sm" :icon="Layers" @click="focusNeighbors">{{
              t("session.architectureLocalView")
            }}</UiButton>
            <h4>{{ t("session.architectureRelations") }}</h4>
            <ul v-if="neighbors.length">
              <li v-for="node in neighbors" :key="node.id">
                <button type="button" @click="selectNode(node.id)">{{ node.label }}</button>
              </li>
            </ul>
            <p v-else>{{ t("session.architectureNoRelations") }}</p>
            <ul class="architecture__connections">
              <li v-for="edge in selectedConnections" :key="edge.id">
                {{ edge.fromLabel }} → {{ edge.toLabel }}<span v-if="edge.label"> · {{ edge.label }}</span>
              </li>
            </ul></template
          >
          <p v-else>{{ t("session.selectArchitectureNode") }}</p>
        </aside>
      </div>
    </template>
    <p v-else class="architecture__hint">{{ t("session.unsupportedArchitectureDiagram") }}</p>
    <details class="architecture__raw" :open="!diagram">
      <summary>{{ t("session.viewSource") }}</summary>
      <pre><code>{{ source }}</code></pre>
    </details>
  </figure>
</template>

<style scoped>
.architecture {
  container-type: inline-size;
  display: grid;
  gap: var(--space-3);
  margin: 0;
  min-width: 0;
}
.architecture figcaption {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  overflow-wrap: anywhere;
}
.architecture__toolbar,
.architecture__zoom {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.architecture__zoom {
  margin-left: auto;
}
.architecture__zoom output {
  min-width: 4em;
  text-align: center;
  font-size: var(--text-sm);
}
.architecture__workspace {
  display: grid;
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: clip;
  background: var(--bg-canvas);
}
.architecture__workspace--interactive {
  grid-template-columns: minmax(0, 1fr);
}
.architecture__workspace--interactive:has(.architecture__inspector) {
  grid-template-columns: minmax(0, 1fr) 240px;
}
.architecture__workspace--interactive:has(.architecture__groups) {
  grid-template-columns: 160px minmax(0, 1fr);
}
.architecture__workspace--interactive:has(.architecture__groups):has(.architecture__inspector) {
  grid-template-columns: 160px minmax(0, 1fr) 240px;
}
.architecture__center {
  min-width: 0;
}
.architecture__scope {
  padding: var(--space-3);
  border-bottom: 1px solid var(--border-muted);
  color: var(--fg-muted);
  font-size: var(--text-xs);
}
.architecture__groups {
  padding: var(--space-3);
  border-right: 1px solid var(--border);
  background: var(--bg-subtle);
}
.architecture__groups h3,
.architecture__inspector h3 {
  margin: 0 0 var(--space-3);
  font-size: var(--text-sm);
}
.architecture__groups button {
  display: flex;
  justify-content: space-between;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2);
  margin-bottom: var(--space-1);
  text-align: left;
  font: inherit;
  color: var(--fg-muted);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius);
  overflow-wrap: anywhere;
  cursor: pointer;
}
.architecture__groups button[aria-pressed="true"] {
  color: var(--fg);
  background: var(--bg-muted);
  border-color: var(--border);
}
.architecture__groups button:hover,
.architecture__inspector li button:hover,
.architecture__path button:hover {
  color: var(--accent);
}
.architecture__canvas {
  height: 280px;
  overflow: auto;
  background: var(--bg-inset);
  padding: var(--space-3);
}
.architecture__canvas.is-interactive {
  height: min(55dvh, 600px);
  cursor: grab;
  touch-action: none;
  overscroll-behavior: contain;
  user-select: none;
}
.architecture__canvas.is-dragging {
  cursor: grabbing;
}
.architecture__surface {
  position: relative;
  min-width: 0;
}
.architecture__graph {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: top left;
}
.architecture__edges {
  position: absolute;
  inset: 0;
}
.architecture__edges marker path {
  fill: var(--fg-muted);
}
.architecture__boundary rect {
  fill: var(--bg-subtle);
  stroke: var(--border);
  stroke-dasharray: 4 4;
}
.architecture__boundary text {
  fill: var(--fg-muted);
  font-size: 12px;
  font-weight: 600;
}
.architecture__edge {
  fill: none;
  stroke: var(--fg-muted);
  stroke-width: 1.5;
}
.architecture__edge.is-on-path {
  stroke: var(--accent);
  stroke-width: 3;
}
.architecture__node {
  position: absolute;
  width: 200px;
  height: 86px;
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  text-align: left;
  font: inherit;
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-canvas);
  cursor: pointer;
}
.architecture__node strong,
.architecture__node span,
.architecture__node small {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  max-width: 100%;
}
.architecture__node strong {
  font-size: var(--text-sm);
  font-weight: 600;
}
.architecture__node span,
.architecture__node small {
  color: var(--fg-muted);
  font-size: var(--text-xs);
}
.architecture__node small {
  display: flex;
  gap: var(--space-1);
  align-items: center;
}
.architecture__node:hover {
  border-color: var(--accent);
}
.architecture__node[aria-pressed="true"],
.architecture__node.is-on-path {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, var(--bg-canvas));
}
.architecture__node[aria-pressed="true"] {
  outline: 1px solid var(--accent);
}
.architecture__hint {
  margin: 0;
  padding: var(--space-3);
  color: var(--fg-muted);
  font-size: var(--text-xs);
}
.architecture__inspector {
  border-left: 1px solid var(--border);
  padding: var(--space-4);
  min-width: 0;
  overflow-wrap: anywhere;
}
.architecture__inspector header {
  display: flex;
  justify-content: space-between;
  align-items: start;
  gap: var(--space-2);
}
.architecture__inspector h4 {
  margin: var(--space-4) 0 var(--space-2);
  font-size: var(--text-sm);
}
.architecture__inspector p {
  color: var(--fg-muted);
  font-size: var(--text-sm);
}
.architecture__inspector ul {
  list-style: none;
  padding: 0;
  font-size: var(--text-xs);
}
.architecture__inspector li {
  padding: var(--space-1) 0;
}
.architecture__inspector li button,
.architecture__path button {
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--accent);
  font: inherit;
  text-align: left;
  cursor: pointer;
  overflow-wrap: anywhere;
}
.architecture__source {
  display: grid;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
  font-size: var(--text-xs);
}
.architecture__connections {
  color: var(--fg-muted);
}
.architecture__path {
  padding: var(--space-3);
  border-top: 1px solid var(--border);
  display: grid;
  gap: var(--space-2);
  font-size: var(--text-xs);
}
.architecture__path > span {
  color: var(--fg-muted);
}
.architecture__path ol {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  list-style: none;
  padding: 0;
  margin: 0;
}
.architecture__path li {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}
.architecture__raw {
  min-width: 0;
}
.architecture__raw summary {
  color: var(--fg-muted);
  font-size: var(--text-xs);
  cursor: pointer;
}
.architecture__raw pre {
  margin: var(--space-2) 0 0;
  padding: var(--space-3);
  overflow: auto;
  border-radius: var(--radius);
  background: var(--bg-inset);
  font-size: var(--text-xs);
}
.architecture button:focus-visible,
.architecture__canvas:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
@container (max-width: 960px) {
  .architecture__workspace--interactive,
  .architecture__workspace--interactive:has(.architecture__groups),
  .architecture__workspace--interactive:has(.architecture__inspector),
  .architecture__workspace--interactive:has(.architecture__groups):has(.architecture__inspector) {
    grid-template-columns: minmax(0, 1fr);
  }
  .architecture__groups {
    display: none;
  }
  .architecture__inspector {
    border-left: 0;
    border-top: 1px solid var(--border);
  }
  .architecture__zoom {
    margin-left: 0;
  }
}
</style>
