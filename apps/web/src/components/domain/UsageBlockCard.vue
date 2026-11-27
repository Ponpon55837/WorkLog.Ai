<script setup lang="ts">
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { Timer } from "lucide-vue-next";
import UiBox from "../ui/UiBox.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiMeter from "../ui/UiMeter.vue";
import { useUsageStore } from "../../stores/usage";
import { formatClock, formatCount, formatDurationMs, formatTokens } from "../../utils/format";
import { usageBlockRows } from "../../utils/usage";
import { t } from "../../i18n";

const usageStore = useUsageStore();
const { scanResult } = storeToRefs(usageStore);

const blocks = computed(() => usageBlockRows(scanResult.value?.blocks ?? []));
</script>

<template>
  <UiBox v-if="blocks.length > 0" padded class="usage-block" data-testid="usage-blocks">
    <template #header><UiBoxTitle :icon="Timer" :title="t('usage.blockTitle')" /></template>
    <section v-for="block in blocks" :key="block.agentLabel" class="usage-block__agent">
      <h3 class="usage-block__name">{{ block.agentLabel }}</h3>
      <p class="usage-block__label">{{ t("usage.blockTimeLeft") }}</p>
      <p class="usage-block__value">{{ formatDurationMs(block.remainingMs) }}</p>
      <UiMeter
        :max="1"
        :segments="[{ value: block.progress, tone: 'accent', label: t('usage.blockElapsed') }]"
        :label="t('usage.blockProgress')"
      />
      <p class="usage-block__ends">
        <span>{{ t("usage.blockStartsAt", { time: formatClock(block.startAt) }) }}</span>
        <span>{{ t("usage.blockEndsAt", { time: formatClock(block.endAt) }) }}</span>
      </p>
      <dl class="usage-block__facts">
        <div>
          <dt>{{ t("usage.blockHeadline") }}</dt>
          <dd :title="formatCount(block.primary)">{{ formatTokens(block.primary) }}</dd>
        </div>
        <div>
          <dt>{{ t("usage.blockRate") }}</dt>
          <dd :title="formatCount(block.primaryPerMinute)">{{ formatTokens(block.primaryPerMinute) }}</dd>
        </div>
      </dl>
    </section>
    <p class="usage-block__note">{{ t("usage.blockRateNote") }}</p>
  </UiBox>
</template>

<style scoped>
.usage-block__agent + .usage-block__agent {
  margin-top: var(--space-4);
  padding-top: var(--space-4);
  border-top: 1px solid var(--border-muted);
}

.usage-block__name {
  margin: 0;
  font-size: var(--text-sm);
  font-weight: 600;
}

.usage-block__label {
  margin: var(--space-1) 0 0;
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.usage-block__value {
  margin: 0;
  font-size: var(--text-xl);
  font-weight: 600;
  line-height: 1.25;
  font-variant-numeric: tabular-nums;
}

.usage-block__ends {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 0 var(--space-3);
  margin: var(--space-1) 0 0;
  color: var(--fg-muted);
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
}

.usage-block__facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2) var(--space-4);
  margin: var(--space-3) 0 0;
}

.usage-block__facts dt {
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.usage-block__facts dd {
  margin: 0;
  font-size: var(--text-sm);
  font-variant-numeric: tabular-nums;
}

.usage-block__note {
  margin: var(--space-4) 0 0;
  color: var(--fg-muted);
  font-size: var(--text-xs);
}
</style>
