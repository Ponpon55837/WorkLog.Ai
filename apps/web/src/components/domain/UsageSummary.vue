<script setup lang="ts">
import { computed } from "vue";
import { storeToRefs } from "pinia";
import UiMeter from "../ui/UiMeter.vue";
import UiSparkline from "../ui/UiSparkline.vue";
import UiStatCard from "../ui/UiStatCard.vue";
import UsageBlockCard from "./UsageBlockCard.vue";
import { useUsageStore } from "../../stores/usage";
import { formatCount, formatPercent, formatTokens } from "../../utils/format";
import { t } from "../../i18n";

const usageStore = useUsageStore();
const { scanResult: result, dailyPoints } = storeToRefs(usageStore);

const hasBlocks = computed(() => (result.value?.blocks.length ?? 0) > 0);
const dailyTotals = computed(() => dailyPoints.value.map((point) => point.input + point.output));
const shareSegments = computed(() => [
  { value: result.value?.totals.workIntelligenceShare ?? 0, tone: "accent" as const, label: t("usage.summaryShare") },
]);
const cacheReadFoot = computed(() => {
  const share = result.value?.tokens.cacheReadShare;
  return t("usage.summaryCacheReadFoot", { share: share == null ? "—" : formatPercent(share) });
});
</script>

<template>
  <div v-if="result" :class="['usage-summary', { 'usage-summary--with-block': hasBlocks }]" data-testid="usage-summary">
    <div class="usage-summary__main" data-testid="usage-summary-main">
      <UiStatCard
        featured
        :label="t('usage.summaryHeadline')"
        :value="formatTokens(result.tokens.primary)"
        :title="formatCount(result.tokens.primary)"
      >
        <UiSparkline
          v-if="dailyTotals.length > 0"
          size="lg"
          :values="dailyTotals"
          :label="t('usage.headlineSparkline')"
        />
        <template #foot>
          {{ t("usage.headlineTurns", { count: formatCount(result.totals.turns) }) }} ·
          {{ t("usage.summaryTurnsFoot", { sessions: formatCount(result.totals.sessions) }) }}
        </template>
      </UiStatCard>

      <div class="usage-summary__secondary">
        <UiStatCard compact :label="t('usage.summaryToolCalls')" :value="formatCount(result.totals.toolCalls)" />
        <UiStatCard
          compact
          :label="t('usage.summaryShare')"
          :value="formatPercent(result.totals.workIntelligenceShare)"
          :foot="
            t('usage.summaryShareFoot', {
              calls: formatCount(result.totals.workIntelligenceCalls),
              total: formatCount(result.totals.toolCalls),
            })
          "
        >
          <UiMeter size="sm" :max="1" :segments="shareSegments" />
        </UiStatCard>
        <UiStatCard
          compact
          :label="t('usage.summaryCacheRead')"
          :value="formatTokens(result.tokens.cacheRead)"
          :title="formatCount(result.tokens.cacheRead)"
          :foot="cacheReadFoot"
        />
        <UiStatCard
          compact
          :label="t('usage.summaryCacheWrite')"
          :value="formatTokens(result.tokens.cacheCreation)"
          :title="formatCount(result.tokens.cacheCreation)"
          :foot="t('usage.summaryCacheWriteFoot')"
        />
      </div>
    </div>
    <UsageBlockCard />
  </div>
</template>

<style scoped>
/* Cards in one row share its height, so the stat cards and the block card end on the same line. */
.usage-summary,
.usage-summary__main {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-4);
  min-width: 0;
}

.usage-summary__main {
  grid-template-rows: auto 1fr;
}

.usage-summary__secondary {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4);
}

@container usage-results (min-width: 720px) {
  .usage-summary--with-block {
    grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
  }

  .usage-summary:not(.usage-summary--with-block) .usage-summary__secondary {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}

@media (max-width: 639px) {
  .usage-summary,
  .usage-summary__main,
  .usage-summary__secondary {
    gap: var(--space-2);
  }
}
</style>
