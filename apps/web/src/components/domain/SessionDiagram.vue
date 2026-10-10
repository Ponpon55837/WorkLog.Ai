<script setup lang="ts">
import { defineAsyncComponent } from "vue";
import type { SessionDiagramRecord } from "@work-intelligence/core";
import DiagramSource from "./DiagramSource.vue";

/** Dispatch a saved snapshot to the renderer for its validated kind and version. */
withDefaults(defineProps<{ diagram: SessionDiagramRecord; interactive?: boolean; projectRoot?: string }>(), {
  interactive: false,
  projectRoot: "",
});
const emit = defineEmits<{ expand: [] }>();
const ArchitectureDiagram = defineAsyncComponent(() => import("./ArchitectureDiagram.vue"));
</script>

<template>
  <ArchitectureDiagram
    v-if="diagram.kind === 'architecture' && diagram.formatVersion === 1"
    :title="diagram.title"
    :source="diagram.source"
    :interactive="interactive"
    :project-root="projectRoot"
    @expand="emit('expand')"
  />
  <DiagramSource v-else :diagram="diagram" :interactive="interactive" @expand="emit('expand')" />
</template>
