<script setup lang="ts">
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { Layers } from "lucide-vue-next";
import UiBox from "../ui/UiBox.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiMeter from "../ui/UiMeter.vue";
import { useUsageStore } from "../../stores/usage";
import { formatCount, formatMultiple, formatPercent, formatTokens } from "../../utils/format";
import { USAGE_TOKEN_TONES, usageComposition } from "../../utils/usage";
import { t, type MessageKey } from "../../i18n";

const TOKEN_KIND_KEYS = {
  input: "usage.tokenInput",
  output: "usage.tokenOutput",
  cacheRead: "usage.tokenCacheRead",
  cacheCreation: "usage.tokenCacheCreation",
} as const satisfies Record<keyof typeof USAGE_TOKEN_TONES, MessageKey>;

const usageStore = useUsageStore();
const { scanResult: result } = storeToRefs(usageStore);

const composition = computed(() => (result.value ? usageComposition(result.value.tokens) : undefined));
const rows = computed(() => {
  const value = composition.value;
  if (!value) return [];
  const source = [
    {
      id: "counted",
      title: t("usage.compositionCounted"),
      label: t("usage.compositionCountedLabel"),
      row: value.counted,
    },
    { id: "cache", title: t("usage.compositionCache"), label: t("usage.compositionCacheLabel"), row: value.cache },
  ];
  return source.map(({ id, title, label, row }) => ({
    id,
    title,
    label,
    total: formatTokens(row.total),
    exactTotal: formatCount(row.total),
    segments: row.parts.map((part) => ({
      value: part.value,
      tone: USAGE_TOKEN_TONES[part.kind],
      label: t(TOKEN_KIND_KEYS[part.kind]),
    })),
    parts: row.parts.map((part) => ({
      kind: part.kind,
      tone: USAGE_TOKEN_TONES[part.kind],
      label: t(TOKEN_KIND_KEYS[part.kind]),
      tokens: formatTokens(part.value),
      exact: formatCount(part.value),
      share: formatPercent(part.share),
    })),
  }));
});
const cacheMultiple = computed(() =>
  composition.value?.cacheReadMultiple == null
    ? ""
    : t("usage.cacheReadMultiple", { multiple: formatMultiple(composition.value.cacheReadMultiple) }),
);
</script>

<template>
  <UiBox padded data-testid="usage-composition">
    <template #header><UiBoxTitle :icon="Layers" :title="t('usage.compositionTitle')" /></template>
    <template v-for="(row, index) in rows" :key="row.id">
      <p v-if="index === 1 && cacheMultiple" class="usage-composition__multiple">{{ cacheMultiple }}</p>
      <section class="usage-composition__row">
        <h3 class="usage-composition__title">
          {{ row.title }}<span class="usage-composition__total" :title="row.exactTotal">{{ row.total }}</span>
        </h3>
        <UiMeter gap :segments="row.segments" :label="row.label" />
        <table class="usage-composition__legend">
          <thead class="sr-only">
            <tr>
              <th scope="col">{{ t("usage.compositionKind") }}</th>
              <th scope="col">{{ t("usage.compositionTokens") }}</th>
              <th scope="col">{{ t("usage.compositionShare") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="part in row.parts" :key="part.kind">
              <th scope="row">
                <span
                  :class="['usage-composition__swatch', `usage-composition__swatch--${part.tone}`]"
                  aria-hidden="true"
                ></span
                >{{ part.label }}
              </th>
              <td :title="part.exact">{{ part.tokens }}</td>
              <td>{{ part.share }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>
    <p class="usage-composition__note">{{ t("usage.reasoningNote") }}</p>
  </UiBox>
</template>

<style scoped>
.usage-composition__title {
  display: flex;
  gap: var(--space-2);
  align-items: baseline;
  justify-content: space-between;
  margin: 0;
  font-size: var(--text-sm);
  font-weight: 600;
}

.usage-composition__total {
  color: var(--fg-muted);
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}

.usage-composition__multiple {
  margin: var(--space-3) 0;
  padding: var(--space-2) 0;
  border-block: 1px solid var(--border-muted);
  color: var(--fg-muted);
  font-size: var(--text-sm);
}

.usage-composition__note {
  margin: var(--space-4) 0 0;
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

/* Contains the sr-only header so it cannot reach past <main> and scroll the whole document. */
.usage-composition__legend {
  position: relative;
  width: 100%;
  margin-top: var(--space-2);
  border-collapse: collapse;
  font-size: var(--text-sm);
}

.usage-composition__legend th,
.usage-composition__legend td {
  padding: var(--space-1) 0;
  font-weight: 400;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.usage-composition__legend th[scope="row"] {
  text-align: left;
}

.usage-composition__legend td:last-child {
  width: 56px;
  color: var(--fg-muted);
}

.usage-composition__swatch {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: var(--space-2);
  border-radius: var(--radius-xs);
}

.usage-composition__swatch--accent {
  background: var(--accent);
}

.usage-composition__swatch--done {
  background: var(--done);
}

.usage-composition__swatch--diagram-5 {
  background: var(--diagram-tone-5);
}

.usage-composition__swatch--diagram-6 {
  background: var(--diagram-tone-6);
}
</style>
