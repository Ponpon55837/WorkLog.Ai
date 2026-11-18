import { Menu, nativeImage, Notification, Tray, type NativeImage } from "electron";
import {
  buildTrayMenu,
  setupMessages,
  trayBackgroundHint,
  trayTooltip,
  updateMessages,
  type TrayMenuItem,
} from "@work-intelligence/desktop-core";
import type { Logger } from "./log.js";
import type { ShellState } from "./state.js";

export interface ShellTray {
  /** Creates the tray icon; a desktop without a notification area is logged and the App goes on without one. */
  create(): void;
  /** Whether a tray icon exists. */
  readonly present: boolean;
  /** The items the menu shows now; the native menu is built from this very list (a smoke test reads it). */
  menu(): readonly TrayMenuItem[];
  /** Does what a click on the item with this id does (a smoke test cannot click the native tray). */
  activate(id: string): void;
}

export interface ShellTrayOptions {
  readonly state: ShellState;
  /** Full-colour icon: the dark rounded square, legible on light and dark taskbars. */
  readonly iconFile: string;
  /** Black-on-transparent glyph the macOS menu bar tints itself (a `@2x` file beside it serves Retina displays). */
  readonly templateIconFile: string;
  readonly backendRunning: () => boolean;
  readonly openDashboard: () => void;
  /** Clicking the "old login service" notification: the Status tab. */
  readonly openStatus: () => void;
  /** "Open Work Intelligence…": the window, on the blocking tab if any, else the remembered or default tab. */
  readonly openApp: () => void;
  /** "完成首次設定…": the Setup tab. */
  readonly openSetup: () => void;
  /** 「檢查更新…」: the Settings tab, with the check started. */
  readonly openUpdateCheck: () => void;
  readonly requestQuit: () => void;
  readonly log: Logger;
  /** The old login service is enabled on the App's database and a login start was held back: the tray says so. */
  readonly legacy?: { readonly heldAtLogin: () => boolean };
}

export function createShellTray(options: ShellTrayOptions): ShellTray {
  const { state } = options;
  let tray: Tray | null = null;
  let notified = false;

  function trayImage(): NativeImage {
    if (process.platform !== "darwin") return nativeImage.createFromPath(options.iconFile);
    const image = nativeImage.createFromPath(options.templateIconFile);
    image.setTemplateImage(true);
    return image;
  }

  /** One notification per login (this run); a desktop that cannot show one is logged and the tray carries on. */
  function notifyHeldOnce(message: string): void {
    if (notified) return;
    notified = true;
    try {
      if (!Notification.isSupported()) {
        options.log("[shell] legacy notification unavailable");
        return;
      }
      const notification = new Notification({ title: setupMessages(state.locale).legacyHeading, body: message });
      notification.on("click", () => options.openStatus());
      notification.show();
    } catch (error) {
      options.log(`[shell] legacy notification failed: ${error instanceof Error ? error.name : "unknown"}`);
    }
  }

  /** The menu for the state as it is now. */
  function items(): TrayMenuItem[] {
    const setup = setupMessages(state.locale);
    const held = options.legacy?.heldAtLogin() === true;
    return buildTrayMenu({
      messages: state.messages(),
      owner: state.owner,
      backendRunning: options.backendRunning(),
      setup: { messages: setup, needsSetup: state.needsSetup },
      update: updateMessages(state.locale),
      ...(held ? { legacyHeld: setup } : {}),
    });
  }

  function activate(id: string): void {
    if (id === "open-dashboard") options.openDashboard();
    else if (id === "open-app") options.openApp();
    else if (id === "complete-setup") options.openSetup();
    else if (id === "check-updates") options.openUpdateCheck();
    else if (id === "quit") options.requestQuit();
  }

  function refresh(): void {
    if (!tray) return;
    if (options.legacy?.heldAtLogin() === true) notifyHeldOnce(setupMessages(state.locale).trayLegacyStatus);
    tray.setToolTip(trayTooltip(state.owner, options.backendRunning(), state.messages()));
    tray.setContextMenu(
      Menu.buildFromTemplate(
        items().map((item) =>
          item.id === "separator"
            ? { type: "separator" as const }
            : { label: item.label, enabled: item.enabled, click: () => activate(item.id) },
        ),
      ),
    );
  }

  function create(): void {
    try {
      tray = new Tray(trayImage());
      state.onChange(refresh);
      refresh();
      if (state.launchMode === "background") {
        options.log(`[shell] ${trayBackgroundHint(process.platform, state.messages())}`);
      }
    } catch (error) {
      options.log(`[shell] tray unavailable: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  return {
    create,
    get present() {
      return tray !== null;
    },
    menu: items,
    activate,
  };
}
