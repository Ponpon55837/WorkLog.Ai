<script setup lang="ts">
import { TriangleAlert } from "lucide-vue-next";
import type { WorkReport } from "@work-intelligence/core";
import UiBox from "../ui/UiBox.vue";
import UiBoxRow from "../ui/UiBoxRow.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiEmptyState from "../ui/UiEmptyState.vue";
import UiLabel from "../ui/UiLabel.vue";
import UiFlash from "../ui/UiFlash.vue";
import VirtualList from "../VirtualList.vue";
import { formatDate, formatRelative } from "../../utils/format";
import { insightKindLabels } from "../../utils/labels";
import { t } from "../../i18n";

const { report } = defineProps<{ report: WorkReport }>();
const emit = defineEmits<{
  "open-report-session": [sessionId: string | undefined];
}>();
</script>

<template>
  <section
    id="report-panel-risks"
    class="reports__panel reports__grid"
    role="tabpanel"
    aria-labelledby="report-tab-risks"
  >
    <UiBox sticky-header>
      <template #header
        ><UiBoxTitle eyebrow="Risks to review" :title="t('資料型風險')" :count="report.risks.length"
      /></template>
      <UiEmptyState v-if="report.risks.length === 0" compact :icon="TriangleAlert" :title="t('沒有偵測到資料型風險')" />
      <VirtualList
        v-else
        :items="report.risks"
        :enabled="true"
        fit-viewport
        fit-viewport-to-panel
        :estimate-item-height="112"
        :label="t('報表風險清單')"
      >
        <template #default="{ item: insight }">
          <UiBoxRow
            clickable
            :title="insight.label"
            :meta="t('{length} 筆來源 Session', { length: insight.sourceSessionIds.length })"
            @select="emit('open-report-session', insight.sourceSessionIds[0])"
          >
            <template #labels
              ><UiLabel tone="attention">{{ insightKindLabels[insight.kind] }}</UiLabel></template
            >
            <p class="reports__row-detail">{{ insight.detail }}</p>
          </UiBoxRow>
        </template>
      </VirtualList>
    </UiBox>
    <UiBox sticky-header>
      <template #header
        ><UiBoxTitle eyebrow="Decisions" :title="t('決策與 closing 事件')" :count="report.decisions.length"
      /></template>
      <UiEmptyState
        v-if="report.decisions.length === 0"
        compact
        :title="t('這段期間沒有決策事件')"
        :description="t('Agent 提交 note 或 closing event 後，會在這裡保留來源。')"
      />
      <VirtualList
        v-else
        :items="report.decisions"
        :enabled="true"
        fit-viewport
        fit-viewport-to-panel
        :estimate-item-height="88"
        :label="t('報表決策清單')"
      >
        <template #default="{ item: decision }">
          <UiBoxRow clickable :title="decision.summary" @select="emit('open-report-session', decision.sessionId)">
            <template #meta
              >{{ decision.sessionTitle }} ·
              <time :title="formatDate(decision.occurredAt)">{{ formatRelative(decision.occurredAt) }}</time></template
            >
          </UiBoxRow>
        </template>
      </VirtualList>
    </UiBox>
    <UiBox sticky-header data-testid="report-agent-autonomous-decisions">
      <template #header>
        <UiBoxTitle
          eyebrow="Agent-autonomous decisions"
          :title="t('本期 Agent 自主決策')"
          :count="report.agentAutonomousDecisions.total"
        />
      </template>
      <UiFlash
        v-if="report.agentAutonomousDecisions.pending > report.agentAutonomousDecisions.pendingItems.length"
        tone="attention"
      >
        {{
          t("顯示最新 {length} 筆，共 {pending} 筆待確認。", {
            length: report.agentAutonomousDecisions.pendingItems.length,
            pending: report.agentAutonomousDecisions.pending,
          })
        }}
      </UiFlash>
      <UiEmptyState
        v-if="report.agentAutonomousDecisions.total === 0"
        compact
        :title="t('這段期間沒有 Agent 自主決策')"
        :description="t('只有明確標記來源為 Agent 自主選擇的決策會列在這裡。')"
      />
      <UiEmptyState
        v-else-if="report.agentAutonomousDecisions.pendingItems.length === 0"
        compact
        :title="t('本期自主決策都已處理')"
        :description="t('{total} 筆決策，待確認 0 筆。', { total: report.agentAutonomousDecisions.total })"
      />
      <VirtualList
        v-else
        :items="report.agentAutonomousDecisions.pendingItems"
        :enabled="true"
        fit-viewport
        fit-viewport-to-panel
        :estimate-item-height="104"
        :label="t('本期待確認 Agent 自主決策清單')"
      >
        <template #default="{ item: decision }">
          <UiBoxRow clickable :title="decision.text" @select="emit('open-report-session', decision.sessionId)">
            <template #labels
              ><UiLabel tone="attention">{{ t("待確認") }}</UiLabel></template
            >
            <template #meta>{{
              t("{sessionTitle} · 開啟來源 Session", { sessionTitle: decision.sessionTitle })
            }}</template>
          </UiBoxRow>
        </template>
      </VirtualList>
    </UiBox>
  </section>
</template>

<style scoped>
.reports__panel {
  display: grid;
  gap: var(--space-4);
  grid-template-columns: minmax(0, 1fr) minmax(280px, 380px);
  align-items: start;
}

.reports__panel > .ui-box + .ui-box {
  margin-top: 0;
}

.reports__row-detail {
  margin-top: var(--space-1);
  color: var(--fg-muted);
  font-size: var(--text-sm);
}

@media (max-width: 959px) {
  .reports__panel {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
