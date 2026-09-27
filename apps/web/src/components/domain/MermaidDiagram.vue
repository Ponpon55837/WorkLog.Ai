<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { renderMermaid } from "../../utils/mermaid";
import UiSpinner from "../ui/UiSpinner.vue";

/**
 * Renders Mermaid source without loosening the page's Content Security Policy: Mermaid is loaded only when a
 * diagram scrolls into view, the SVG goes into a shadow root, and its <style> rules are applied as a
 * constructed stylesheet (CSSOM), which `style-src-elem 'self'` does not block. On failure the source is shown.
 */
const props = defineProps<{ source: string; title: string }>();

const host = ref<HTMLElement | null>(null);
const state = ref<"idle" | "loading" | "rendered" | "failed">("idle");
const failure = ref("");
let observer: IntersectionObserver | undefined;

async function render(): Promise<void> {
  const element = host.value;
  if (!element) return;
  state.value = "loading";
  try {
    const { svg, css } = await renderMermaid(props.source);
    const root = element.shadowRoot ?? element.attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`:host { display: block; } svg { max-width: 100%; height: auto; } ${css}`);
    root.adoptedStyleSheets = [sheet];
    root.innerHTML = svg;
    state.value = "rendered";
  } catch (error) {
    failure.value = error instanceof Error ? error.message.split("\n")[0]! : "無法繪製這張圖表。";
    state.value = "failed";
  }
}

watch(
  () => props.source,
  () => {
    if (state.value !== "idle") void render();
  },
);

onMounted(() => {
  if (!host.value) return;
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
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <figure class="mermaid-diagram" data-testid="session-diagram">
    <figcaption>{{ title }}</figcaption>
    <div v-show="state !== 'failed'" ref="host" class="mermaid-diagram__canvas" role="img" :aria-label="title" />
    <p v-if="state === 'loading' || state === 'idle'" class="mermaid-diagram__status">
      <UiSpinner :size="14" label="載入圖表" /> 載入圖表…
    </p>
    <div v-if="state === 'failed'" class="mermaid-diagram__failure">
      <p>無法繪製這張圖表（{{ failure }}），以下是原始碼：</p>
      <pre><code>{{ source }}</code></pre>
    </div>
    <details v-else-if="state === 'rendered'" class="mermaid-diagram__source">
      <summary>檢視原始碼</summary>
      <pre><code>{{ source }}</code></pre>
    </details>
  </figure>
</template>

<style scoped>
.mermaid-diagram {
  display: grid;
  gap: var(--space-2);
  margin: 0;
}

.mermaid-diagram figcaption {
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
