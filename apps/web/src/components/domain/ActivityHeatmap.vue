<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { ListChecks } from "lucide-vue-next";
import type { ActivityDay } from "@work-intelligence/core";
import { buildActivityCalendar } from "../../utils/activity-calendar";
import { weekdayLabel } from "../../utils/format";
import UiEmptyState from "../ui/UiEmptyState.vue";
import { intlLocale, t } from "../../i18n";

const props = defineProps<{ days: readonly ActivityDay[] }>();
const emit = defineEmits<{ select: [date: string] }>();

const scroller = ref<HTMLElement | null>(null);
const grid = ref<HTMLElement | null>(null);
/** Roving tabindex: only this day is in the tab order; arrow keys move it. Null until the user moves. */
const focusedDate = ref<string | null>(null);

const calendar = computed(() => buildActivityCalendar(new Date(), props.days));
const lastDate = computed(() => calendar.value.to);
const tabbableDate = computed(() => focusedDate.value ?? lastDate.value);
// 2024-01-01 is a Monday, so these are the Monday, Wednesday and Friday labels of the locale.
const weekdayLabels = computed(() =>
  [0, 2, 4].map((row) => ({ row: row + 1, text: weekdayLabel(new Date(2024, 0, 1 + row), false, "short") })),
);
const monthLabels = computed(() =>
  calendar.value.months.map(({ week, date }) => ({
    week: week + 1,
    text: new Intl.DateTimeFormat(intlLocale(), { month: "short" }).format(date),
  })),
);
const dateFormat = computed(() => new Intl.DateTimeFormat(intlLocale(), { dateStyle: "long" }));

function cellLabel(date: string, sessions: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return t("dashboard.activityCellLabel", {
    date: dateFormat.value.format(new Date(year!, month! - 1, day)),
    count: sessions,
  });
}

function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(year!, month! - 1, day! + days);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
}

/** Up/Down move one day, Left/Right one week; moves outside the drawn range are ignored. */
function onKeydown(event: KeyboardEvent, date: string): void {
  const step = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }[event.key];
  if (step === undefined) return;
  event.preventDefault();
  const target = shiftDate(date, step);
  const button = grid.value?.querySelector<HTMLButtonElement>(`[data-date="${target}"]`);
  if (!button) return;
  focusedDate.value = target;
  void nextTick(() => button.focus());
}

onMounted(() => {
  // Show the most recent weeks first; the older ones scroll into view to the left.
  void nextTick(() => {
    if (scroller.value) scroller.value.scrollLeft = scroller.value.scrollWidth;
  });
});
</script>

<template>
  <UiEmptyState
    v-if="calendar.total === 0"
    compact
    :icon="ListChecks"
    :title="t('dashboard.activityEmptyTitle')"
    :description="t('dashboard.activityEmptyDescription')"
  />
  <div v-else class="activity">
    <p class="activity__total" data-testid="activity-total">
      {{ t("dashboard.activityTotal", { count: calendar.total }) }}
    </p>
    <div ref="scroller" class="activity__scroller">
      <div class="activity__chart">
        <div class="activity__months" aria-hidden="true">
          <span v-for="month in monthLabels" :key="month.week" :style="{ gridColumn: month.week }">{{
            month.text
          }}</span>
        </div>
        <div class="activity__weekdays" aria-hidden="true">
          <span v-for="label in weekdayLabels" :key="label.row" :style="{ gridRow: label.row }">{{ label.text }}</span>
        </div>
        <div ref="grid" class="activity__grid" role="group" :aria-label="t('dashboard.activityCalendarLabel')">
          <template v-for="(week, weekIndex) in calendar.weeks" :key="weekIndex">
            <template v-for="(cell, row) in week" :key="`${weekIndex}-${row}`">
              <button
                v-if="cell"
                type="button"
                :class="['activity__cell', `activity__cell--${cell.level}`]"
                :data-date="cell.date"
                :tabindex="cell.date === tabbableDate ? 0 : -1"
                :aria-label="cellLabel(cell.date, cell.sessions)"
                :title="cellLabel(cell.date, cell.sessions)"
                @click="emit('select', cell.date)"
                @keydown="onKeydown($event, cell.date)"
              ></button>
              <span v-else class="activity__spacer" aria-hidden="true"></span>
            </template>
          </template>
        </div>
      </div>
    </div>
    <div class="activity__legend" aria-hidden="true">
      <span>{{ t("dashboard.activityLess") }}</span>
      <span v-for="level in 5" :key="level" :class="['activity__swatch', `activity__cell--${level - 1}`]"></span>
      <span>{{ t("dashboard.activityMore") }}</span>
    </div>
  </div>
</template>

<style scoped>
.activity {
  --activity-cell: 12px;
  --activity-gap: 3px;
  display: grid;
  gap: var(--space-3);
  min-width: 0;
  padding: var(--space-4);
}

.activity__total {
  margin: 0;
  color: var(--fg-muted);
  font-size: var(--text-md);
}

/* The calendar scrolls inside its own box so the page never scrolls sideways. */
.activity__scroller {
  min-width: 0;
  overflow-x: auto;
  padding-bottom: var(--space-1);
}

.activity__chart {
  display: grid;
  grid-template-columns: 32px max-content;
  grid-template-rows: 16px auto;
  column-gap: var(--space-2);
  row-gap: var(--space-1);
  width: max-content;
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.activity__months {
  display: grid;
  grid-column: 2;
  column-gap: var(--activity-gap);
  grid-template-columns: repeat(53, var(--activity-cell));
  white-space: nowrap;
}

/* Weekday labels stay put while the weeks scroll sideways on narrow screens. */
.activity__weekdays {
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--bg-canvas);
  display: grid;
  grid-column: 1;
  grid-row: 2;
  grid-template-rows: repeat(7, var(--activity-cell));
  row-gap: var(--activity-gap);
  align-items: center;
  line-height: 1;
}

.activity__grid {
  display: grid;
  grid-column: 2;
  grid-row: 2;
  grid-auto-flow: column;
  grid-template-rows: repeat(7, var(--activity-cell));
  grid-auto-columns: var(--activity-cell);
  gap: var(--activity-gap);
}

.activity__cell {
  width: var(--activity-cell);
  height: var(--activity-cell);
  padding: 0;
  border: 1px solid var(--border-muted);
  border-radius: 2px;
  background: var(--bg-muted);
  cursor: pointer;
}

/* Activity is a neutral amount, not a status: accent, not success (green means passed/tracked in the status mapping). */
.activity__cell--1 {
  background: color-mix(in srgb, var(--accent-emphasis) 30%, var(--bg-canvas));
}
.activity__cell--2 {
  background: color-mix(in srgb, var(--accent-emphasis) 52%, var(--bg-canvas));
}
.activity__cell--3 {
  background: color-mix(in srgb, var(--accent-emphasis) 76%, var(--bg-canvas));
}
.activity__cell--4 {
  background: var(--accent-emphasis);
}

.activity__cell:hover {
  border-color: var(--fg-muted);
}

.activity__cell:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.activity__legend {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-1);
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.activity__swatch {
  width: var(--activity-cell);
  height: var(--activity-cell);
  border: 1px solid var(--border-muted);
  border-radius: 2px;
}
</style>
