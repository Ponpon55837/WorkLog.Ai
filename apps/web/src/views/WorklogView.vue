<script setup lang="ts">
import { ref } from "vue";
import type { PageInfo, ProjectRecord, WorkSessionRecord } from "@work-intelligence/core";
import VirtualList from "../components/VirtualList.vue";

type ListPageSize = 10 | 20 | 50 | 100 | "all";
type DatePickerTarget = "from" | "to";
type CalendarDay = {
  value: string;
  label: number;
  inCurrentMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
};

const props = defineProps<{
  projects: readonly ProjectRecord[];
  sessions: readonly WorkSessionRecord[];
  sessionPageInfo: PageInfo;
  searchTerm: string;
  selectedProjectId: string;
  sessionPageSize: ListPageSize;
  dateFrom: string;
  dateTo: string;
  sessionFilterError: string;
  hasSessionFilters: boolean;
  activeDatePicker: DatePickerTarget | null;
  datePickerStyle: Readonly<Record<string, string>>;
  pickerMonthLabel: string;
  calendarDays: readonly CalendarDay[];
  listPageSizeOptions: readonly { value: ListPageSize; label: string }[];
  formatDate: (value: string) => string;
  formatReadableSummary: (value: string) => string;
  displayDate: (value: string) => string;
  toDateInputValue: (value: Date) => string;
  verificationLabel: (value: unknown) => string;
}>();

const emit = defineEmits<{
  "update:searchTerm": [value: string];
  "update:selectedProjectId": [value: string];
  "update:sessionPageSize": [value: ListPageSize];
  "update:dateFrom": [value: string];
  "update:dateTo": [value: string];
  load: [reset?: boolean];
  clearSessionFilters: [];
  toggleDatePicker: [target: DatePickerTarget, trigger: HTMLButtonElement | null];
  shiftPickerMonth: [offset: number];
  selectCalendarDate: [value: string];
  clearCalendarDate: [];
  openSession: [session: WorkSessionRecord];
  changeSessionPage: [page: number];
  changeSessionPageSize: [event: Event];
}>();

const dateFromTrigger = ref<HTMLButtonElement | null>(null);
const dateToTrigger = ref<HTMLButtonElement | null>(null);

function toggleDatePicker(target: DatePickerTarget): void {
  emit("toggleDatePicker", target, target === "from" ? dateFromTrigger.value : dateToTrigger.value);
}
</script>

<template>
  <section class="page-section">
    <div class="section-intro worklog-intro">
      <div>
        <div class="eyebrow">SESSION ARCHIVE</div>
        <h2>每一次完成，都留下可追溯的脈絡。</h2>
      </div>
      <form class="worklog-tools" @submit.prevent="emit('load', true)">
        <label class="search-box">
          <span>⌕</span>
          <input :value="searchTerm" type="search" placeholder="搜尋 title、summary 或 event" @input="emit('update:searchTerm', ($event.target as HTMLInputElement).value)" />
        </label>
        <div class="filter-row">
          <label class="filter-field">
            <span>專案</span>
            <select :value="selectedProjectId" aria-label="依專案篩選" @change="emit('update:selectedProjectId', ($event.target as HTMLSelectElement).value)">
              <option value="">所有專案</option>
              <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option>
            </select>
          </label>
          <div class="filter-field date-filter-field">
            <span>從日期</span>
            <button ref="dateFromTrigger" class="date-picker-trigger" type="button" :aria-expanded="activeDatePicker === 'from'" aria-haspopup="dialog" aria-label="選擇開始日期" @click="toggleDatePicker('from')">
              <span class="calendar-glyph" aria-hidden="true">▦</span>
              <span :class="['date-picker-value', { placeholder: !dateFrom }]">{{ displayDate(dateFrom) }}</span>
              <span class="date-picker-chevron" aria-hidden="true">⌄</span>
            </button>
            <Teleport to="body">
              <div v-if="activeDatePicker === 'from'" class="date-picker-popover" :style="datePickerStyle" role="dialog" aria-label="選擇開始日期" @click.stop>
                <div class="date-picker-toolbar">
                  <button type="button" aria-label="上一個月" @click="emit('shiftPickerMonth', -1)">‹</button>
                  <strong>{{ pickerMonthLabel }}</strong>
                  <button type="button" aria-label="下一個月" @click="emit('shiftPickerMonth', 1)">›</button>
                </div>
                <div class="calendar-weekdays" aria-hidden="true"><span v-for="weekday in ['日', '一', '二', '三', '四', '五', '六']" :key="weekday">{{ weekday }}</span></div>
                <div class="calendar-grid">
                  <button v-for="day in calendarDays" :key="day.value" :class="['calendar-day', { muted: !day.inCurrentMonth, today: day.isToday, selected: day.isSelected }]" type="button" :aria-label="`${day.value}`" @click="emit('selectCalendarDate', day.value)">{{ day.label }}</button>
                </div>
                <div class="date-picker-footer">
                  <button type="button" class="date-today-button" @click="emit('selectCalendarDate', toDateInputValue(new Date()))">今天</button>
                  <button type="button" class="date-clear-button" @click="emit('clearCalendarDate')">清除</button>
                </div>
              </div>
            </Teleport>
          </div>
          <div class="filter-field date-filter-field">
            <span>至日期</span>
            <button ref="dateToTrigger" class="date-picker-trigger" type="button" :aria-expanded="activeDatePicker === 'to'" aria-haspopup="dialog" aria-label="選擇結束日期" @click="toggleDatePicker('to')">
              <span class="calendar-glyph" aria-hidden="true">▦</span>
              <span :class="['date-picker-value', { placeholder: !dateTo }]">{{ displayDate(dateTo) }}</span>
              <span class="date-picker-chevron" aria-hidden="true">⌄</span>
            </button>
            <Teleport to="body">
              <div v-if="activeDatePicker === 'to'" class="date-picker-popover" :style="datePickerStyle" role="dialog" aria-label="選擇結束日期" @click.stop>
                <div class="date-picker-toolbar">
                  <button type="button" aria-label="上一個月" @click="emit('shiftPickerMonth', -1)">‹</button>
                  <strong>{{ pickerMonthLabel }}</strong>
                  <button type="button" aria-label="下一個月" @click="emit('shiftPickerMonth', 1)">›</button>
                </div>
                <div class="calendar-weekdays" aria-hidden="true"><span v-for="weekday in ['日', '一', '二', '三', '四', '五', '六']" :key="weekday">{{ weekday }}</span></div>
                <div class="calendar-grid">
                  <button v-for="day in calendarDays" :key="day.value" :class="['calendar-day', { muted: !day.inCurrentMonth, today: day.isToday, selected: day.isSelected }]" type="button" :aria-label="`${day.value}`" @click="emit('selectCalendarDate', day.value)">{{ day.label }}</button>
                </div>
                <div class="date-picker-footer">
                  <button type="button" class="date-today-button" @click="emit('selectCalendarDate', toDateInputValue(new Date()))">今天</button>
                  <button type="button" class="date-clear-button" @click="emit('clearCalendarDate')">清除</button>
                </div>
              </div>
            </Teleport>
          </div>
          <button class="filter-button" type="submit">套用篩選</button>
          <button class="filter-clear" type="button" :disabled="!hasSessionFilters" @click="emit('clearSessionFilters')">清除</button>
        </div>
        <p v-if="sessionFilterError" class="filter-error" role="alert">{{ sessionFilterError }}</p>
      </form>
    </div>

    <section class="panel worklog-panel">
      <div class="list-heading worklog-heading"><span>{{ sessionPageInfo.total }} 個工作 Session<span v-if="hasSessionFilters" class="filter-applied">已套用篩選</span></span><span>完成時間</span></div>
      <VirtualList :items="sessions" :enabled="sessionPageSize === 'all'" aria-label="工作歷程清單">
        <template #default="{ item: session }">
          <button class="worklog-row" data-testid="session-row" type="button" @click="emit('openSession', session)">
            <div class="timeline-dot"></div>
            <div class="worklog-body">
              <div class="worklog-title"><strong>{{ session.title }}</strong><span class="finalized-label">已完成</span><span :class="['verification-badge', 'worklog-verification', `verification-${session.verification?.status ?? 'not_supplied'}`]">{{ verificationLabel(session.verification?.status) }}</span></div>
              <p>{{ formatReadableSummary(session.summary) }}</p>
              <div class="worklog-meta"><span>{{ session.projectName }}</span><span v-if="session.gitBranch">分支：{{ session.gitBranch }}</span><span>{{ session.changedFiles.length }} 個檔案</span></div>
            </div>
            <time>{{ formatDate(session.completedAt) }}</time>
            <span class="session-arrow">↗</span>
          </button>
        </template>
      </VirtualList>
      <div v-if="sessions.length === 0" class="empty-state large-empty"><div class="empty-icon">≡</div><strong>找不到工作紀錄</strong><p>完成的 session 會在這裡依時間排列。</p></div>
      <div class="pagination-bar list-pagination-bar">
        <span class="pagination-summary">顯示 {{ sessionPageInfo.from }}–{{ sessionPageInfo.to }}，共 {{ sessionPageInfo.total }} 筆<span v-if="sessionPageInfo.truncated" class="pagination-truncated"> · All 已限制每頁 {{ sessionPageInfo.pageSize }} 筆</span></span>
        <label class="pagination-page-size"><span>每頁</span><select :value="sessionPageSize" aria-label="工作歷程每頁筆數" @change="emit('changeSessionPageSize', $event)"><option v-for="option in listPageSizeOptions" :key="String(option.value)" :value="option.value">{{ option.label }}</option></select></label>
        <div v-if="sessionPageInfo.totalPages > 1" class="pagination-controls">
          <button class="pagination-button" type="button" :disabled="!sessionPageInfo.hasPrevious" @click="emit('changeSessionPage', sessionPageInfo.page - 1)">上一頁</button>
          <span>第 {{ sessionPageInfo.page }} / {{ sessionPageInfo.totalPages }} 頁</span>
          <button class="pagination-button" type="button" :disabled="!sessionPageInfo.hasNext" @click="emit('changeSessionPage', sessionPageInfo.page + 1)">下一頁</button>
        </div>
        <span v-else class="pagination-current">共 {{ sessionPageInfo.total }} 筆</span>
      </div>
    </section>
  </section>
</template>
