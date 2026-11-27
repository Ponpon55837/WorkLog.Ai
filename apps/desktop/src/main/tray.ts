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
  create(): void;
  readonly present: boolean;
  menu(): readonly TrayMenuItem[];
  activate(id: string): void;
}

export interface ShellTrayOptions {
  readonly state: ShellState;
  readonly iconFile: string;
  readonly templateIconFile: string;
  readonly backendRunning: () => boolean;
  readonly openDashboard: () => void;
  readonly openStatus: () => void;
  readonly openApp: () => void;
  readonly openSetup: () => void;
  readonly openUpdateCheck: () => void;
  readonly requestQuit: () => void;
  readonly log: Logger;
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
