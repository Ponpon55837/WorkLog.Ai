import { app, BrowserWindow, screen, type WebContents } from "electron";
import {
  REPAIR_CHANNELS,
  REPAIR_PAGE_URL,
  windowBoundsFor,
  type AppTab,
  type WindowRect,
} from "@work-intelligence/desktop-core";

/** Whether the tab main shows counts as the user's choice (and is remembered); an explicit request does, a recovery redirect does not. */
export interface TabChoice {
  readonly remember?: boolean;
}

export interface RepairWindow {
  /**
   * Shows the App window. `requested` is an explicit tab request (the tray, a launch flag, a route inside main) and wins
   * over everything; without one main picks the blocking, remembered or default tab. The one window is focused (and
   * restored when minimised) and told to select the tab; it never reloads. Only a brand-new window loads the page,
   * which asks main for its tab (`app:get-tab`). There is never a second window.
   */
  open(requested?: AppTab, choice?: TabChoice): void;
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
  readonly selectTab: (requested?: AppTab, remember?: boolean) => AppTab;
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

/** TEMPORARY perf marker: ms since the main process started. */
export function perfMark(name: string): void {
  const g = globalThis as { __wiMarks?: string[] };
  (g.__wiMarks ??= []).push(`${name}=${Math.round(process.uptime() * 1000)}`);
}

export function createRepairWindow(options: RepairWindowOptions): RepairWindow {
  let current: BrowserWindow | null = null;
  /** Size and position the window had when it was last closed; memory only, for this App session. */
  let lastBounds: WindowRect | undefined;

  const alive = (): BrowserWindow | null => (current && !current.isDestroyed() ? current : null);

  function openBounds(): ReturnType<typeof windowBoundsFor> {
    perfMark("boundsStart");
    const display = lastBounds ? screen.getDisplayMatching(lastBounds) : screen.getPrimaryDisplay();
    const result = windowBoundsFor(toRect(display.workArea), lastBounds);
    perfMark("boundsEnd");
    const override = Number(process.env.WORK_INTELLIGENCE_PERF_WIDTH);
    return override > 0 ? { ...result, width: override } : result;
  }

  function open(requested?: AppTab, choice: TabChoice = {}): void {
    const tab = options.selectTab(requested, choice.remember ?? requested !== undefined);
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
    perfMark("prepareStart");
    options.prepareSession();
    perfMark("prepareEnd");
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
    perfMark("constructed");
    if (process.platform !== "darwin") created.removeMenu();
    current = created;
    created.webContents.once("did-finish-load", () => perfMark("didFinishLoad"));
    created.once("ready-to-show", () => {
      perfMark("readyToShow");
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
    perfMark("loadURL");
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
