<script setup lang="ts">
import CommandPalette from "../domain/CommandPalette.vue";
import HandoffImportDialog from "../domain/HandoffImportDialog.vue";
import KnowledgeEditorDialog from "../domain/KnowledgeEditorDialog.vue";
import KnowledgeHistoryPanel from "../domain/KnowledgeHistoryPanel.vue";
import RecordVoidDialog from "../domain/RecordVoidDialog.vue";
import SessionDiagramPanel from "../domain/SessionDiagramPanel.vue";
import SessionLinkDialog from "../domain/SessionLinkDialog.vue";
import SessionPanel from "../domain/SessionPanel.vue";
import SessionSummaryEditorDialog from "../domain/SessionSummaryEditorDialog.vue";
import { locale } from "../../i18n";

/**
 * Every global panel and dialog, loaded as one chunk after the first paint. They teleport to <body> in mount order,
 * which decides how they stack (the diagram reader above the Session panel), so they stay in one component and mount
 * together in this order instead of each arriving with its own chunk.
 */
const paletteOpen = defineModel<boolean>("paletteOpen", { required: true });
</script>

<template>
  <!-- Overlay state lives in stores, so remounting them on a language switch keeps what is open. -->
  <SessionPanel :key="`session-panel:${locale}`" />
  <SessionDiagramPanel :key="`session-diagram:${locale}`" />
  <KnowledgeHistoryPanel :key="`knowledge-history:${locale}`" />
  <KnowledgeEditorDialog :key="`knowledge-editor:${locale}`" />
  <SessionSummaryEditorDialog :key="`session-editor:${locale}`" />
  <RecordVoidDialog :key="`record-void:${locale}`" />
  <SessionLinkDialog :key="`session-link:${locale}`" />
  <HandoffImportDialog :key="`handoff-import:${locale}`" />
  <CommandPalette :key="`palette:${locale}`" v-model:open="paletteOpen" />
</template>
