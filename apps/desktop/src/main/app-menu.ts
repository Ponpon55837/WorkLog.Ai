import { BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";
import { buildAppMenuTemplate, type AppMenuItem, type ShellMessages } from "@work-intelligence/desktop-core";

function toElectron(item: AppMenuItem): MenuItemConstructorOptions {
  if (item.type === "separator") return { type: "separator" };
  return {
    ...(item.role === undefined ? {} : { role: item.role as MenuItemConstructorOptions["role"] }),
    ...(item.label === undefined ? {} : { label: item.label }),
    ...(item.accelerator === undefined ? {} : { accelerator: item.accelerator }),
    ...(item.action === "close-window"
      ? // Closes like the window's close button; on macOS the App stays in the menu bar.
        { click: () => BrowserWindow.getFocusedWindow()?.close() }
      : {}),
    ...(item.submenu === undefined ? {} : { submenu: item.submenu.map(toElectron) }),
  };
}

// Call before the first window exists; it never touches `session.defaultSession`.
export function applyAppMenu(platform: NodeJS.Platform, messages: ShellMessages): void {
  const template = buildAppMenuTemplate(platform, messages);
  Menu.setApplicationMenu(template === null ? null : Menu.buildFromTemplate(template.map(toElectron)));
}
