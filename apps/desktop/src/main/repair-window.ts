import { app, BrowserWindow, type WebContents } from "electron";
import { REPAIR_PAGE_URL } from "@work-intelligence/desktop-core";

export interface RepairWindow {
  /** Shows the repair window: a new one, or the one that is already open. */
  open(): void;
  isOpen(): boolean;
  /** The open window, for native dialogs that belong to it. */
  window(): BrowserWindow | null;
  /** The window's web contents; the only sender the repair IPC trusts. */
  contents(): WebContents | null;
}

export interface RepairWindowOptions {
  readonly title: () => string;
  readonly preloadFile: string;
  /** Called before every new window is created; it must be safe to call again (the session policy is applied here). */
  readonly prepareSession: () => void;
  /** Called each time the window has actually been made visible (a new window after its first paint, or an existing one brought forward). */
  readonly onShown?: () => void;
}

export function createRepairWindow(options: RepairWindowOptions): RepairWindow {
  let current: BrowserWindow | null = null;

  const alive = (): BrowserWindow | null => (current && !current.isDestroyed() ? current : null);

  function open(): void {
    const existing = alive();
    if (existing) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      options.onShown?.();
      return;
    }
    if (process.platform === "darwin") void app.dock?.show();
    options.prepareSession();
    const created = new BrowserWindow({
      width: 780,
      height: 760,
      show: false,
      title: options.title(),
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        webviewTag: false,
        preload: options.preloadFile,
      },
    });
    current = created;
    created.once("ready-to-show", () => {
      created.show();
      options.onShown?.();
    });
    created.on("closed", () => {
      current = null;
      // A background (login) start leaves no Dock icon when no window is open.
      if (process.platform === "darwin" && BrowserWindow.getAllWindows().length === 0) app.dock?.hide();
    });
    void created.loadURL(REPAIR_PAGE_URL);
  }

  return {
    open,
    isOpen: () => alive() !== null,
    window: alive,
    contents: () => alive()?.webContents ?? null,
  };
}
