/** A rectangle in screen coordinates, as Electron reports them (DIP, the display's work area excludes the taskbar). */
export interface WindowRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Default and minimum size of the App window. Every tab fits without horizontal scroll at 125% and 150% display
 * scaling on Windows: a 1366x768 screen at 150% is 910x512 DIP, which the work area clamp below then respects.
 */
export const WINDOW_DEFAULT_SIZE = { width: 920, height: 760 } as const;
export const WINDOW_MIN_SIZE = { width: 720, height: 560 } as const;

export interface WindowBounds {
  readonly width: number;
  readonly height: number;
  readonly minWidth: number;
  readonly minHeight: number;
  /** Absent for a window that was never moved: the OS centres it. */
  readonly x?: number;
  readonly y?: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

/**
 * Where a new window goes: the size the user left it at (this App session only) or the default, never larger than the
 * work area and never below the minimum (which itself yields to a work area smaller than it). A remembered position is
 * moved back inside the work area so the window cannot reopen off-screen after a display change.
 */
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
