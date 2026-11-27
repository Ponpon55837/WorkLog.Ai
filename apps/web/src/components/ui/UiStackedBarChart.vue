<script setup lang="ts">
import { computed } from "vue";
import type { ChartTone } from "./types";
import { t } from "../../i18n";

/** Columns are not tab stops: the value table below the plot is the keyboard path. */
const props = defineProps<{
  labels: readonly string[];
  series: readonly { name: string; tone: ChartTone; values: readonly number[] }[];
  label: string;
  formatValue: (value: number) => string;
  formatExact?: (value: number) => string;
  labelEvery?: number;
  compact?: boolean;
  foldTable?: boolean;
}>();

const folded = computed(() => props.compact || props.foldTable);
const totals = computed(() =>
  props.labels.map((_, index) => props.series.reduce((sum, item) => sum + (item.values[index] ?? 0), 0)),
);
const scaleMax = computed(() => niceCeiling(Math.max(0, ...totals.value)));
const every = computed(() => props.labelEvery ?? Math.max(1, Math.ceil(props.labels.length / 8)));
const ticks = computed(() => [scaleMax.value, scaleMax.value / 2, 0]);
const columns = computed(() =>
  props.labels.map((point, index) => {
    const parts = props.series.map((item) => ({ name: item.name, tone: item.tone, value: item.values[index] ?? 0 }));
    const lastVisible = parts.reduce((found, part, position) => (part.value > 0 ? position : found), -1);
    const firstVisible = parts.findIndex((part) => part.value > 0);
    return {
      point,
      total: totals.value[index] ?? 0,
      title: `${point} · ${parts.map((part) => `${part.name} ${props.formatValue(part.value)}`).join(" · ")}`,
      segments: parts.map((part, position) => ({
        ...part,
        height: part.value > 0 && scaleMax.value > 0 ? `${(part.value / scaleMax.value) * 100}%` : "0",
        isTop: position === lastVisible,
        hasGap: part.value > 0 && position !== firstVisible,
      })),
    };
  }),
);

/** The smallest 1 / 2 / 2.5 / 5 / 10 step at or above the value, so the axis maximum is a clean number. */
function niceCeiling(value: number): number {
  if (value <= 0) return 0;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate * magnitude >= value) ?? 10;
  return step * magnitude;
}

/** Every n-th label plus the last one, skipping an n-th label that would crowd the last. */
function showLabel(index: number): boolean {
  const last = props.labels.length - 1;
  return index === last || (index % every.value === 0 && last - index >= Math.ceil(every.value / 2));
}

function exact(value: number): string {
  return props.formatExact ? props.formatExact(value) : String(value);
}
</script>

<template>
  <figure :class="['ui-stacked-bar', { 'ui-stacked-bar--compact': compact }]">
    <figcaption class="ui-stacked-bar__legend">
      <span v-for="item in series" :key="item.name"><i :class="`tone-${item.tone}`"></i>{{ item.name }}</span>
    </figcaption>
    <div class="ui-stacked-bar__chart">
      <div class="ui-stacked-bar__axis" aria-hidden="true">
        <span v-for="(tick, index) in ticks" :key="index">{{ formatValue(tick) }}</span>
      </div>
      <div class="ui-stacked-bar__area">
        <div class="ui-stacked-bar__grid" aria-hidden="true"><i></i><i></i><i></i></div>
        <div class="ui-stacked-bar__plot" role="img" :aria-label="label">
          <div v-for="column in columns" :key="column.point" class="ui-stacked-bar__column" :title="column.title">
            <div class="ui-stacked-bar__stack">
              <i
                v-for="segment in column.segments"
                :key="segment.name"
                :class="[
                  `tone-${segment.tone}`,
                  { 'is-top': segment.isTop, 'has-gap': segment.hasGap, 'is-empty': segment.value === 0 },
                ]"
                :style="{ height: segment.height }"
              ></i>
            </div>
          </div>
        </div>
        <div class="ui-stacked-bar__x" aria-hidden="true">
          <span v-for="(column, index) in columns" :key="column.point" class="ui-stacked-bar__tick"
            ><span v-if="showLabel(index)">{{ column.point }}</span></span
          >
        </div>
      </div>
    </div>
    <component :is="folded ? 'details' : 'div'" class="ui-stacked-bar__table">
      <summary v-if="folded" class="ui-stacked-bar__toggle">{{ t("ui.trendChartValues") }}</summary>
      <div class="ui-stacked-bar__data" role="region" :aria-label="t('ui.trendChartValues')" tabindex="0">
        <table>
          <caption>
            {{
              t("ui.actualCountsPerPeriod")
            }}
          </caption>
          <thead>
            <tr>
              <th scope="col">{{ t("ui.period") }}</th>
              <th v-for="item in series" :key="item.name" scope="col">{{ item.name }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(point, index) in labels" :key="point">
              <th scope="row">{{ point }}</th>
              <td v-for="item in series" :key="item.name">{{ exact(item.values[index] ?? 0) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </component>
  </figure>
</template>

<style scoped>
.ui-stacked-bar {
  margin: 0;
  padding: var(--space-4);
}

.ui-stacked-bar__legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-4);
  margin-bottom: var(--space-3);
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.ui-stacked-bar__legend i {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 6px;
  border-radius: var(--radius-xs);
  vertical-align: -1px;
}

.ui-stacked-bar__chart {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--space-2);
}

/* The axis labels sit on the three gridlines: top (maximum), middle, baseline. */
.ui-stacked-bar__axis {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  height: 196px;
  margin-top: -8px;
  color: var(--fg-muted);
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
  line-height: 16px;
  text-align: right;
}

.ui-stacked-bar__area {
  min-width: 0;
}

.ui-stacked-bar__grid {
  position: relative;
  height: 0;
}

.ui-stacked-bar__grid i {
  position: absolute;
  right: 0;
  left: 0;
  border-top: 1px solid var(--border-muted);
}

.ui-stacked-bar__grid i:nth-child(1) {
  top: 0;
}

.ui-stacked-bar__grid i:nth-child(2) {
  top: 90px;
}

.ui-stacked-bar__grid i:nth-child(3) {
  top: 180px;
  border-color: var(--border);
}

.ui-stacked-bar__plot {
  position: relative;
  display: flex;
  gap: 2px;
  height: 180px;
}

.ui-stacked-bar__column {
  display: flex;
  flex: 1;
  align-items: flex-end;
  min-width: 0;
  height: 100%;
}

.ui-stacked-bar__stack {
  display: flex;
  flex-direction: column-reverse;
  justify-content: flex-start;
  width: 100%;
  max-width: 24px;
  height: 100%;
  margin-inline: auto;
}

.ui-stacked-bar__stack i {
  display: block;
  flex: none;
  min-height: 0;
}

.ui-stacked-bar__stack i:not(.is-empty) {
  min-height: 2px;
}

.ui-stacked-bar__stack i.is-top {
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
}

.ui-stacked-bar__stack i.has-gap {
  box-shadow: inset 0 -2px 0 var(--bg-surface);
}

.ui-stacked-bar__x {
  display: flex;
  gap: 2px;
  height: 20px;
  margin-top: var(--space-1);
}

.ui-stacked-bar__tick {
  position: relative;
  flex: 1;
  min-width: 0;
  color: var(--fg-muted);
  font-size: var(--text-xs);
  text-align: center;
  white-space: nowrap;
}

/* Labels may be wider than their column; center them over it and let them overflow sideways. */
.ui-stacked-bar__tick span {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
}

.ui-stacked-bar--compact .ui-stacked-bar__plot {
  height: 120px;
}

.ui-stacked-bar--compact .ui-stacked-bar__axis {
  height: 136px;
}

.ui-stacked-bar--compact .ui-stacked-bar__grid i:nth-child(2) {
  top: 60px;
}

.ui-stacked-bar--compact .ui-stacked-bar__grid i:nth-child(3) {
  top: 120px;
}

.ui-stacked-bar__toggle {
  margin-top: var(--space-2);
  color: var(--fg-muted);
  font-size: var(--text-xs);
  cursor: pointer;
}

.ui-stacked-bar__toggle:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.ui-stacked-bar__data {
  max-height: 240px;
  margin-top: var(--space-4);
  overflow: auto;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius);
}

.ui-stacked-bar__data:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.ui-stacked-bar__data table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: var(--text-xs);
  text-align: left;
}

.ui-stacked-bar__data caption {
  padding: var(--space-2) var(--space-3);
  color: var(--fg-muted);
  text-align: left;
}

.ui-stacked-bar__data th,
.ui-stacked-bar__data td {
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--border-muted);
  white-space: nowrap;
}

.ui-stacked-bar__data thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--bg-surface);
  color: var(--fg-muted);
  font-weight: 500;
}

.ui-stacked-bar__data tbody th {
  font-weight: 500;
}

.ui-stacked-bar__data td {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.tone-accent {
  background: var(--accent);
}
.tone-done {
  background: var(--done);
}
.tone-success {
  background: var(--success);
}
.tone-attention {
  background: var(--attention);
}
.tone-danger {
  background: var(--danger);
}
.tone-neutral {
  background: var(--fg-subtle);
}
.tone-diagram-5 {
  background: var(--diagram-tone-5);
}
.tone-diagram-6 {
  background: var(--diagram-tone-6);
}
</style>
