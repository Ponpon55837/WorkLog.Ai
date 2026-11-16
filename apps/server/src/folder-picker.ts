import { execFile } from "node:child_process";
import { posix, win32 } from "node:path";
import type { FolderPickResult } from "@work-intelligence/core";

export type CommandRunner = (file: string, args: readonly string[], timeoutMs: number) => Promise<CommandResult>;

export type CommandResult = { code: number; stdout: string; stderr: string };

const PICK_TIMEOUT_MS = 5 * 60 * 1000;
const PROMPT = "選擇 Work Intelligence 專案資料夾";

/**
 * C# compiled by `Add-Type`: the Windows Vista+ common item dialog (`IFileOpenDialog`) in folder mode,
 * the same dialog File Explorer and modern apps use. The title is a parameter, never part of the source.
 * The interface lists every method in vtable order (IModalWindow, IFileDialog, IFileOpenDialog); a wrong
 * order calls the wrong method, so unused methods stay declared. The interface is IFileOpenDialog (IID
 * D57C7288-...), which flattens the inherited IFileDialog methods and appends GetResults/GetSelectedItems.
 *
 * `Add-Type` compiles this source on every pick (about 1 second). That is accepted on purpose: caching a compiled
 * DLL on disk would add a file that could be planted or replaced (DLL planting) and would need maintenance.
 */
const FOLDER_DIALOG_CSHARP = [
  "using System;",
  "using System.Runtime.InteropServices;",
  "namespace WorkLog {",
  '  [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]',
  "  class FileOpenDialogClass { }",
  '  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
  "  interface IShellItem {",
  "    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);",
  "    void GetParent(out IShellItem ppsi);",
  "    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);",
  "    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);",
  "    void Compare(IShellItem psi, uint hint, out int piOrder);",
  "  }",
  '  [ComImport, Guid("D57C7288-D4AD-4768-BE02-9D969532D960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
  "  interface IFileOpenDialog {",
  "    [PreserveSig] int Show(IntPtr hwndOwner);",
  "    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);",
  "    void SetFileTypeIndex(uint iFileType);",
  "    void GetFileTypeIndex(out uint piFileType);",
  "    void Advise(IntPtr pfde, out uint pdwCookie);",
  "    void Unadvise(uint dwCookie);",
  "    void SetOptions(uint fos);",
  "    void GetOptions(out uint pfos);",
  "    void SetDefaultFolder(IShellItem psi);",
  "    void SetFolder(IShellItem psi);",
  "    void GetFolder(out IShellItem ppsi);",
  "    void GetCurrentSelection(out IShellItem ppsi);",
  "    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);",
  "    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);",
  "    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);",
  "    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);",
  "    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);",
  "    void GetResult(out IShellItem ppsi);",
  "    void AddPlace(IShellItem psi, int fdap);",
  "    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);",
  "    void Close(int hr);",
  "    void SetClientGuid(ref Guid guid);",
  "    void ClearClientData();",
  "    void SetFilter(IntPtr pFilter);",
  "    void GetResults(out IntPtr ppenum);",
  "    void GetSelectedItems(out IntPtr ppsai);",
  "  }",
  "  public static class FolderPicker {",
  // Set right before the dialog is shown: after that point a failure must not open a second (legacy) dialog.
  "    public static bool Shown = false;",
  '    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);',
  '    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();',
  // FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST.
  "    const uint FolderOptions = 0x20 | 0x40 | 0x800;",
  "    const uint SigdnFileSysPath = 0x80058000;",
  // HRESULT_FROM_WIN32(ERROR_CANCELLED): the user closed the dialog.
  "    const int CancelledHResult = unchecked((int)0x800704C7);",
  "    // Per-monitor v2 (-4) on Windows 10 1703+, system DPI awareness elsewhere. Failure only means blurry scaling.",
  "    public static void EnableDpiAwareness() {",
  "      try {",
  "        if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) { SetProcessDPIAware(); }",
  "      } catch (EntryPointNotFoundException) {",
  "        try { SetProcessDPIAware(); } catch (Exception) { }",
  "      } catch (Exception) { }",
  "    }",
  "    // Returns the chosen folder path, or null when the user cancels.",
  "    public static string Pick(string title, IntPtr owner) {",
  "      IFileOpenDialog dialog = (IFileOpenDialog)new FileOpenDialogClass();",
  "      try {",
  "        uint options;",
  "        dialog.GetOptions(out options);",
  "        dialog.SetOptions(options | FolderOptions);",
  "        dialog.SetTitle(title);",
  "        Shown = true;",
  "        int hr = dialog.Show(owner);",
  "        if (hr == CancelledHResult) { return null; }",
  "        if (hr != 0) { Marshal.ThrowExceptionForHR(hr); }",
  "        IShellItem item;",
  "        dialog.GetResult(out item);",
  "        try {",
  "          string path;",
  "          item.GetDisplayName(SigdnFileSysPath, out path);",
  "          return path;",
  "        } finally { Marshal.ReleaseComObject(item); }",
  "      } finally { Marshal.ReleaseComObject(dialog); }",
  "    }",
  "  }",
  "}",
].join("\n");

/** PowerShell single-quoted string literal: only the quote itself needs escaping. */
function powerShellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Fixed PowerShell script for the Windows dialog. Exit 0 prints the path, exit 2 means cancel and any
 * other status (3 for a failure after the dialog was shown) is a failure. Nothing in it comes from a request.
 */
function windowsPickerScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    // Paths may contain non-ASCII characters; Node decodes stdout as UTF-8.
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "Add-Type -AssemblyName System.Windows.Forms",
    `$title = ${powerShellQuote(PROMPT)}`,
    `$source = @'\n${FOLDER_DIALOG_CSHARP}\n'@`,
    // A tiny top-most window owns the dialog so it opens in front of the browser.
    "function New-Owner {",
    "  $owner = New-Object System.Windows.Forms.Form",
    "  $owner.TopMost = $true",
    "  $owner.ShowInTaskbar = $false",
    "  $owner.FormBorderStyle = 'None'",
    "  $owner.StartPosition = 'CenterScreen'",
    "  $owner.Size = New-Object System.Drawing.Size(1, 1)",
    "  $owner.Opacity = 0",
    "  $owner.Show()",
    "  $owner.Activate()",
    "  $owner",
    "}",
    // Modern dialog: returns the path, or $null when cancelled. Throws on any other failure.
    "function Show-ModernDialog {",
    "  Add-Type -TypeDefinition $source",
    "  [WorkLog.FolderPicker]::EnableDpiAwareness()",
    "  $owner = New-Owner",
    "  try { [WorkLog.FolderPicker]::Pick($title, $owner.Handle) } finally { $owner.Dispose() }",
    "}",
    // Fallback for machines where the COM dialog cannot be used: the classic tree dialog.
    "function Show-LegacyDialog {",
    "  [System.Windows.Forms.Application]::EnableVisualStyles()",
    "  $owner = New-Owner",
    "  try {",
    "    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "    $dialog.Description = $title",
    "    if ($dialog.ShowDialog($owner) -eq 'OK') { $dialog.SelectedPath }",
    "  } finally { $owner.Dispose() }",
    "}",
    "$path = $null",
    "$shown = $false",
    // Fall back only when the modern dialog could not be shown. Once it was shown, a failure is reported (exit 3)
    // instead of opening a second picker and losing the user's choice. Diagnostics go to stderr, never stdout.
    "try { $path = Show-ModernDialog; $shown = $true } catch {",
    "  $modernError = $_",
    "  if (('WorkLog.FolderPicker' -as [type]) -and [WorkLog.FolderPicker]::Shown) {",
    '    [Console]::Error.WriteLine("folder dialog failed after it was shown: $modernError")',
    "    exit 3",
    "  }",
    '  [Console]::Error.WriteLine("modern folder dialog unavailable, using the classic dialog: $modernError")',
    "}",
    "if (-not $shown) { $path = Show-LegacyDialog }",
    // Exit 2 on cancel so it is not confused with PowerShell's own failure status 1.
    "if ($path) { Write-Output $path } else { exit 2 }",
  ].join("\n");
}

/** -EncodedCommand takes base64 UTF-16LE, which avoids Windows argv quoting of a multi-line script. */
const WINDOWS_PICKER_ENCODED_SCRIPT = Buffer.from(windowsPickerScript(), "utf16le").toString("base64");

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
    return [
      {
        file: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", WINDOWS_PICKER_ENCODED_SCRIPT],
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
