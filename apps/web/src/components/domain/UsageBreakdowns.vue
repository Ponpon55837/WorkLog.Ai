<script setup lang="ts">
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { Wrench } from "lucide-vue-next";
import UiBox from "../ui/UiBox.vue";
import UiBoxRow from "../ui/UiBoxRow.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiMeter from "../ui/UiMeter.vue";
import { useUsageStore } from "../../stores/usage";
import { formatCount, formatPercent, formatTokens } from "../../utils/format";
import { USAGE_TOKEN_TONES, usageModelRows, withRatio } from "../../utils/usage";
import { t } from "../../i18n";

/** Models, conversations, Work Intelligence operations and other tools, all visible without interaction. */
const usageStore = useUsageStore();
const { scanResult: result } = storeToRefs(usageStore);

const modelRows = computed(() => usageModelRows(result.value?.models ?? []));
const modelTotal = computed(() => modelRows.value.reduce((sum, model) => sum + model.primary, 0));
const modelItems = computed(() =>
  modelRows.value.map((model) => ({
    ...model,
    shareText: formatPercent(model.share),
    segments: [
      { value: model.tokens.input, tone: USAGE_TOKEN_TONES.input, label: t("usage.tokenInput") },
      { value: model.tokens.output, tone: USAGE_TOKEN_TONES.output, label: t("usage.tokenOutput") },
    ],
  })),
);
const sessionRows = computed(() =>
  withRatio(result.value?.sessions ?? [], (session) => session.primary).map((session) => ({
    ...session,
    breakdown: t("usage.sessionTokenBreakdown", {
      input: formatTokens(session.tokens.input),
      output: formatTokens(session.tokens.output),
      cacheRead: formatTokens(session.tokens.cacheRead),
      cacheWrite: formatTokens(session.tokens.cacheCreation),
    }),
    exactBreakdown: t("usage.sessionTokenBreakdown", {
      input: formatCount(session.tokens.input),
      output: formatCount(session.tokens.output),
      cacheRead: formatCount(session.tokens.cacheRead),
      cacheWrite: formatCount(session.tokens.cacheCreation),
    }),
  })),
);
const operationRows = computed(() => withRatio(result.value?.operations ?? [], (operation) => operation.calls));
const otherToolRows = computed(() => withRatio(result.value?.otherTools ?? [], (tool) => tool.calls));

function ratioBar(ratio: number, label: string): { value: number; tone: "accent"; label: string }[] {
  return [{ value: ratio, tone: "accent", label }];
}
</script>

<template>
  <div class="usage-breakdowns">
    <UiBox data-testid="usage-models">
      <template #header><UiBoxTitle :title="t('usage.modelsTitle')" :count="modelItems.length" /></template>
      <p v-if="modelItems.length === 0" class="usage-breakdowns__hint">{{ t("usage.modelsEmpty") }}</p>
      <table v-else class="usage-breakdowns__table">
        <thead>
          <tr>
            <th scope="col">{{ t("usage.modelColumn") }}</th>
            <th scope="col" class="is-numeric is-bar">{{ t("usage.modelHeadline") }}</th>
            <th scope="col" class="is-numeric">{{ t("usage.modelShare") }}</th>
            <th scope="col" class="is-numeric">{{ t("usage.tokenInput") }}</th>
            <th scope="col" class="is-numeric">{{ t("usage.tokenOutput") }}</th>
            <th scope="col" class="is-numeric">{{ t("usage.tokenCacheRead") }}</th>
            <th scope="col" class="is-numeric">{{ t("usage.tokenCacheCreation") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="model in modelItems" :key="model.key">
            <th scope="row">
              <span class="usage-breakdowns__name" :title="model.modelLabel">{{ model.modelLabel }}</span>
              <span class="usage-breakdowns__sub"
                >{{ model.agentLabel }} · {{ t("usage.modelResponses", { count: model.responses }) }}</span
              >
            </th>
            <td class="is-numeric is-bar" :data-label="t('usage.modelHeadline')">
              <span :title="formatCount(model.primary)">{{ formatTokens(model.primary) }}</span>
              <UiMeter size="sm" class="usage-breakdowns__bar" :max="modelTotal" :segments="model.segments" />
            </td>
            <td class="is-numeric" :data-label="t('usage.modelShare')">{{ model.shareText }}</td>
            <td class="is-numeric" :data-label="t('usage.tokenInput')" :title="formatCount(model.tokens.input)">
              {{ formatTokens(model.tokens.input) }}
            </td>
            <td class="is-numeric" :data-label="t('usage.tokenOutput')" :title="formatCount(model.tokens.output)">
              {{ formatTokens(model.tokens.output) }}
            </td>
            <td class="is-numeric" :data-label="t('usage.tokenCacheRead')" :title="formatCount(model.tokens.cacheRead)">
              {{ formatTokens(model.tokens.cacheRead) }}
            </td>
            <td
              class="is-numeric"
              :data-label="t('usage.tokenCacheCreation')"
              :title="formatCount(model.tokens.cacheCreation)"
            >
              {{ formatTokens(model.tokens.cacheCreation) }}
            </td>
          </tr>
        </tbody>
      </table>
    </UiBox>

    <UiBox data-testid="usage-sessions">
      <template #header><UiBoxTitle :title="t('usage.sessionsTitle')" :count="sessionRows.length" /></template>
      <p v-if="sessionRows.length === 0" class="usage-breakdowns__hint">{{ t("usage.sessionsEmpty") }}</p>
      <table v-else class="usage-breakdowns__table">
        <thead>
          <tr>
            <th scope="col">{{ t("usage.sessionColumn") }}</th>
            <th scope="col" class="is-numeric is-bar">{{ t("usage.modelHeadline") }}</th>
            <th scope="col" class="is-numeric">{{ t("usage.summaryTurns") }}</th>
            <th scope="col" class="is-numeric">{{ t("usage.summaryToolCalls") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="session in sessionRows" :key="session.label">
            <th scope="row">
              <span class="usage-breakdowns__name">{{ session.label }}</span>
              <span class="usage-breakdowns__sub is-wrap" :title="session.exactBreakdown">{{ session.breakdown }}</span>
            </th>
            <td class="is-numeric is-bar" :data-label="t('usage.modelHeadline')">
              <span :title="formatCount(session.primary)">{{ formatTokens(session.primary) }}</span>
              <UiMeter
                size="sm"
                class="usage-breakdowns__bar"
                :max="1"
                :segments="ratioBar(session.ratio, session.label)"
              />
            </td>
            <td class="is-numeric" :data-label="t('usage.summaryTurns')">{{ formatCount(session.turns) }}</td>
            <td class="is-numeric" :data-label="t('usage.summaryToolCalls')">
              {{ formatCount(session.toolCalls) }}
            </td>
          </tr>
        </tbody>
      </table>
    </UiBox>

    <UiBox data-testid="usage-operations">
      <template #header
        ><UiBoxTitle :icon="Wrench" :title="t('usage.operations')" :count="operationRows.length"
      /></template>
      <p v-if="operationRows.length === 0" class="usage-breakdowns__hint">{{ t("usage.operationsEmpty") }}</p>
      <table v-else class="usage-breakdowns__table">
        <thead>
          <tr>
            <th scope="col">{{ t("usage.operationKey") }}</th>
            <th scope="col" class="is-numeric is-bar">{{ t("usage.operationCalls") }}</th>
            <th scope="col" class="is-numeric">{{ t("usage.operationsTotalChars") }}</th>
            <th scope="col" class="is-numeric">{{ t("usage.operationsAvgChars") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="operation in operationRows" :key="operation.key">
            <th scope="row">
              <code class="usage-breakdowns__name" :title="operation.key">{{ operation.key }}</code>
            </th>
            <td class="is-numeric is-bar" :data-label="t('usage.operationCalls')">
              <span>{{ formatCount(operation.calls) }}</span>
              <UiMeter
                size="sm"
                class="usage-breakdowns__bar"
                :max="1"
                :segments="ratioBar(operation.ratio, operation.key)"
              />
            </td>
            <td class="is-numeric" :data-label="t('usage.operationsTotalChars')">
              {{ formatCount(operation.resultChars) }}
            </td>
            <td class="is-numeric" :data-label="t('usage.operationsAvgChars')">
              {{ formatCount(operation.avgChars) }}
            </td>
          </tr>
        </tbody>
      </table>
    </UiBox>

    <UiBox data-testid="usage-other-tools">
      <template #header><UiBoxTitle :title="t('usage.otherTools')" :count="otherToolRows.length" /></template>
      <p v-if="otherToolRows.length === 0" class="usage-breakdowns__hint">{{ t("usage.otherToolsEmpty") }}</p>
      <div v-else class="usage-breakdowns__tools">
        <UiBoxRow v-for="tool in otherToolRows" :key="tool.name">
          <template #title
            ><code>{{ tool.name }}</code></template
          >
          <UiMeter size="sm" :max="1" :segments="ratioBar(tool.ratio, tool.name)" />
          <template #trailing
            ><span class="usage-breakdowns__muted">{{ t("usage.calls", { count: tool.calls }) }}</span></template
          >
        </UiBoxRow>
      </div>
    </UiBox>
  </div>
</template>

<style scoped>
.usage-breakdowns {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}

.usage-breakdowns__tools {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  column-gap: var(--space-4);
}

@container usage-results (min-width: 720px) {
  .usage-breakdowns__tools {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.usage-breakdowns__hint {
  margin: 0;
  padding: var(--space-2) var(--space-4);
  color: var(--fg-muted);
  font-size: var(--text-sm);
}

.usage-breakdowns__muted {
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.usage-breakdowns__table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
}

.usage-breakdowns__table th,
.usage-breakdowns__table td {
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border-muted);
  text-align: left;
  vertical-align: top;
}

.usage-breakdowns__table thead th,
.usage-breakdowns__table td {
  white-space: nowrap;
}

.usage-breakdowns__table th:first-child,
.usage-breakdowns__table td:first-child {
  padding-left: var(--space-4);
}

.usage-breakdowns__table th:last-child,
.usage-breakdowns__table td:last-child {
  padding-right: var(--space-4);
}

.usage-breakdowns__table tbody tr:last-child > * {
  border-bottom: 0;
}

.usage-breakdowns__table thead th {
  color: var(--fg-muted);
  font-size: var(--text-xs);
  font-weight: 600;
}

.usage-breakdowns__table tbody th {
  min-width: 0;
  font-weight: 400;
}

.usage-breakdowns__table .is-numeric {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.usage-breakdowns__table .is-bar {
  min-width: 96px;
}

.usage-breakdowns__table .usage-breakdowns__bar {
  margin-top: var(--space-1);
}

.usage-breakdowns__name {
  display: block;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.usage-breakdowns__sub {
  display: block;
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.usage-breakdowns__sub.is-wrap {
  max-width: 220px;
  white-space: normal;
}

/* A narrow results column turns each row into a card instead of scrolling the table sideways. */
@container usage-results (max-width: 719px) {
  .usage-breakdowns__table thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }

  .usage-breakdowns__table,
  .usage-breakdowns__table tbody,
  .usage-breakdowns__table tr,
  .usage-breakdowns__table th {
    display: block;
  }

  /* Contains the visually hidden header; otherwise its absolute position escapes <main> and scrolls the whole document. */
  .usage-breakdowns__table {
    position: relative;
  }

  .usage-breakdowns__table tr {
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border-muted);
  }

  .usage-breakdowns__table tbody tr:last-child {
    border-bottom: 0;
  }

  .usage-breakdowns__table th,
  .usage-breakdowns__table td,
  .usage-breakdowns__table th:first-child,
  .usage-breakdowns__table td:first-child,
  .usage-breakdowns__table th:last-child,
  .usage-breakdowns__table td:last-child {
    padding: 0;
    border: 0;
  }

  .usage-breakdowns__table tbody th {
    margin-bottom: var(--space-1);
    font-weight: 600;
  }

  .usage-breakdowns__name,
  .usage-breakdowns__sub.is-wrap {
    max-width: none;
  }

  .usage-breakdowns__table td {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0 var(--space-3);
    padding: 2px 0;
  }

  .usage-breakdowns__table td::before {
    content: attr(data-label);
    text-align: left;
    color: var(--fg-muted);
  }

  .usage-breakdowns__table .is-bar {
    min-width: 0;
  }

  .usage-breakdowns__table .usage-breakdowns__bar {
    grid-column: 1 / -1;
  }
}
</style>
