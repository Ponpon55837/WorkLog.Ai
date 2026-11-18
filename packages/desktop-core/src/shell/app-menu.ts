import { formatMessage, type ShellMessages } from "./i18n.js";

/** One entry of the application menu as data; the Electron layer turns it into a native menu. */
export interface AppMenuItem {
  /** An Electron role, which brings its own behaviour and (where the OS has them) its own localised label. */
  readonly role?: string;
  /** A label this App translates itself (only where there is no role, or a role has no label of its own). */
  readonly label?: string;
  readonly accelerator?: string;
  /** What a click does when it is not a role: `close-window` closes the window and never quits the App. */
  readonly action?: "close-window";
  readonly type?: "separator";
  readonly submenu?: readonly AppMenuItem[];
}

/**
 * The application menu. Windows and Linux have none (`null`: no menu bar, so Alt reveals nothing and there is no
 * reload or developer tools shortcut). macOS needs a minimal one for the system shortcuts to work: App, Edit and
 * Window; no View menu. Cmd+W closes the window and the App keeps running in the menu bar, as the close button does.
 */
export function buildAppMenuTemplate(
  platform: NodeJS.Platform,
  messages: ShellMessages,
): readonly AppMenuItem[] | null {
  if (platform !== "darwin") return null;
  return [
    {
      label: messages.appName,
      submenu: [
        { role: "about", label: formatMessage(messages.menuAbout, { name: messages.appName }) },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: messages.menuEdit,
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: messages.menuWindow,
      submenu: [
        { role: "minimize" },
        { action: "close-window", label: messages.menuCloseWindow, accelerator: "CmdOrCtrl+W" },
      ],
    },
  ];
}
