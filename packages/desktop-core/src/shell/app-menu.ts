import { formatMessage, type ShellMessages } from "./i18n.js";

export interface AppMenuItem {
  readonly role?: string;
  readonly label?: string;
  readonly accelerator?: string;
  readonly action?: "close-window";
  readonly type?: "separator";
  readonly submenu?: readonly AppMenuItem[];
}

// Windows and Linux have no menu bar; macOS needs a minimal menu for the system shortcuts to work.
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
