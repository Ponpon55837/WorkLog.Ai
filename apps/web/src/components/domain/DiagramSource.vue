<script setup lang="ts">
import { computed } from "vue";
import { Copy, Download, Maximize2 } from "lucide-vue-next";
import type { SessionDiagramRecord } from "@work-intelligence/core";
import UiButton from "../ui/UiButton.vue";
import { useToast } from "../../composables/useToast";
import { downloadText } from "../../utils/download";
import { t } from "../../i18n";

/** Reads historical or unsupported snapshots as escaped, selectable text without executing them. */
const props = withDefaults(defineProps<{ diagram: SessionDiagramRecord; interactive?: boolean }>(), {
  interactive: false,
});
const emit = defineEmits<{ expand: [] }>();
const { copyWithToast } = useToast();
const legacy = computed(() => props.diagram.kind === "mermaid");

function expand(event: MouseEvent): void {
  if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus();
  emit("expand");
}

async function copySource(): Promise<void> {
  await copyWithToast(props.diagram.source, t("session.diagramSourceCopied"));
}

function downloadSource(): void {
  downloadText(
    props.diagram.source,
    `diagram-${props.diagram.id}.${legacy.value ? "mmd" : "txt"}`,
    "text/plain; charset=utf-8",
  );
}
</script>

<template>
  <figure class="diagram-source" data-testid="session-diagram">
    <figcaption>
      <strong>{{ diagram.title }}</strong>
      <UiButton v-if="!interactive" size="sm" :icon="Maximize2" @click="expand">{{
        t("session.expandDiagram")
      }}</UiButton>
    </figcaption>
    <p>{{ legacy ? t("session.legacyMermaidSource") : t("session.structuredDiagramSource") }}</p>
    <div class="diagram-source__actions">
      <UiButton size="sm" :icon="Copy" @click="copySource">{{ t("session.copyDiagramSource") }}</UiButton>
      <UiButton size="sm" :icon="Download" @click="downloadSource">{{ t("session.downloadDiagramSource") }}</UiButton>
    </div>
    <details :open="interactive">
      <summary>{{ t("session.viewSource") }}</summary>
      <pre
        tabindex="0"
        :aria-label="t('session.diagramSource', { title: diagram.title })"
      ><code>{{ diagram.source }}</code></pre>
    </details>
  </figure>
</template>

<style scoped>
.diagram-source {
  display: grid;
  gap: var(--space-2);
  margin: 0;
  min-width: 0;
}
.diagram-source figcaption {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-2);
  overflow-wrap: anywhere;
}
.diagram-source__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.diagram-source p,
.diagram-source summary {
  color: var(--fg-muted);
  font-size: var(--text-sm);
}
.diagram-source details {
  min-width: 0;
}
.diagram-source pre {
  max-height: 60vh;
  overflow: auto;
  padding: var(--space-3);
  background: var(--bg-inset);
  border-radius: var(--radius);
  font-size: var(--text-xs);
}
.diagram-source pre:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
