import { weekdayLabel } from "./format";
import { t } from "../i18n";
/** A bar on the timeline, in milliseconds since the epoch. */
export interface TimelineSpan {
  start: number;
  end: number;
}

export type PackedSpan<T> = T & { row: number };

/**
 * Stacks overlapping bars into as few rows as possible (interval partitioning, as in "meeting rooms II"): bars
 * sorted by start take the row that frees up first, tracked with a min-heap of row end times. O(n log r).
 */
export function packRows<T extends TimelineSpan>(
  items: readonly T[],
  gap = 0,
): { items: PackedSpan<T>[]; rows: number } {
  const sorted = [...items].sort((left, right) => left.start - right.start || left.end - right.end);
  // Heap of [end time, row], smallest end first.
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

/** Items that intersect [from, to]; `items` must be sorted by start. Binary search skips everything after `to`. */
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

/**
 * The first candidate `fits` accepts, found by binary search; `fits` must be monotone over the ascending
 * candidates (once true, true for every larger one). Returns the last candidate when none fits.
 */
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
  /** Local midnight of the day. */
  day: number;
  passed: number;
  failed: number;
  other: number;
  total: number;
}

/** Local midnight of the day a timestamp falls on. */
export function startOfLocalDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Counts Sessions per local day and verification result in one pass (hash map by day), for the zoomed-out
 * timeline. Returns only days with Sessions, oldest first.
 */
export function dayBuckets(sessions: ReadonlyArray<{ completedAt: string; verificationStatus: string }>): DayBucket[] {
  const byDay = new Map<number, DayBucket>();
  for (const session of sessions) {
    const day = startOfLocalDay(Date.parse(session.completedAt));
    let bucket = byDay.get(day);
    if (!bucket) {
      bucket = { day, passed: 0, failed: 0, other: 0, total: 0 };
      byDay.set(day, bucket);
    }
    if (session.verificationStatus === "passed") bucket.passed += 1;
    else if (session.verificationStatus === "failed") bucket.failed += 1;
    else bucket.other += 1;
    bucket.total += 1;
  }
  return [...byDay.values()].sort((left, right) => left.day - right.day);
}

export interface AxisTick {
  time: number;
  label: string;
  /** Month or day boundaries; minor ticks (weeks, hours) are drawn lighter. */
  major: boolean;
}

/**
 * Axis ticks that stay readable at any zoom: months when a day is only a few pixels wide, Mondays for a
 * week-level view, every day (or every other day) when days are wider, and six-hour marks when very wide.
 * Uses calendar arithmetic, so days stay aligned across daylight-saving changes.
 */
export function axisTicks(rangeStart: number, rangeEnd: number, dayWidth: number): AxisTick[] {
  const ticks: AxisTick[] = [];
  const cursor = new Date(startOfLocalDay(rangeStart));
  if (dayWidth < 5) {
    cursor.setDate(1);
    if (cursor.getTime() < rangeStart) cursor.setMonth(cursor.getMonth() + 1);
    for (; cursor.getTime() < rangeEnd; cursor.setMonth(cursor.getMonth() + 1)) {
      const month = cursor.getMonth() + 1;
      const label = month === 1 ? t("{value}年1月", { value: cursor.getFullYear() }) : t("{month}月", { month });
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
        ? t("{monthDay}（{weekday}）", { monthDay, weekday: weekdayLabel(cursor, false, "narrow") })
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
