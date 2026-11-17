import { Menu, nativeImage, Tray, type NativeImage } from "electron";
import { buildTrayMenu, trayBackgroundHint, trayTooltip } from "@work-intelligence/desktop-core";
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
  readonly openRepairWindow: () => void;
  readonly requestQuit: () => void;
  readonly log: Logger;
}

export function createShellTray(options: ShellTrayOptions): ShellTray {
  const { state } = options;
  let tray: Tray | null = null;

  function trayImage(): NativeImage {
    if (process.platform !== "darwin") return nativeImage.createFromPath(options.iconFile);
    const image = nativeImage.createFromPath(options.templateIconFile);
    image.setTemplateImage(true);
    return image;
  }

  function refresh(): void {
    if (!tray) return;
    const text = state.messages();
    const running = options.backendRunning();
    const items = buildTrayMenu({ messages: text, owner: state.owner, backendRunning: running });
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
              else if (item.id === "repair") options.openRepairWindow();
              else options.requestQuit();
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
