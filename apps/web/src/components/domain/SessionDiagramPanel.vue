<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import { ArrowLeft } from "lucide-vue-next";
import { storeToRefs } from "pinia";
import SessionDiagram from "./SessionDiagram.vue";
import UiButton from "../ui/UiButton.vue";
import UiSidePanel from "../ui/UiSidePanel.vue";
import UiSidePanelHeader from "../ui/UiSidePanelHeader.vue";
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
      <UiSidePanelHeader :title="selectedDetail?.session.title ?? ''" :close-label="t('common.close')" @close="close">
        <template #leading>
          <UiButton size="sm" :icon="ArrowLeft" @click="close">{{ t("session.backToSession") }}</UiButton>
        </template>
      </UiSidePanelHeader>
    </template>
    <SessionDiagram
      v-if="diagram"
      :key="diagram.id"
      :diagram="diagram"
      :project-root="selectedDetail?.project.status === 'tracked' ? selectedDetail.project.rootPath : undefined"
      interactive
    />
  </UiSidePanel>
</template>
