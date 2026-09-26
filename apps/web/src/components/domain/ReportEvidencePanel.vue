<script setup lang="ts">
import { Link } from "lucide-vue-next";
import type { ReportEvidence, WorkReport } from "@work-intelligence/core";
import type { ListPageSize } from "../../utils/labels";
import UiActionMenu from "../ui/UiActionMenu.vue";
import UiBox from "../ui/UiBox.vue";
import UiBoxRow from "../ui/UiBoxRow.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiEmptyState from "../ui/UiEmptyState.vue";
import UiLabel from "../ui/UiLabel.vue";
import UiPagination from "../ui/UiPagination.vue";
import UiSkeleton from "../ui/UiSkeleton.vue";
import VirtualList from "../VirtualList.vue";
import { evidenceKindLabels } from "../../utils/labels";

const { report, loading } = defineProps<{
  report: WorkReport;
  loading: boolean;
}>();
const evidenceKindItems = [
  { value: "" as const, label: "所有類型" },
  ...(Object.keys(evidenceKindLabels) as ReportEvidence["kind"][]).map((evidenceKind) => ({
    value: evidenceKind,
    label: evidenceKindLabels[evidenceKind],
  })),
];
const evidenceLetters: Record<ReportEvidence["kind"], string> = {
  handoff: "H",
  verification: "V",
  "changed-files": "F",
  event: "E",
  attached: "A",
};
const pageSize = defineModel<ListPageSize>("pageSize", { required: true });
const kind = defineModel<ReportEvidence["kind"] | "">("kind", { required: true });
const emit = defineEmits<{
  page: [page: number];
  open: [evidence: ReportEvidence];
}>();
</script>

<template>
  <section id="report-panel-evidence" class="reports__panel" role="tabpanel" aria-labelledby="report-tab-evidence">
    <UiBox sticky-header>
      <template #header>
        <UiBoxTitle eyebrow="Source evidence" title="來源證據" :count="report.evidencePageInfo.total" />
        <UiActionMenu
          v-model="kind"
          label="類型"
          header="篩選 Evidence 類型"
          default-value=""
          align="end"
          :items="evidenceKindItems"
        />
      </template>
      <UiSkeleton v-if="loading && report.evidence.length === 0" />
      <UiEmptyState
        v-else-if="report.evidence.length === 0"
        compact
        :icon="Link"
        title="尚無可呈現的證據"
        description="Session 提供 handoff、verification、changed files 或 event 後，報告就能建立追溯線索。"
      />
      <VirtualList
        v-else
        :items="report.evidence"
        :enabled="true"
        fit-viewport
        fit-viewport-to-panel
        fill-available-space
        :estimate-item-height="72"
        label="報告來源證據清單"
      >
        <template #default="{ item }">
          <UiBoxRow clickable :title="item.label" @select="emit('open', item)">
            <template #leading
              ><span class="reports__evidence-kind" aria-hidden="true">{{
                evidenceLetters[item.kind as ReportEvidence["kind"]]
              }}</span></template
            >
            <template #labels
              ><UiLabel>{{ evidenceKindLabels[item.kind as ReportEvidence["kind"]] }}</UiLabel></template
            >
            <template #meta
              >{{ item.sessionTitle }}<template v-if="item.projectName"> · {{ item.projectName }}</template
              ><template v-if="item.reference"> · {{ item.reference }}</template></template
            >
            <p class="reports__row-detail">{{ item.detail }}</p>
          </UiBoxRow>
        </template>
      </VirtualList>
      <template #footer>
        <UiPagination
          v-model:page-size="pageSize"
          :page-info="report.evidencePageInfo"
          size-label="報告來源證據每頁筆數"
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

.reports__row-detail {
  margin-top: var(--space-1);
  color: var(--fg-muted);
  font-size: var(--text-sm);
}

.reports__evidence-kind {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--fg-muted);
  font: 700 11px var(--font-mono);
}
</style>
