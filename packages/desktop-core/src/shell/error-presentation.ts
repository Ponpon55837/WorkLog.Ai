import type { LaunchMode } from "./launch-mode.js";

/** What the shell can do to tell the user; the Electron layer implements these. */
export interface ErrorSurface {
  openRepairWindow(): void;
  /** Tray icon and tooltip show that attention is needed (`code` null clears it). */
  setTrayAttention(code: string | null): void;
  /** One system notification. */
  notify(code: string): void;
}

/**
 * Presents a backend error according to how the App was started. Interactive: open the repair window. Background (login):
 * never open a window; update the tray and send at most one system notification per error code until the error clears.
 */
export class ErrorPresenter {
  private readonly mode: LaunchMode;
  private readonly surface: ErrorSurface;
  private readonly notified = new Set<string>();

  constructor(mode: LaunchMode, surface: ErrorSurface) {
    this.mode = mode;
    this.surface = surface;
  }

  present(code: string): void {
    if (this.mode === "interactive") {
      this.surface.setTrayAttention(code);
      this.surface.openRepairWindow();
      return;
    }
    this.surface.setTrayAttention(code);
    if (this.notified.has(code)) return;
    this.notified.add(code);
    this.surface.notify(code);
  }

  /** The service is healthy again: the tray returns to normal and a later error notifies again. */
  clear(): void {
    this.notified.clear();
    this.surface.setTrayAttention(null);
  }
}
