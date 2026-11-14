<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from "vue";
import { storeToRefs } from "pinia";
import { ArrowRight } from "lucide-vue-next";
import UiBox from "../ui/UiBox.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiButton from "../ui/UiButton.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiSkeleton from "../ui/UiSkeleton.vue";
import { useDashboardStore } from "../../stores/dashboard";
import { t } from "../../i18n";

/**
 * This week's record, settle and correct loop from real counts only: Sessions saved, Knowledge saved and Knowledge
 * pages written, confirmations and contradictions. Knowledge numbers fall back to a dash when their request fails.
 */
const store = useDashboardStore();
const {
  weekReport,
  weekReportLoaded,
  weekReportFailed,
  cycleEvents,
  cycleEventsFailed,
  cycleRevisedPages,
  cyclePagesFailed,
} = storeToRefs(store);

const sessions = computed(() => weekReport.value?.totals.sessions ?? 0);
const knowledgeUnavailable = computed(() => cycleEventsFailed.value || cyclePagesFailed.value);
const headline = computed(() => {
  const created = cycleEvents.value?.created;
  if (created === undefined) return t("dashboard.cycleHeadlineSessions", { sessions: sessions.value });
  return t("dashboard.cycleHeadline", { sessions: sessions.value, created });
});

function count(value: number | null | undefined, failed: boolean): string {
  if (value !== null && value !== undefined) return String(value);
  return failed ? "—" : t("attention.loadingShort");
}

onMounted(() => store.setCycleActive(true));
onBeforeUnmount(() => store.setCycleActive(false));
</script>

<template>
  <UiBox data-testid="dashboard-cycle">
    <template #header>
      <UiBoxTitle :title="t('dashboard.cycleTitle')" />
    </template>
    <UiFlash v-if="weekReportFailed" tone="danger">{{ t("dashboard.cycleFailedToLoad") }}</UiFlash>
    <UiSkeleton v-else-if="!weekReportLoaded" variant="text" :count="2" :label="t('dashboard.cycleLoading')" />
    <div v-else class="cycle">
      <p class="cycle__headline">{{ headline }}</p>
      <div class="cycle__stages">
        <div class="cycle__stage">
          <div class="cycle__label">{{ t("dashboard.cycleRecord") }}</div>
          <div class="cycle__value">
            {{ sessions }}<small>{{ t("dashboard.cycleSessionUnit") }}</small>
          </div>
        </div>
        <ArrowRight class="cycle__arrow" :size="16" :stroke-width="1.75" aria-hidden="true" />
        <div class="cycle__stage cycle__stage--emphasis">
          <div class="cycle__label">{{ t("dashboard.cycleSettle") }}</div>
          <div class="cycle__value">
            {{ count(cycleEvents?.created, cycleEventsFailed) }}<small>{{ t("dashboard.cycleCreatedUnit") }}</small>
          </div>
          <div class="cycle__note">
            {{ t("dashboard.cyclePagesNote", { count: count(cycleRevisedPages, cyclePagesFailed) }) }}
          </div>
        </div>
        <ArrowRight class="cycle__arrow" :size="16" :stroke-width="1.75" aria-hidden="true" />
        <div class="cycle__stage">
          <div class="cycle__label">{{ t("dashboard.cycleCorrect") }}</div>
          <div class="cycle__value">
            {{ count(cycleEvents?.confirmed, cycleEventsFailed) }}<small>{{ t("dashboard.cycleConfirmedUnit") }}</small>
          </div>
          <div class="cycle__note">
            {{ t("dashboard.cycleContradictedNote", { count: count(cycleEvents?.contradicted, cycleEventsFailed) }) }}
          </div>
        </div>
      </div>
      <UiFlash v-if="knowledgeUnavailable" tone="attention" class="cycle__flash">
        {{ t("dashboard.cycleKnowledgeUnavailable") }}
        <template #actions
          ><UiButton size="sm" @click="store.reloadCycle()">{{ t("common.retry") }}</UiButton></template
        >
      </UiFlash>
    </div>
  </UiBox>
</template>

<style scoped>
.cycle {
  display: grid;
  gap: var(--space-4);
  min-width: 0;
  padding: var(--space-4);
}

.cycle__headline {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: 500;
  text-wrap: balance;
  overflow-wrap: anywhere;
}

.cycle__stages {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1.25fr) auto minmax(0, 1fr);
  gap: var(--space-3);
  align-items: stretch;
}

.cycle__stage {
  min-width: 0;
  padding: var(--space-3);
  border-radius: var(--radius);
  background: var(--bg-muted);
}

/* The page's single accent fill: the settling step is where this week's work becomes reusable. */
.cycle__stage--emphasis {
  background: var(--accent-soft);
}

.cycle__label {
  color: var(--fg-muted);
  font-size: var(--text-sm);
}

.cycle__stage--emphasis .cycle__label {
  color: var(--fg);
}

.cycle__value {
  margin-top: var(--space-1);
  font-size: var(--text-2xl);
  font-weight: 600;
  line-height: 1.25;
  font-variant-numeric: tabular-nums;
}

.cycle__value small {
  margin-left: var(--space-1);
  color: var(--fg-muted);
  font-size: var(--text-sm);
  font-weight: 400;
}

.cycle__stage--emphasis .cycle__value small {
  color: var(--fg);
}

.cycle__note {
  margin-top: var(--space-1);
  color: var(--fg-muted);
  font-size: var(--text-sm);
  font-variant-numeric: tabular-nums;
}

.cycle__stage--emphasis .cycle__note {
  color: var(--fg);
}

.cycle__arrow {
  align-self: center;
  color: var(--fg-subtle);
}

@media (max-width: 639px) {
  .cycle__stages {
    grid-template-columns: minmax(0, 1fr);
  }

  .cycle__arrow {
    display: none;
  }
}
</style>
