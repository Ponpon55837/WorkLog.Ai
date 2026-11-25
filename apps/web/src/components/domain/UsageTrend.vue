<script setup lang="ts">
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { TrendingUp } from "lucide-vue-next";
import UiBox from "../ui/UiBox.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiStackedBarChart from "../ui/UiStackedBarChart.vue";
import { useMediaQuery } from "../../composables/useMediaQuery";
import { useUsageStore } from "../../stores/usage";
import { formatCount, formatTokens } from "../../utils/format";
import { USAGE_TOKEN_TONES, usageDayLabel } from "../../utils/usage";
import { t } from "../../i18n";

/** Daily input and output tokens on one scale; the exact values stay in a folded table for keyboard and screen readers. */
const compact = useMediaQuery("(max-width: 639px)");
const usageStore = useUsageStore();
const { scanResult: result, dailyPoints } = storeToRefs(usageStore);

const labels = computed(() => dailyPoints.value.map((point) => usageDayLabel(point.date)));
const series = computed(() => [
  { name: t("usage.tokenInput"), tone: USAGE_TOKEN_TONES.input, values: dailyPoints.value.map((point) => point.input) },
  {
    name: t("usage.tokenOutput"),
    tone: USAGE_TOKEN_TONES.output,
    values: dailyPoints.value.map((point) => point.output),
  },
]);
const hasDailyUsage = computed(() => (result.value?.daily.length ?? 0) > 0);
</script>

<template>
  <UiBox data-testid="usage-trend">
    <template #header><UiBoxTitle :icon="TrendingUp" :title="t('usage.trendTitle')" /></template>
    <UiStackedBarChart
      v-if="hasDailyUsage"
      fold-table
      :labels="labels"
      :series="series"
      :label="t('usage.trendLabel')"
      :format-value="formatTokens"
      :format-exact="formatCount"
      :compact="compact"
    />
    <p v-else class="usage-trend__empty">{{ t("usage.trendEmpty") }}</p>
  </UiBox>
</template>

<style scoped>
.usage-trend__empty {
  margin: 0;
  padding: var(--space-2) var(--space-4);
  color: var(--fg-muted);
  font-size: var(--text-sm);
}
</style>
