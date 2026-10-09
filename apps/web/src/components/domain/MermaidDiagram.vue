<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Maximize2, Minus, Plus, RotateCcw } from "lucide-vue-next";
import { storeToRefs } from "pinia";
import UiButton from "../ui/UiButton.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import UiSpinner from "../ui/UiSpinner.vue";
import { usePreferencesStore } from "../../stores/preferences";
import { renderMermaid } from "../../utils/mermaid";
import { t } from "../../i18n";

/**
 * Renders Mermaid source without loosening the page's Content Security Policy: Mermaid is loaded only when a
 * diagram scrolls into view, the SVG goes into a shadow root, and its <style> rules are applied as a
 * constructed stylesheet (CSSOM), which `style-src-elem 'self'` does not block. On failure the source is shown.
 */
const props = defineProps<{ source: string; title: string; interactive?: boolean }>();
const emit = defineEmits<{ expand: [] }>();

const { resolvedTheme } = storeToRefs(usePreferencesStore());

const host = ref<HTMLElement | null>(null);
const state = ref<"idle" | "loading" | "rendered" | "failed">("idle");
const failure = ref("");
let observer: IntersectionObserver | undefined;
let resizeObserver: ResizeObserver | undefined;
let renderVersion = 0;
let svgElement: SVGSVGElement | null = null;
let naturalSize = { width: 1, height: 1 };
let drag: { id: number; x: number; y: number; left: number; top: number } | undefined;
const scale = ref(1);
const isDragging = ref(false);
const autoFit = ref(true);

const zoomLabel = computed(() => t("session.diagramZoom", { percent: Math.round(scale.value * 100) }));

function applyScale(value: number): void {
  scale.value = value;
  if (!svgElement) return;
  svgElement.style.width = `${naturalSize.width * value}px`;
  svgElement.style.height = `${naturalSize.height * value}px`;
  svgElement.style.maxWidth = "none";
}

function fit(): void {
  const element = host.value;
  if (!element || !svgElement || !props.interactive) return;
  autoFit.value = true;
  applyScale(
    Math.min((element.clientWidth - 32) / naturalSize.width, (element.clientHeight - 32) / naturalSize.height, 1),
  );
  element.scrollTo({ left: 0, top: 0 });
}

function zoom(factor: number): void {
  const element = host.value;
  if (!element || !svgElement || state.value !== "rendered") return;
  autoFit.value = false;
  const previous = scale.value;
  const minimum = Math.min(
    0.1,
    (element.clientWidth - 32) / naturalSize.width,
    (element.clientHeight - 32) / naturalSize.height,
  );
  const next = Math.min(4, Math.max(minimum, previous * factor));
  const centerX = element.scrollLeft + element.clientWidth / 2;
  const centerY = element.scrollTop + element.clientHeight / 2;
  applyScale(next);
  element.scrollTo({
    left: centerX * (next / previous) - element.clientWidth / 2,
    top: centerY * (next / previous) - element.clientHeight / 2,
  });
}

function onCanvasKey(event: KeyboardEvent): void {
  if (!props.interactive || state.value !== "rendered" || event.ctrlKey || event.metaKey || event.altKey) return;
  const movement = { ArrowLeft: [-64, 0], ArrowRight: [64, 0], ArrowUp: [0, -64], ArrowDown: [0, 64] }[event.key];
  if (movement) {
    event.preventDefault();
    event.stopPropagation();
    host.value?.scrollBy({ left: movement[0], top: movement[1] });
  } else if (["+", "=", "-", "0"].includes(event.key)) {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "0") fit();
    else zoom(event.key === "-" ? 1 / 1.25 : 1.25);
  }
}

function startDrag(event: PointerEvent): void {
  const element = host.value;
  if (!props.interactive || state.value !== "rendered" || !element || event.button !== 0 || !event.isPrimary) return;
  event.preventDefault();
  element.focus();
  element.setPointerCapture(event.pointerId);
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop };
  isDragging.value = true;
}

function moveDrag(event: PointerEvent): void {
  if (!drag || drag.id !== event.pointerId) return;
  host.value?.scrollTo({ left: drag.left + drag.x - event.clientX, top: drag.top + drag.y - event.clientY });
}

function stopDrag(): void {
  drag = undefined;
  isDragging.value = false;
}

async function render(): Promise<void> {
  const element = host.value;
  if (!element) return;
  const version = ++renderVersion;
  state.value = "loading";
  svgElement = null;
  stopDrag();
  try {
    const { svg, css } = await renderMermaid(props.source);
    // A theme/source change or unmount may finish while Mermaid is still rendering.
    if (version !== renderVersion) return;
    const root = element.shadowRoot ?? element.attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`:host { display: block; } svg { max-width: 100%; height: auto; } ${css}`);
    root.adoptedStyleSheets = [sheet];
    root.innerHTML = svg;
    svgElement = root.querySelector("svg");
    if (props.interactive && svgElement) {
      // Fit the painted content after Shadow DOM CSS is applied, rather than Mermaid's temporary measurement surface.
      const painted = svgElement.getBBox();
      if (painted.width > 0 && painted.height > 0) {
        svgElement.setAttribute(
          "viewBox",
          `${painted.x - 8} ${painted.y - 8} ${painted.width + 16} ${painted.height + 16}`,
        );
      }
      const box = svgElement.viewBox.baseVal;
      naturalSize = {
        width: box.width || svgElement.getBoundingClientRect().width || 1,
        height: box.height || svgElement.getBoundingClientRect().height || 1,
      };
      svgElement.style.margin = "16px auto";
    }
    state.value = "rendered";
    fit();
  } catch (error) {
    if (version !== renderVersion) return;
    failure.value =
      error instanceof Error
        ? (error.message.split("\n")[0] ?? t("session.couldNotDrawThisDiagram"))
        : t("session.couldNotDrawThisDiagram");
    state.value = "failed";
  }
}

watch(
  () => [props.source, resolvedTheme.value],
  () => {
    if (state.value !== "idle") void render();
  },
);

onMounted(() => {
  if (!host.value) return;
  if (props.interactive) {
    resizeObserver = new ResizeObserver(() => {
      if (autoFit.value && state.value === "rendered") fit();
    });
    resizeObserver.observe(host.value);
    void render();
    return;
  }
  if (typeof IntersectionObserver === "undefined") {
    void render();
    return;
  }
  observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) {
      observer?.disconnect();
      void render();
    }
  });
  observer.observe(host.value);
});
onBeforeUnmount(() => {
  renderVersion += 1;
  observer?.disconnect();
  resizeObserver?.disconnect();
});
</script>

<template>
  <figure class="mermaid-diagram" data-testid="session-diagram">
    <figcaption>
      <span>{{ title }}</span>
      <UiButton v-if="!interactive" size="sm" :icon="Maximize2" @click="emit('expand')">{{
        t("session.expandDiagram")
      }}</UiButton>
    </figcaption>
    <div v-if="interactive" class="mermaid-diagram__toolbar" role="group" :aria-label="t('session.diagramControls')">
      <UiIconButton
        :icon="Minus"
        :label="t('session.zoomOut')"
        :disabled="state !== 'rendered'"
        @click="zoom(1 / 1.25)"
      />
      <output>{{ zoomLabel }}</output>
      <UiIconButton
        :icon="Plus"
        :label="t('session.zoomIn')"
        :disabled="state !== 'rendered' || scale >= 4"
        @click="zoom(1.25)"
      />
      <UiButton size="sm" :disabled="state !== 'rendered'" @click="zoom(1 / scale)">{{
        t("session.actualDiagramSize")
      }}</UiButton>
      <UiButton size="sm" :icon="Maximize2" :disabled="state !== 'rendered'" @click="fit">{{
        t("session.fitDiagram")
      }}</UiButton>
    </div>
    <div
      v-show="state !== 'failed'"
      ref="host"
      :class="[
        'mermaid-diagram__canvas',
        { 'mermaid-diagram__canvas--interactive': interactive, 'is-dragging': isDragging },
      ]"
      :role="interactive ? 'region' : 'img'"
      :aria-label="interactive ? t('session.diagramCanvas', { title }) : title"
      :tabindex="interactive ? 0 : undefined"
      @keydown="onCanvasKey"
      @pointerdown="startDrag"
      @pointermove="moveDrag"
      @pointerup="stopDrag"
      @pointercancel="stopDrag"
      @lostpointercapture="stopDrag"
    />
    <p v-if="state === 'loading' || state === 'idle'" class="mermaid-diagram__status">
      <UiSpinner :size="14" :label="t('session.loadingDiagram')" /> {{ t("session.loadingDiagramText") }}
    </p>
    <div v-if="state === 'failed'" class="mermaid-diagram__failure">
      <p>{{ t("session.couldNotDrawThisDiagramHereIsThe", { failure }) }}</p>
      <UiButton size="sm" :icon="RotateCcw" @click="render">{{ t("common.retry") }}</UiButton>
      <pre><code>{{ source }}</code></pre>
    </div>
    <p v-if="interactive && state === 'rendered'" class="mermaid-diagram__status">
      {{ t("session.diagramNavigation") }}
    </p>
    <details v-if="state === 'rendered'" class="mermaid-diagram__source">
      <summary>{{ t("session.viewSource") }}</summary>
      <pre><code>{{ source }}</code></pre>
    </details>
  </figure>
</template>

<style scoped>
.mermaid-diagram {
  display: grid;
  gap: var(--space-2);
  margin: 0;
  min-width: 0;
}

.mermaid-diagram figcaption {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-2);
  overflow-wrap: anywhere;
  font-size: var(--text-sm);
  font-weight: 600;
}

.mermaid-diagram__canvas {
  overflow-x: auto;
  padding: var(--space-3);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius);
  background: var(--bg-inset);
}

.mermaid-diagram__toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.mermaid-diagram__toolbar output {
  min-width: 4em;
  text-align: center;
  font-size: var(--text-sm);
  font-variant-numeric: tabular-nums;
}

.mermaid-diagram__canvas--interactive {
  height: min(62dvh, 640px);
  padding: 0;
  overflow: auto;
  cursor: grab;
  touch-action: none;
  user-select: none;
  overscroll-behavior: contain;
}

.mermaid-diagram__canvas--interactive.is-dragging {
  cursor: grabbing;
}

.mermaid-diagram__status,
.mermaid-diagram__failure p {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  color: var(--fg-muted);
  font-size: var(--text-sm);
}

.mermaid-diagram pre {
  margin: var(--space-1) 0 0;
  padding: var(--space-3);
  overflow-x: auto;
  border-radius: var(--radius);
  background: var(--bg-inset);
  font-size: var(--text-xs);
}

.mermaid-diagram__source summary {
  color: var(--fg-muted);
  font-size: var(--text-xs);
  cursor: pointer;
}
</style>
