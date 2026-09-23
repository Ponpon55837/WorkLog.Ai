import { computed, nextTick, ref } from "vue";
import type { PageInfo, WorkSessionRecord } from "@work-intelligence/core";
import { normalizePageSize, type ListPageSize } from "../utils/labels";
import { parseDateInputValue, startOfMonth, toDateInputValue } from "../utils/format";
import { runKeyed, useApi } from "./useApi";

export const emptyPageInfo: PageInfo = {
  page: 1,
  pageSize: 20,
  total: 0,
  totalPages: 1,
  from: 0,
  to: 0,
  hasPrevious: false,
  hasNext: false,
  truncated: false
};

export type DatePickerTarget = "from" | "to";

const sessions = ref<WorkSessionRecord[]>([]);
const searchTerm = ref("");
const selectedProjectId = ref("");
const sessionPage = ref(1);
const sessionPageSize = ref<ListPageSize>(10);
const sessionPageInfo = ref<PageInfo>({ ...emptyPageInfo, pageSize: 10 });
const dateFrom = ref("");
const dateTo = ref("");
const sessionFilterError = ref("");
const hasSessionFilters = computed(() => Boolean(searchTerm.value || selectedProjectId.value || dateFrom.value || dateTo.value));

const activeDatePicker = ref<DatePickerTarget | null>(null);
const pickerMonth = ref(startOfMonth(new Date()));
const datePickerStyle = ref<Record<string, string>>({});
let datePickerTrigger: HTMLElement | null = null;

async function loadSessions(resetPage = false): Promise<void> {
  if (resetPage) {
    sessionPage.value = 1;
  }
  activeDatePicker.value = null;
  if (dateFrom.value && dateTo.value && dateFrom.value > dateTo.value) {
    sessionFilterError.value = "起始日期必須早於或等於結束日期。";
    return;
  }

  sessionFilterError.value = "";
  await runKeyed("worklog-sessions", async (signal) => {
    const result = await useApi().client.listSessions({
      q: searchTerm.value.trim() || undefined,
      projectId: selectedProjectId.value || undefined,
      from: dateFrom.value || undefined,
      to: dateTo.value || undefined,
      page: sessionPage.value,
      pageSize: sessionPageSize.value
    }, signal);
    sessions.value = result.items;
    sessionPage.value = result.pageInfo.page;
    sessionPageInfo.value = result.pageInfo;
  });
}

async function clearSessionFilters(): Promise<void> {
  activeDatePicker.value = null;
  searchTerm.value = "";
  selectedProjectId.value = "";
  dateFrom.value = "";
  dateTo.value = "";
  await loadSessions(true);
}

async function changeSessionPage(page: number): Promise<void> {
  if (page < 1 || page > sessionPageInfo.value.totalPages || page === sessionPage.value) {
    return;
  }
  sessionPage.value = page;
  await loadSessions();
}

async function changeSessionPageSize(event: Event): Promise<void> {
  sessionPageSize.value = normalizePageSize((event.target as HTMLSelectElement).value);
  sessionPage.value = 1;
  await loadSessions();
}

function updateDatePickerPosition(): void {
  if (!activeDatePicker.value || !datePickerTrigger) {
    return;
  }

  const rect = datePickerTrigger.getBoundingClientRect();
  const gutter = 12;
  const menuWidth = Math.min(286, window.innerWidth - gutter * 2);
  const menuHeight = 340;
  const left = Math.min(Math.max(gutter, rect.left), window.innerWidth - menuWidth - gutter);
  const top = rect.bottom + 8 + menuHeight <= window.innerHeight - gutter ? rect.bottom + 8 : Math.max(gutter, rect.top - menuHeight - 8);
  datePickerStyle.value = { left: `${left}px`, top: `${top}px` };
}

function toggleDatePicker(target: DatePickerTarget, trigger: HTMLElement | null): void {
  datePickerTrigger = trigger;
  if (activeDatePicker.value === target) {
    activeDatePicker.value = null;
    return;
  }

  activeDatePicker.value = target;
  const selectedValue = target === "from" ? dateFrom.value : dateTo.value;
  pickerMonth.value = startOfMonth(selectedValue ? parseDateInputValue(selectedValue) : new Date());
  void nextTick(updateDatePickerPosition);
}

function shiftPickerMonth(offset: number): void {
  pickerMonth.value = new Date(pickerMonth.value.getFullYear(), pickerMonth.value.getMonth() + offset, 1);
}

function setPickedDate(value: string): void {
  if (activeDatePicker.value === "from") {
    dateFrom.value = value;
  } else if (activeDatePicker.value === "to") {
    dateTo.value = value;
  }
  sessionFilterError.value = "";
  activeDatePicker.value = null;
}

const pickerMonthLabel = computed(() =>
  new Intl.DateTimeFormat("zh-TW", { year: "numeric", month: "long" }).format(pickerMonth.value)
);

const calendarDays = computed(() => {
  const selected = activeDatePicker.value === "from" ? dateFrom.value : activeDatePicker.value === "to" ? dateTo.value : "";
  const monthStart = startOfMonth(pickerMonth.value);
  const calendarStart = new Date(monthStart);
  calendarStart.setDate(monthStart.getDate() - monthStart.getDay());
  const today = toDateInputValue(new Date());

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(calendarStart);
    date.setDate(calendarStart.getDate() + index);
    const value = toDateInputValue(date);
    return {
      value,
      label: date.getDate(),
      inCurrentMonth: date.getMonth() === monthStart.getMonth(),
      isToday: value === today,
      isSelected: value === selected
    };
  });
});

export function useSessions() {
  return {
    sessions,
    searchTerm,
    selectedProjectId,
    sessionPageSize,
    sessionPageInfo,
    dateFrom,
    dateTo,
    sessionFilterError,
    hasSessionFilters,
    loadSessions,
    clearSessionFilters,
    changeSessionPage,
    changeSessionPageSize,
    activeDatePicker,
    datePickerStyle,
    pickerMonthLabel,
    calendarDays,
    toggleDatePicker,
    updateDatePickerPosition,
    shiftPickerMonth,
    selectCalendarDate: setPickedDate,
    clearCalendarDate: () => setPickedDate("")
  };
}
