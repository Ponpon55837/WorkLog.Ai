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
