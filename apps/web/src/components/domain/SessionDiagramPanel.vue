<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import { ArrowLeft, X } from "lucide-vue-next";
import { storeToRefs } from "pinia";
import MermaidDiagram from "./MermaidDiagram.vue";
import UiButton from "../ui/UiButton.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import UiSidePanel from "../ui/UiSidePanel.vue";
import { router } from "../../router";
import { useSessionsStore } from "../../stores/sessions";
import { t } from "../../i18n";

/** Reads an existing Session diagram in a wider, addressable panel without changing saved data. */
const route = useRoute();
const { selectedDetail } = storeToRefs(useSessionsStore());

const diagram = computed(() => {
  const detail = selectedDetail.value;
  if (!detail || detail.session.id !== route.query.session) return undefined;
  return detail.diagrams.find((item) => item.id === route.query.diagram && !item.voided);
});

function close(): void {
  const query = { ...route.query };
  delete query.diagram;
  void router.replace({ query });
}
</script>

<template>
  <UiSidePanel
    :open="Boolean(diagram)"
    :label="t('session.diagramReader')"
    :width="1200"
    storage-key="diagram-reader"
    @close="close"
  >
    <template #header>
      <div class="session-diagram-panel__header">
        <UiButton size="sm" :icon="ArrowLeft" @click="close">{{ t("session.backToSession") }}</UiButton>
        <span>{{ selectedDetail?.session.title }}</span>
        <UiIconButton :icon="X" :label="t('common.close')" @click="close" />
      </div>
    </template>
    <MermaidDiagram v-if="diagram" :key="diagram.id" :title="diagram.title" :source="diagram.source" interactive />
  </UiSidePanel>
</template>

<style scoped>
.session-diagram-panel__header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.session-diagram-panel__header span {
  flex: 1;
  min-width: 0;
  color: var(--fg-muted);
  font-size: var(--text-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
