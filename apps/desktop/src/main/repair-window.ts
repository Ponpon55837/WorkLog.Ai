import { app, BrowserWindow, screen, type WebContents } from "electron";
import {
  REPAIR_CHANNELS,
  REPAIR_PAGE_URL,
  windowBoundsFor,
  type AppTab,
  type WindowRect,
} from "@work-intelligence/desktop-core";

export interface TabChoice {
  readonly remember?: boolean;
}

export interface RepairWindow {
  open(requested?: AppTab, choice?: TabChoice): void;
  isOpen(): boolean;
  close(): void;
  window(): BrowserWindow | null;
  contents(): WebContents | null;
}

export interface RepairWindowOptions {
  readonly title: () => string;
  readonly selectTab: (requested?: AppTab, remember?: boolean) => AppTab;
  readonly preloadFile: string;
  readonly prepareSession: () => void;
  readonly devTools: boolean;
  readonly onShown?: () => void;
}

function toRect(bounds: { x: number; y: number; width: number; height: number }): WindowRect {
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
}

export function createRepairWindow(options: RepairWindowOptions): RepairWindow {
  let current: BrowserWindow | null = null;
  let lastBounds: WindowRect | undefined;

  const alive = (): BrowserWindow | null => (current && !current.isDestroyed() ? current : null);

  function openBounds(): ReturnType<typeof windowBoundsFor> {
    const display = lastBounds ? screen.getDisplayMatching(lastBounds) : screen.getPrimaryDisplay();
    return windowBoundsFor(toRect(display.workArea), lastBounds);
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
    options.prepareSession();
    const created = new BrowserWindow({
      ...openBounds(),
      show: false,
      title: options.title(),
      // Windows and Linux have no menu bar (Alt reveals nothing); macOS keeps its small menu.
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
