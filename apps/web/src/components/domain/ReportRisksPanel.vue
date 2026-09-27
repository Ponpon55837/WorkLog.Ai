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
        ><UiBoxTitle eyebrow="Risks to review" title="資料型風險" :count="report.risks.length"
      /></template>
      <UiEmptyState v-if="report.risks.length === 0" compact :icon="TriangleAlert" title="沒有偵測到資料型風險" />
      <VirtualList
        v-else
        :items="report.risks"
        :enabled="true"
        fit-viewport
        fit-viewport-to-panel
        :estimate-item-height="112"
        label="報表風險清單"
      >
        <template #default="{ item: insight }">
          <UiBoxRow
            clickable
            :title="insight.label"
            :meta="`${insight.sourceSessionIds.length} 筆來源 Session`"
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
        ><UiBoxTitle eyebrow="Decisions" title="決策與 closing 事件" :count="report.decisions.length"
      /></template>
      <UiEmptyState
        v-if="report.decisions.length === 0"
        compact
        title="這段期間沒有決策事件"
        description="Agent 提交 note 或 closing event 後，會在這裡保留來源。"
      />
      <VirtualList
        v-else
        :items="report.decisions"
        :enabled="true"
        fit-viewport
        fit-viewport-to-panel
        :estimate-item-height="88"
        label="報表決策清單"
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
          title="本期 Agent 自主決策"
          :count="report.agentAutonomousDecisions.total"
        />
      </template>
      <UiFlash
        v-if="report.agentAutonomousDecisions.pending > report.agentAutonomousDecisions.pendingItems.length"
        tone="attention"
      >
        顯示最新 {{ report.agentAutonomousDecisions.pendingItems.length }} 筆，共
        {{ report.agentAutonomousDecisions.pending }} 筆待確認。
      </UiFlash>
      <UiEmptyState
        v-if="report.agentAutonomousDecisions.total === 0"
        compact
        title="這段期間沒有 Agent 自主決策"
        description="只有明確標記來源為 Agent 自主選擇的決策會列在這裡。"
      />
      <UiEmptyState
        v-else-if="report.agentAutonomousDecisions.pendingItems.length === 0"
        compact
        title="本期自主決策都已處理"
        :description="`${report.agentAutonomousDecisions.total} 筆決策，待確認 0 筆。`"
      />
      <VirtualList
        v-else
        :items="report.agentAutonomousDecisions.pendingItems"
        :enabled="true"
        fit-viewport
        fit-viewport-to-panel
        :estimate-item-height="104"
        label="本期待確認 Agent 自主決策清單"
      >
        <template #default="{ item: decision }">
          <UiBoxRow clickable :title="decision.text" @select="emit('open-report-session', decision.sessionId)">
            <template #labels><UiLabel tone="attention">待確認</UiLabel></template>
            <template #meta>{{ decision.sessionTitle }} · 開啟來源 Session</template>
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
