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
        ><UiBoxTitle eyebrow="Risks to review" :title="t('reports.dataRisks')" :count="report.risks.length"
      /></template>
      <UiEmptyState
        v-if="report.risks.length === 0"
        compact
        :icon="TriangleAlert"
        :title="t('reports.noDataRisksDetected')"
      />
      <VirtualList
        v-else
        :items="report.risks"
        :enabled="true"
        fit-viewport
        fit-viewport-to-panel
        :estimate-item-height="112"
        :label="t('reports.reportRisksList')"
      >
        <template #default="{ item: insight }">
          <UiBoxRow
            clickable
            :title="insight.label"
            :meta="t('reports.sourceSessionCount', { length: insight.sourceSessionIds.length })"
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
        ><UiBoxTitle
          eyebrow="Decisions"
          :title="t('reports.decisionsAndClosingEvents')"
          :count="report.decisions.length"
      /></template>
      <UiEmptyState
        v-if="report.decisions.length === 0"
        compact
        :title="t('reports.noDecisionEventsInThis')"
        :description="t('reports.sourcesAreKeptHereOnce')"
      />
      <VirtualList
        v-else
        :items="report.decisions"
        :enabled="true"
        fit-viewport
        fit-viewport-to-panel
        :estimate-item-height="88"
        :label="t('reports.reportDecisionsList')"
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
          :title="t('reports.agentAutonomousDecisionsThisPeriod')"
          :count="report.agentAutonomousDecisions.total"
        />
      </template>
      <UiFlash
        v-if="report.agentAutonomousDecisions.pending > report.agentAutonomousDecisions.pendingItems.length"
        tone="attention"
      >
        {{
          t("reports.showingTheLatestOfAwaiting", {
            length: report.agentAutonomousDecisions.pendingItems.length,
            pending: report.agentAutonomousDecisions.pending,
          })
        }}
      </UiFlash>
      <UiEmptyState
        v-if="report.agentAutonomousDecisions.total === 0"
        compact
        :title="t('reports.noAgentAutonomousDecisionsIn')"
        :description="t('reports.onlyDecisionsWhoseSourceIs')"
      />
      <UiEmptyState
        v-else-if="report.agentAutonomousDecisions.pendingItems.length === 0"
        compact
        :title="t('reports.allAutonomousDecisionsThisPeriod')"
        :description="t('reports.decisions0AwaitingConfirmation', { total: report.agentAutonomousDecisions.total })"
      />
      <VirtualList
        v-else
        :items="report.agentAutonomousDecisions.pendingItems"
        :enabled="true"
        fit-viewport
        fit-viewport-to-panel
        :estimate-item-height="104"
        :label="t('reports.agentAutonomousDecisionsToConfirm')"
      >
        <template #default="{ item: decision }">
          <UiBoxRow clickable :title="decision.text" @select="emit('open-report-session', decision.sessionId)">
            <template #labels
              ><UiLabel tone="attention">{{ t("common.unconfirmed") }}</UiLabel></template
            >
            <template #meta>{{ t("reports.openSourceSession", { sessionTitle: decision.sessionTitle }) }}</template>
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
