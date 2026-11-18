import { app, BrowserWindow, screen, type WebContents } from "electron";
import {
  REPAIR_CHANNELS,
  REPAIR_PAGE_URL,
  windowBoundsFor,
  type AppTab,
  type WindowRect,
} from "@work-intelligence/desktop-core";

export interface RepairWindow {
  /**
   * Shows the App window. `requested` is an explicit tab request (the tray, a launch flag, a route inside main) and wins
   * over everything; without one main picks the blocking, remembered or default tab. The one window is focused (and
   * restored when minimised) and told to select the tab; it never reloads. Only a brand-new window loads the page,
   * which asks main for its tab (`app:get-tab`). There is never a second window.
   */
  open(requested?: AppTab): void;
  isOpen(): boolean;
  /** Closes the window when one is open. */
  close(): void;
  /** The open window, for native dialogs that belong to it. */
  window(): BrowserWindow | null;
  /** The window's web contents; the only sender the repair IPC trusts. */
  contents(): WebContents | null;
}

export interface RepairWindowOptions {
  readonly title: () => string;
  /** Decides and stores the tab to show (explicit request, blocking state, remembered tab, default) and returns it. */
  readonly selectTab: (requested?: AppTab) => AppTab;
  readonly preloadFile: string;
  /** Called before every new window is created; it must be safe to call again (the session policy is applied here). */
  readonly prepareSession: () => void;
  /** Developer tools are available only in an unpackaged (development or smoke-test) App. */
  readonly devTools: boolean;
  /** Called each time the window has actually been made visible (a new window after its first paint, or an existing one brought forward). */
  readonly onShown?: () => void;
}

function toRect(bounds: { x: number; y: number; width: number; height: number }): WindowRect {
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
}

export function createRepairWindow(options: RepairWindowOptions): RepairWindow {
  let current: BrowserWindow | null = null;
  /** Size and position the window had when it was last closed; memory only, for this App session. */
  let lastBounds: WindowRect | undefined;

  const alive = (): BrowserWindow | null => (current && !current.isDestroyed() ? current : null);

  function openBounds(): ReturnType<typeof windowBoundsFor> {
    const display = lastBounds ? screen.getDisplayMatching(lastBounds) : screen.getPrimaryDisplay();
    return windowBoundsFor(toRect(display.workArea), lastBounds);
  }

  function open(requested?: AppTab): void {
    const tab = options.selectTab(requested);
    const existing = alive();
    if (existing) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      try {
        existing.webContents.send(REPAIR_CHANNELS.selectTab, tab);
      } catch {
        // A page that is going away has nothing to select.
      }
      options.onShown?.();
      return;
    }
    if (process.platform === "darwin") void app.dock?.show();
    options.prepareSession();
    const created = new BrowserWindow({
      ...openBounds(),
      show: false,
      title: options.title(),
      // Windows and Linux have no menu bar at all (the application menu is null and the window's own is removed, so Alt
      // reveals nothing); macOS keeps its small menu in the system menu bar.
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        webviewTag: false,
        devTools: options.devTools,
        preload: options.preloadFile,
      },
    });
    if (process.platform !== "darwin") created.removeMenu();
    current = created;
    created.once("ready-to-show", () => {
      created.show();
      options.onShown?.();
    });
    created.on("close", () => {
      lastBounds = toRect(created.getNormalBounds());
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
    close: () => alive()?.close(),
    window: alive,
    contents: () => alive()?.webContents ?? null,
  };
}
