export interface WindowRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const WINDOW_DEFAULT_SIZE = { width: 920, height: 760 } as const;
export const WINDOW_MIN_SIZE = { width: 720, height: 560 } as const;

export interface WindowBounds {
  readonly width: number;
  readonly height: number;
  readonly minWidth: number;
  readonly minHeight: number;
  readonly x?: number;
  readonly y?: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

export function windowBoundsFor(workArea: WindowRect, remembered?: WindowRect): WindowBounds {
  const minWidth = Math.min(WINDOW_MIN_SIZE.width, workArea.width);
  const minHeight = Math.min(WINDOW_MIN_SIZE.height, workArea.height);
  const wanted = remembered ?? WINDOW_DEFAULT_SIZE;
  const width = clamp(Math.round(wanted.width), minWidth, workArea.width);
  const height = clamp(Math.round(wanted.height), minHeight, workArea.height);
  const size = { width, height, minWidth, minHeight };
  if (!remembered) return size;
  return {
    ...size,
    x: clamp(Math.round(remembered.x), workArea.x, workArea.x + workArea.width - width),
    y: clamp(Math.round(remembered.y), workArea.y, workArea.y + workArea.height - height),
  };
}
