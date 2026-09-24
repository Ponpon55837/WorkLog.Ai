<script setup lang="ts">
import { computed } from "vue";
import type { Tone } from "./types";

/**
 * Grouped vertical bar chart for small deterministic series (≤ ~31 points).
 * Each series is scaled independently so low-volume series stay visible; values are shown in tooltips.
 */
const props = defineProps<{
  labels: readonly string[];
  series: readonly { name: string; tone: Tone; values: readonly number[] }[];
  label: string;
  /** Show every n-th x label to avoid crowding. */
  labelEvery?: number;
}>();

const maxima = computed(() => props.series.map((item) => Math.max(1, ...item.values)));
const every = computed(() => props.labelEvery ?? Math.max(1, Math.ceil(props.labels.length / 8)));

/** Every n-th label plus the last one, skipping an n-th label that would crowd the last. */
function showLabel(index: number): boolean {
  const last = props.labels.length - 1;
  return index === last || (index % every.value === 0 && last - index >= Math.ceil(every.value / 2));
}

function height(seriesIndex: number, value: number): string {
  return value ? `${Math.max(6, (value / (maxima.value[seriesIndex] ?? 1)) * 100)}%` : "2px";
}
</script>

<template>
  <figure class="ui-bar-chart">
    <figcaption class="ui-bar-chart__legend">
      <span v-for="item in series" :key="item.name"><i :class="`tone-${item.tone}`"></i>{{ item.name }}</span>
    </figcaption>
    <div class="ui-bar-chart__plot" role="img" :aria-label="label">
      <div
        v-for="(point, index) in labels"
        :key="point"
        class="ui-bar-chart__column"
        :title="`${point} · ${series.map((item) => `${item.name} ${item.values[index] ?? 0}`).join(' · ')}`"
      >
        <div class="ui-bar-chart__bars">
          <i
            v-for="(item, seriesIndex) in series"
            :key="item.name"
            :class="`tone-${item.tone}`"
            :style="{ height: height(seriesIndex, item.values[index] ?? 0) }"
          ></i>
        </div>
        <span class="ui-bar-chart__x"
          ><span v-if="showLabel(index)">{{ point }}</span></span
        >
      </div>
    </div>
  </figure>
</template>

<style scoped>
.ui-bar-chart {
  margin: 0;
  padding: var(--space-4);
}

.ui-bar-chart__legend {
  display: flex;
  gap: var(--space-4);
  margin-bottom: var(--space-3);
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.ui-bar-chart__legend i {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 6px;
  border-radius: 2px;
  vertical-align: -1px;
}

.ui-bar-chart__plot {
  display: flex;
  gap: var(--space-1);
  height: 180px;
  border-bottom: 1px solid var(--border-muted);
}

.ui-bar-chart__column {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.ui-bar-chart__bars {
  display: flex;
  flex: 1;
  align-items: flex-end;
  justify-content: center;
  gap: 2px;
}

.ui-bar-chart__bars i {
  width: 40%;
  max-width: 16px;
  border-radius: 3px 3px 0 0;
}

.ui-bar-chart__x {
  position: relative;
  height: 20px;
  padding-top: var(--space-1);
  color: var(--fg-muted);
  font-size: var(--text-xs);
  text-align: center;
  white-space: nowrap;
}

/* Labels may be wider than their column; center them over it and let them overflow sideways. */
.ui-bar-chart__x span {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
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
</style>
