import { app, BrowserWindow, type WebContents } from "electron";
import { REPAIR_PAGE_URL, type AppView } from "@work-intelligence/desktop-core";

export interface RepairWindow {
  /**
   * Shows the App window on `view` (the repair page when omitted): a new window, or the open one, which reloads when it
   * showed another view. The page asks main which view to render (`app:get-view`); it never chooses one itself.
   */
  open(view?: AppView): void;
  isOpen(): boolean;
  /** Closes the window when one is open. */
  close(): void;
  /** The open window, for native dialogs that belong to it. */
  window(): BrowserWindow | null;
  /** The window's web contents; the only sender the repair IPC trusts. */
  contents(): WebContents | null;
}

export interface RepairWindowOptions {
  readonly title: (view: AppView) => string;
  /** Where the current view is kept; the IPC reads it for `app:get-view`. */
  readonly setView: (view: AppView) => void;
  /** The view used when `open` names none. */
  readonly defaultView: () => AppView;
  readonly preloadFile: string;
  /** Called before every new window is created; it must be safe to call again (the session policy is applied here). */
  readonly prepareSession: () => void;
  /** Called each time the window has actually been made visible (a new window after its first paint, or an existing one brought forward). */
  readonly onShown?: () => void;
}

export function createRepairWindow(options: RepairWindowOptions): RepairWindow {
  let current: BrowserWindow | null = null;

  const alive = (): BrowserWindow | null => (current && !current.isDestroyed() ? current : null);

  let shown: AppView | null = null;

  function open(requested?: AppView): void {
    const view = requested ?? options.defaultView();
    options.setView(view);
    const existing = alive();
    if (existing && shown !== view) {
      shown = view;
      existing.setTitle(options.title(view));
      existing.webContents.reload();
    }
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
      title: options.title(view),
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
    shown = view;
    created.once("ready-to-show", () => {
      created.show();
      options.onShown?.();
    });
    created.on("closed", () => {
      current = null;
      shown = null;
      // A background (login) start leaves no Dock icon when no window is open.
      if (process.platform === "darwin" && BrowserWindow.getAllWindows().length === 0) app.dock?.hide();
    });
    void created.loadURL(REPAIR_PAGE_URL);
  }

  return {
    open,
    isOpen: () => alive() !== null,
    close: () => alive()?.close(),
    window: alive,
    contents: () => alive()?.webContents ?? null,
  };
}
