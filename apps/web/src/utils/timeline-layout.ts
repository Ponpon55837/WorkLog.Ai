import { weekdayLabel } from "./format";
import { t } from "../i18n";
export interface TimelineSpan {
  start: number;
  end: number;
}

export type PackedSpan<T> = T & { row: number };

export function packRows<T extends TimelineSpan>(
  items: readonly T[],
  gap = 0,
): { items: PackedSpan<T>[]; rows: number } {
  const sorted = [...items].sort((left, right) => left.start - right.start || left.end - right.end);
  const heap: Array<[number, number]> = [];
  const push = (entry: [number, number]) => {
    heap.push(entry);
    for (let index = heap.length - 1; index > 0;) {
      const parent = (index - 1) >> 1;
      if (heap[parent]![0] <= heap[index]![0]) break;
      [heap[parent], heap[index]] = [heap[index]!, heap[parent]!];
      index = parent;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let index = 0; ;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < heap.length && heap[left]![0] < heap[smallest]![0]) smallest = left;
        if (right < heap.length && heap[right]![0] < heap[smallest]![0]) smallest = right;
        if (smallest === index) break;
        [heap[smallest], heap[index]] = [heap[index]!, heap[smallest]!];
        index = smallest;
      }
    }
    return top;
  };

  let rows = 0;
  const packed = sorted.map((item) => {
    let row: number;
    if (heap.length > 0 && heap[0]![0] + gap <= item.start) {
      row = pop()[1];
    } else {
      row = rows;
      rows += 1;
    }
    push([item.end, row]);
    return { ...item, row };
  });
  return { items: packed, rows };
}

/** `items` must be sorted by start. */
export function visibleSpans<T extends TimelineSpan>(
  items: readonly T[],
  from: number,
  to: number,
  longest: number,
): T[] {
  // Anything starting before `from - longest` has ended before `from`.
  let low = 0;
  let high = items.length;
  const earliest = from - longest;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (items[middle]!.start < earliest) low = middle + 1;
    else high = middle;
  }
  const visible: T[] = [];
  for (let index = low; index < items.length && items[index]!.start <= to; index += 1) {
    if (items[index]!.end >= from) visible.push(items[index]!);
  }
  return visible;
}

export const DAY_MS = 86_400_000;
/** Below this many pixels per day the timeline always draws one column per day instead of single Sessions. */
export const DETAIL_MIN_DAY_WIDTH = 48;

/** `fits` must be monotone over the ascending candidates; returns the last candidate when none fits. */
export function smallestFitting(candidates: readonly number[], fits: (candidate: number) => boolean): number {
  let low = 0;
  let high = candidates.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (fits(candidates[middle]!)) high = middle;
    else low = middle + 1;
  }
  return candidates[low]!;
}

export interface DayBucket {
  day: number;
  passed: number;
  failed: number;
  inProgress: number;
  other: number;
  total: number;
}

/**
 * Local midnight of the day a timestamp falls on.
 * @internal test-only
 */
export function startOfLocalDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function dayBuckets(sessions: ReadonlyArray<{ completedAt: string; verificationStatus: string }>): DayBucket[] {
  const byDay = new Map<number, DayBucket>();
  for (const session of sessions) {
    const day = startOfLocalDay(Date.parse(session.completedAt));
    let bucket = byDay.get(day);
    if (!bucket) {
      bucket = { day, passed: 0, failed: 0, inProgress: 0, other: 0, total: 0 };
      byDay.set(day, bucket);
    }
    if (session.verificationStatus === "passed") bucket.passed += 1;
    else if (session.verificationStatus === "failed") bucket.failed += 1;
    else if (session.verificationStatus === "in_progress") bucket.inProgress += 1;
    else bucket.other += 1;
    bucket.total += 1;
  }
  return [...byDay.values()].sort((left, right) => left.day - right.day);
}

export function weekendStarts(rangeStart: number, rangeEnd: number): number[] {
  const starts: number[] = [];
  const cursor = new Date(startOfLocalDay(rangeStart));
  while (cursor.getTime() < rangeEnd) {
    const weekday = cursor.getDay();
    if ((weekday === 0 || weekday === 6) && cursor.getTime() >= rangeStart) starts.push(cursor.getTime());
    cursor.setDate(cursor.getDate() + 1);
  }
  return starts;
}

export interface AxisTick {
  time: number;
  label: string;
  major: boolean;
}

/** Calendar arithmetic keeps days aligned across daylight-saving changes. */
export function axisTicks(rangeStart: number, rangeEnd: number, dayWidth: number): AxisTick[] {
  const ticks: AxisTick[] = [];
  const cursor = new Date(startOfLocalDay(rangeStart));
  if (dayWidth < 5) {
    cursor.setDate(1);
    if (cursor.getTime() < rangeStart) cursor.setMonth(cursor.getMonth() + 1);
    for (; cursor.getTime() < rangeEnd; cursor.setMonth(cursor.getMonth() + 1)) {
      const month = cursor.getMonth() + 1;
      const label = month === 1 ? t("graph.jan", { value: cursor.getFullYear() }) : t("graph.axisMonth", { month });
      ticks.push({ time: cursor.getTime(), label, major: true });
    }
    return ticks;
  }
  const dayStep = dayWidth < 18 ? 0 : dayWidth < 30 ? 2 : 1;
  for (let index = 0; cursor.getTime() < rangeEnd; cursor.setDate(cursor.getDate() + 1), index += 1) {
    const time = cursor.getTime();
    const monthDay = `${cursor.getMonth() + 1}/${cursor.getDate()}`;
    if (dayStep === 0) {
      if (cursor.getDay() === 1) ticks.push({ time, label: monthDay, major: cursor.getDate() <= 7 });
      continue;
    }
    if (index % dayStep !== 0) continue;
    const label =
      dayWidth >= 60
        ? t("graph.axisDayWithWeekday", { monthDay, weekday: weekdayLabel(cursor, false, "narrow") })
        : monthDay;
    ticks.push({ time, label, major: true });
    if (dayWidth >= 240) {
      for (const hour of [6, 12, 18]) {
        const mark = new Date(cursor);
        mark.setHours(hour);
        ticks.push({ time: mark.getTime(), label: `${String(hour).padStart(2, "0")}:00`, major: false });
      }
    }
  }
  return ticks;
}
