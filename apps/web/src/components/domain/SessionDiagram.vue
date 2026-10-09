<script setup lang="ts">
import { Maximize2 } from "lucide-vue-next";
import type { SessionDiagramRecord } from "@work-intelligence/core";
import MermaidDiagram from "./MermaidDiagram.vue";
import UiButton from "../ui/UiButton.vue";
import { t } from "../../i18n";

withDefaults(defineProps<{ diagram: SessionDiagramRecord; interactive?: boolean }>(), { interactive: false });
const emit = defineEmits<{ expand: [] }>();

function expand(event: MouseEvent): void {
  if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus();
  emit("expand");
}
</script>

<template>
  <MermaidDiagram
    v-if="diagram.kind === 'mermaid' && (diagram.formatVersion ?? 1) === 1"
    :title="diagram.title"
    :source="diagram.source"
    :interactive="interactive"
    @expand="emit('expand')"
  />
  <figure v-else class="session-diagram-source" data-testid="session-diagram">
    <figcaption>
      <strong>{{ diagram.title }}</strong
      ><UiButton v-if="!interactive" size="sm" :icon="Maximize2" @click="expand">{{
        t("session.expandDiagram")
      }}</UiButton>
    </figcaption>
    <p>{{ t("session.structuredDiagramSource") }}</p>
    <details :open="interactive">
      <summary>{{ t("session.viewSource") }}</summary>
      <pre><code>{{ diagram.source }}</code></pre>
    </details>
  </figure>
</template>

<style scoped>
.session-diagram-source {
  display: grid;
  gap: var(--space-2);
  margin: 0;
  min-width: 0;
}
.session-diagram-source figcaption {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-2);
  overflow-wrap: anywhere;
}
.session-diagram-source p,
.session-diagram-source summary {
  color: var(--fg-muted);
  font-size: var(--text-sm);
}
.session-diagram-source pre {
  overflow: auto;
  padding: var(--space-3);
  background: var(--bg-inset);
  border-radius: var(--radius);
  font-size: var(--text-xs);
}
</style>
