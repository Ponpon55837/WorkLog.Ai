import { BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";
import { buildAppMenuTemplate, type AppMenuItem, type ShellMessages } from "@work-intelligence/desktop-core";

function toElectron(item: AppMenuItem): MenuItemConstructorOptions {
  if (item.type === "separator") return { type: "separator" };
  return {
    ...(item.role === undefined ? {} : { role: item.role as MenuItemConstructorOptions["role"] }),
    ...(item.label === undefined ? {} : { label: item.label }),
    ...(item.accelerator === undefined ? {} : { accelerator: item.accelerator }),
    ...(item.action === "close-window"
      ? // Closes the window like its close button; the App stays in the menu bar (`window-all-closed` does not quit).
        { click: () => BrowserWindow.getFocusedWindow()?.close() }
      : {}),
    ...(item.submenu === undefined ? {} : { submenu: item.submenu.map(toElectron) }),
  };
}

/**
 * Sets the application menu: none on Windows and Linux (so Alt reveals nothing), a minimal one on macOS. Call it before
 * the first window exists. It never touches `session.defaultSession` (see `createSessionPolicy`).
 */
export function applyAppMenu(platform: NodeJS.Platform, messages: ShellMessages): void {
  const template = buildAppMenuTemplate(platform, messages);
  Menu.setApplicationMenu(template === null ? null : Menu.buildFromTemplate(template.map(toElectron)));
}
