import { Menu, nativeImage, Notification, Tray, type NativeImage } from "electron";
import {
  buildTrayMenu,
  setupMessages,
  trayBackgroundHint,
  trayTooltip,
  updateMessages,
} from "@work-intelligence/desktop-core";
import type { Logger } from "./log.js";
import type { ShellState } from "./state.js";

export interface ShellTray {
  /** Creates the tray icon; a desktop without a notification area is logged and the App goes on without one. */
  create(): void;
  /** Whether a tray icon exists. */
  readonly present: boolean;
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

  function refresh(): void {
    if (!tray) return;
    const text = state.messages();
    const setup = setupMessages(state.locale);
    const held = options.legacy?.heldAtLogin() === true;
    if (held) notifyHeldOnce(setup.trayLegacyStatus);
    const running = options.backendRunning();
    const items = buildTrayMenu({
      messages: text,
      owner: state.owner,
      backendRunning: running,
      setup: { messages: setup, needsSetup: state.needsSetup },
      update: updateMessages(state.locale),
      ...(held ? { legacyHeld: setup } : {}),
    });
    tray.setToolTip(trayTooltip(state.owner, running, text));
    tray.setContextMenu(
      Menu.buildFromTemplate(
        items.map((item) => {
          if (item.id === "separator") return { type: "separator" as const };
          return {
            label: item.label,
            enabled: item.enabled,
            click: () => {
              if (item.id === "open-dashboard") options.openDashboard();
              else if (item.id === "open-app") options.openApp();
              else if (item.id === "complete-setup") options.openSetup();
              else if (item.id === "check-updates") options.openUpdateCheck();
              else if (item.id === "quit") options.requestQuit();
            },
          };
        }),
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
  };
}
