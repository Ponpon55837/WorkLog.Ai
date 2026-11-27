import type { LaunchMode } from "./launch-mode.js";

export interface ErrorSurface {
  openRepairWindow(): void;
  setTrayAttention(code: string | null): void;
  notify(code: string): void;
}

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

  clear(): void {
    this.notified.clear();
    this.surface.setTrayAttention(null);
  }
}
