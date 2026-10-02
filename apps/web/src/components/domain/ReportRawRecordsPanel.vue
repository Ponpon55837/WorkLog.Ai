<script setup lang="ts">
import { FileText } from "lucide-vue-next";
import type { PageInfo, WorkSessionRecord } from "@work-intelligence/core";
import type { ListPageSize } from "../../utils/labels";
import SessionRow from "./SessionRow.vue";
import UiBox from "../ui/UiBox.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiEmptyState from "../ui/UiEmptyState.vue";
import UiPagination from "../ui/UiPagination.vue";
import UiSkeleton from "../ui/UiSkeleton.vue";
import VirtualList from "../VirtualList.vue";
import { t } from "../../i18n";

const { items, loading, pageInfo } = defineProps<{
  items: WorkSessionRecord[];
  loading: boolean;
  pageInfo: PageInfo;
}>();
const emit = defineEmits<{
  page: [page: number];
  open: [session: WorkSessionRecord, list: readonly WorkSessionRecord[]];
}>();
const pageSize = defineModel<ListPageSize>("pageSize", { required: true });
function openSession(session: WorkSessionRecord): void {
  emit("open", session, items);
}
</script>

<template>
  <section id="report-panel-raw" class="reports__panel" role="tabpanel" aria-labelledby="report-tab-raw">
    <UiBox sticky-header>
      <template #header
        ><UiBoxTitle eyebrow="Raw work records" :title="t('common.rawWorkRecords')" :count="pageInfo.total"
      /></template>
      <UiSkeleton v-if="loading && items.length === 0" />
      <UiEmptyState v-else-if="items.length === 0" compact :icon="FileText" :title="t('reports.noRawSessionsInThis')" />
      <VirtualList
        v-else
        :items="items"
        :enabled="true"
        fit-viewport
        fit-viewport-to-panel
        fill-available-space
        :label="t('reports.rawReportRecordsList')"
      >
        <template #default="{ item }">
          <SessionRow :session="item" @open="openSession" />
        </template>
      </VirtualList>
      <template #footer>
        <UiPagination
          v-model:page-size="pageSize"
          :page-info="pageInfo"
          :size-label="t('reports.rawReportRecordsPerPage')"
          @page="emit('page', $event)"
        />
      </template>
    </UiBox>
  </section>
</template>

<style scoped>
.reports__panel {
  display: grid;
  gap: var(--space-4);
}
</style>
