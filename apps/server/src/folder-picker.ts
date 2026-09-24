import { execFile } from "node:child_process";
import { posix, win32 } from "node:path";
import type { FolderPickResult } from "@work-intelligence/core";

export type CommandRunner = (file: string, args: readonly string[], timeoutMs: number) => Promise<CommandResult>;

export type CommandResult = { code: number; stdout: string; stderr: string };

const PICK_TIMEOUT_MS = 5 * 60 * 1000;
const PROMPT = "選擇要加入 Work Intelligence 的專案資料夾";

/** execFile without a shell: the dialog commands are fixed strings and never include request input. */
export const runCommand: CommandRunner = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: timeoutMs, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") {
        // Not an exit status: the program is missing (ENOENT) or was killed by the timeout.
        reject(error);
        return;
      }
      resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
    });
  });

type DialogCommand = { file: string; args: string[]; isCancel: (result: CommandResult) => boolean };

/** Native folder dialogs per platform, in the order to try them. */
export function folderDialogCommands(platform: NodeJS.Platform): DialogCommand[] {
  if (platform === "darwin") {
    return [
      {
        file: "osascript",
        // `activate` brings the dialog in front of the browser. Cancel and a missing GUI both exit
        // with 1; only a cancel reports error -128 ("User canceled").
        args: ["-e", "activate", "-e", `POSIX path of (choose folder with prompt "${PROMPT}")`],
        isCancel: (result) => result.code === 1 && result.stderr.includes("-128"),
      },
    ];
  }
  if (platform === "win32") {
    const script = [
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      "Add-Type -AssemblyName System.Windows.Forms",
      "$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      `$dialog.Description = '${PROMPT}'`,
      // Exit 2 on cancel so it is not confused with PowerShell's own failure status 1.
      "if ($dialog.ShowDialog($owner) -eq 'OK') { $dialog.SelectedPath } else { exit 2 }",
    ].join("; ");
    return [
      {
        file: "powershell.exe",
        args: ["-NoProfile", "-STA", "-Command", script],
        isCancel: (result) => result.code === 2,
      },
    ];
  }
  return [
    // Both exit with 1 on cancel and use other codes for errors (e.g. no display).
    {
      file: "zenity",
      args: ["--file-selection", "--directory", `--title=${PROMPT}`],
      isCancel: (result) => result.code === 1,
    },
    {
      file: "kdialog",
      args: ["--getexistingdirectory", ".", "--title", PROMPT],
      isCancel: (result) => result.code === 1,
    },
  ];
}

function trimFolderPath(value: string): string {
  const path = value.replace(/\r?\n$/, "").trim();
  // macOS returns folders with a trailing slash; keep a bare root like "/" or "C:\" intact.
  return path.length > 1 && !/^[A-Za-z]:\\$/.test(path) ? path.replace(/[\\/]+$/, "") : path;
}

/**
 * Shows the operating system's folder dialog on the machine running the API server (which is the
 * user's own computer: the API only accepts loopback requests) and returns the chosen absolute path.
 */
export function createFolderPicker(
  platform: NodeJS.Platform = process.platform,
  run: CommandRunner = runCommand,
): () => Promise<FolderPickResult> {
  let busy = false;
  return async () => {
    if (busy) {
      return { outcome: "folder_pick_busy" };
    }
    busy = true;
    try {
      for (const command of folderDialogCommands(platform)) {
        let result: CommandResult;
        try {
          result = await run(command.file, command.args, PICK_TIMEOUT_MS);
        } catch {
          continue;
        }
        if (result.code === 0 && result.stdout.trim()) {
          const path = trimFolderPath(result.stdout);
          const name = (platform === "win32" ? win32 : posix).basename(path);
          return { outcome: "folder_picked", path, name: name || path };
        }
        if (command.isCancel(result) || result.code === 0) {
          return { outcome: "folder_pick_cancelled" };
        }
      }
      return {
        outcome: "folder_pick_unavailable",
        reason: "No folder dialog is available here; type the path instead.",
      };
    } finally {
      busy = false;
    }
  };
}
