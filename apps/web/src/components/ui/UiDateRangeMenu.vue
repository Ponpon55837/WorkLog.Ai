<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Calendar, ChevronDown, ChevronLeft, ChevronRight } from "lucide-vue-next";
import { usePopover } from "../../composables/usePopover";
import { startOfMonth, toDateInputValue } from "../../utils/format";
import type { DateRange } from "./types";

/** The app's only date picker: preset ranges plus a two-click custom range calendar. */
const props = withDefaults(
  defineProps<{
    label?: string;
    variant?: "filter" | "button";
    align?: "start" | "end";
    allowAllDates?: boolean;
  }>(),
  { label: "日期", variant: "filter", align: "end", allowAllDates: true },
);
const model = defineModel<DateRange>({ required: true });

const { open, trigger, panel, style, toggle, close } = usePopover({ align: computed(() => props.align), width: 296 });
const month = ref(startOfMonth(new Date()));
const draftFrom = ref("");

function shift(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

const presets = computed(() => {
  const today = new Date();
  const todayValue = toDateInputValue(today);
  return [
    ...(props.allowAllDates ? [{ key: "all", label: "不限日期", range: { from: "", to: "" } }] : []),
    { key: "today", label: "今天", range: { from: todayValue, to: todayValue } },
    {
      key: "yesterday",
      label: "昨天",
      range: { from: toDateInputValue(shift(today, -1)), to: toDateInputValue(shift(today, -1)) },
    },
    { key: "7d", label: "近 7 天", range: { from: toDateInputValue(shift(today, -6)), to: todayValue } },
    { key: "month", label: "本月", range: { from: toDateInputValue(startOfMonth(today)), to: todayValue } },
  ];
});

const activePreset = computed(() =>
  presets.value.find((preset) => preset.range.from === model.value.from && preset.range.to === model.value.to),
);
const applied = computed(() => Boolean(model.value.from || model.value.to));
const triggerText = computed(() => {
  if (!applied.value) {
    return props.label;
  }
  if (activePreset.value) {
    return activePreset.value.label;
  }
  const format = (value: string) => value.replaceAll("-", "/");
  return model.value.from === model.value.to
    ? format(model.value.from)
    : `${format(model.value.from || "…")} – ${format(model.value.to || "…")}`;
});

const monthLabel = computed(() =>
  new Intl.DateTimeFormat("zh-TW", { year: "numeric", month: "long" }).format(month.value),
);
const days = computed(() => {
  const start = shift(month.value, -month.value.getDay());
  const today = toDateInputValue(new Date());
  const from = draftFrom.value || model.value.from;
  const to = draftFrom.value ? "" : model.value.to;
  return Array.from({ length: 42 }, (_, index) => {
    const date = shift(start, index);
    const value = toDateInputValue(date);
    return {
      value,
      label: date.getDate(),
      outside: date.getMonth() !== month.value.getMonth(),
      today: value === today,
      edge: value === from || value === to,
      inRange: Boolean(from && to && value > from && value < to),
    };
  });
});

function choosePreset(range: DateRange): void {
  model.value = { ...range };
  draftFrom.value = "";
  close();
}

function pickDay(value: string): void {
  if (!draftFrom.value) {
    draftFrom.value = value;
    return;
  }
  const [from, to] = draftFrom.value <= value ? [draftFrom.value, value] : [value, draftFrom.value];
  model.value = { from, to };
  draftFrom.value = "";
  close();
}

watch(open, (value) => {
  if (value) {
    draftFrom.value = "";
    month.value = startOfMonth(model.value.from ? new Date(`${model.value.from}T00:00:00`) : new Date());
  }
});
</script>

<template>
  <button
    ref="trigger"
    type="button"
    :class="[
      'ui-date-range__trigger',
      `ui-date-range__trigger--${variant}`,
      { 'is-applied': applied, 'is-open': open },
    ]"
    aria-haspopup="dialog"
    :aria-expanded="open"
    @click="toggle"
  >
    <Calendar v-if="variant === 'button'" :size="16" :stroke-width="1.75" aria-hidden="true" />
    <span>{{ triggerText }}</span>
    <ChevronDown :size="14" :stroke-width="1.75" aria-hidden="true" />
  </button>
  <Teleport to="body">
    <div v-if="open" ref="panel" class="ui-date-range__panel" :style="style" role="dialog" aria-label="選擇日期區間">
      <div class="ui-date-range__presets">
        <button
          v-for="preset in presets"
          :key="preset.key"
          type="button"
          :class="{ 'is-active': activePreset?.key === preset.key }"
          @click="choosePreset(preset.range)"
        >
          {{ preset.label }}
        </button>
      </div>
      <div class="ui-date-range__calendar">
        <div class="ui-date-range__toolbar">
          <button
            type="button"
            aria-label="上一個月"
            @click="month = new Date(month.getFullYear(), month.getMonth() - 1, 1)"
          >
            <ChevronLeft :size="16" :stroke-width="1.75" aria-hidden="true" />
          </button>
          <strong>{{ monthLabel }}</strong>
          <button
            type="button"
            aria-label="下一個月"
            @click="month = new Date(month.getFullYear(), month.getMonth() + 1, 1)"
          >
            <ChevronRight :size="16" :stroke-width="1.75" aria-hidden="true" />
          </button>
        </div>
        <div class="ui-date-range__weekdays" aria-hidden="true">
          <span v-for="weekday in ['日', '一', '二', '三', '四', '五', '六']" :key="weekday">{{ weekday }}</span>
        </div>
        <div class="ui-date-range__grid">
          <button
            v-for="day in days"
            :key="day.value"
            type="button"
            :aria-label="day.value"
            :aria-pressed="day.edge"
            :class="{
              'is-outside': day.outside,
              'is-today': day.today,
              'is-edge': day.edge,
              'is-in-range': day.inRange,
            }"
            @click="pickDay(day.value)"
          >
            {{ day.label }}
          </button>
        </div>
        <p class="ui-date-range__hint">
          {{ draftFrom ? `起始 ${draftFrom}，請選擇結束日期` : "點選兩個日期作為自訂區間" }}
        </p>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ui-date-range__trigger {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: var(--control-height-sm);
  padding: 0 var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--radius);
  background: none;
  color: var(--fg-muted);
  font-size: var(--text-md);
  white-space: nowrap;
}

.ui-date-range__trigger:hover,
.ui-date-range__trigger.is-open {
  background: var(--bg-hover);
  color: var(--fg);
}

.ui-date-range__trigger.is-applied {
  color: var(--fg);
  font-weight: 600;
}

.ui-date-range__trigger--button {
  height: var(--control-height);
  padding: 0 var(--space-3);
  border-color: var(--border);
  background: var(--bg-muted);
  color: var(--fg);
  font-weight: 500;
}

.ui-date-range__trigger :deep(.lucide) {
  color: var(--fg-muted);
}

.ui-date-range__panel {
  position: fixed;
  z-index: 60;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-subtle);
  box-shadow: var(--shadow-popover);
}

.ui-date-range__presets {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  padding: var(--space-2);
  border-bottom: 1px solid var(--border-muted);
}

.ui-date-range__presets button {
  height: 26px;
  padding: 0 var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: none;
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.ui-date-range__presets button:hover {
  color: var(--fg);
}

.ui-date-range__presets button.is-active {
  border-color: var(--accent-border);
  background: var(--accent-soft);
  color: var(--accent);
}

.ui-date-range__calendar {
  padding: var(--space-2) var(--space-3) var(--space-3);
}

.ui-date-range__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-2);
  font-size: var(--text-sm);
}

.ui-date-range__toolbar button {
  display: inline-flex;
  padding: var(--space-1);
  border: 0;
  border-radius: var(--radius);
  background: none;
  color: var(--fg-muted);
}

.ui-date-range__toolbar button:hover {
  background: var(--bg-hover);
  color: var(--fg);
}

.ui-date-range__weekdays,
.ui-date-range__grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  text-align: center;
}

.ui-date-range__weekdays span {
  padding: var(--space-1) 0;
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.ui-date-range__grid button {
  height: 32px;
  border: 0;
  border-radius: var(--radius);
  background: none;
  color: var(--fg);
  font-size: var(--text-sm);
}

.ui-date-range__grid button:hover {
  background: var(--bg-hover);
}

.ui-date-range__grid .is-outside {
  color: var(--fg-muted);
  opacity: 0.7;
}
.ui-date-range__grid .is-today {
  box-shadow: inset 0 0 0 1px var(--border-strong);
}
.ui-date-range__grid .is-in-range {
  border-radius: 0;
  background: var(--accent-soft);
}
.ui-date-range__grid .is-edge {
  background: var(--accent-emphasis);
  color: var(--fg-on-emphasis);
  font-weight: 600;
}

.ui-date-range__hint {
  margin-top: var(--space-2);
  color: var(--fg-muted);
  font-size: var(--text-xs);
}
</style>
