import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createFolderPicker,
  folderDialogCommands,
  type CommandResult,
  type CommandRunner,
} from "../../apps/server/src/folder-picker.js";

const WINDOWS_ENV = { SystemRoot: "C:\\Windows" };
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

function runner(results: Record<string, CommandResult | "missing">): CommandRunner & { calls: string[] } {
  const calls: string[] = [];
  const run = async (file: string): Promise<CommandResult> => {
    calls.push(file);
    const result = results[file];
    if (!result || result === "missing") {
      throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" });
    }
    return result;
  };
  return Object.assign(run, { calls });
}

function windowsScript(): string {
  const [command] = folderDialogCommands("win32", WINDOWS_ENV);
  return Buffer.from(command?.args[4] ?? "", "base64").toString("utf16le");
}

describe("Windows folder dialog script", () => {
  it("runs powershell.exe in STA mode with the script as one -EncodedCommand argument", () => {
    const commands = folderDialogCommands("win32", WINDOWS_ENV);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.file).toBe(POWERSHELL);
    expect(commands[0]?.args.slice(0, 4)).toEqual(["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand"]);
    expect(commands[0]?.args).toHaveLength(5);
    const encoded = commands[0]?.args[4] ?? "";
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from(Buffer.from(windowsScript(), "utf16le").toString("base64"), "base64").toString("utf16le")).toBe(
      windowsScript(),
    );
    expect(Buffer.from(encoded, "base64").toString("base64")).toBe(encoded);
  });

  it("uses the modern IFileOpenDialog in folder mode with the documented COM identifiers", () => {
    const script = windowsScript();
    expect(script).toContain("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7");
    expect(script).toContain("D57C7288-D4AD-4768-BE02-9D969532D960");
    expect(script).not.toContain("42F85136-DB7E-439C-85F1-E4075D135FC8");
    expect(script).toContain("43826D1E-E718-42EE-BC55-A1E261C37BFE");
    // FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST, added to the dialog's current options.
    expect(script).toContain("0x20 | 0x40 | 0x800");
    expect(script).toContain("options | FolderOptions");
    expect(script).toContain("0x80058000");
  });

  it("declares the dialog methods in vtable order", () => {
    const script = windowsScript();
    const order = [
      "Show(",
      "SetFileTypes",
      "SetFileTypeIndex",
      "GetFileTypeIndex",
      "Advise",
      "Unadvise",
      "SetOptions",
      "GetOptions",
      "SetDefaultFolder",
      "SetFolder",
      "GetFolder",
      "GetCurrentSelection",
      "SetFileName",
      "GetFileName",
      "SetTitle",
      "SetOkButtonLabel",
      "SetFileNameLabel",
      "GetResult",
      "AddPlace",
      "SetDefaultExtension",
      "Close",
      "SetClientGuid",
      "ClearClientData",
      "SetFilter",
      "GetResults",
      "GetSelectedItems",
    ].map((name) => script.indexOf(`${name.startsWith("Show") ? "int " : "void "}${name}`));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("maps a cancelled dialog to exit 2 and keeps PreserveSig to see the cancel HRESULT", () => {
    const script = windowsScript();
    expect(script).toContain("[PreserveSig] int Show(IntPtr hwndOwner)");
    expect(script).toContain("0x800704C7");
    expect(script).toContain("else { exit 2 }");
  });

  it("opens in front of the browser, scales with the monitor and releases its objects", () => {
    const script = windowsScript();
    expect(script).toContain("$owner.TopMost = $true");
    expect(script).toContain("$owner.Dispose()");
    expect(script).toContain("SetProcessDpiAwarenessContext(new IntPtr(-4))");
    expect(script).toContain("SetProcessDPIAware()");
    expect(script).toContain("Marshal.ReleaseComObject(dialog)");
    expect(script).toContain("Marshal.ReleaseComObject(item)");
  });

  it("falls back to the classic dialog with visual styles when the COM path throws", () => {
    const script = windowsScript();
    expect(script).toContain("System.Windows.Forms.FolderBrowserDialog");
    expect(script).toContain("[System.Windows.Forms.Application]::EnableVisualStyles()");
    expect(script.indexOf("Show-ModernDialog; $shown")).toBeLessThan(script.indexOf("$path = Show-LegacyDialog"));
  });

  it("falls back only before the dialog was shown; a later failure exits 3 without a second picker", () => {
    const script = windowsScript();
    const setShown = script.indexOf("Shown = true;");
    expect(setShown).toBeGreaterThan(-1);
    expect(setShown).toBeLessThan(script.indexOf("dialog.Show(owner)"));
    expect(script).toContain("public static bool Shown = false;");
    const guard = script.indexOf("[WorkLog.FolderPicker]::Shown");
    expect(guard).toBeGreaterThan(script.indexOf("catch {"));
    expect(script.indexOf("exit 3", guard)).toBeGreaterThan(guard);
    expect(script.indexOf("exit 3")).toBeLessThan(script.indexOf("$path = Show-LegacyDialog"));
  });

  it("writes fallback and failure reasons to stderr, not stdout", () => {
    const script = windowsScript();
    expect(script).toContain('[Console]::Error.WriteLine("modern folder dialog unavailable');
    expect(script).toContain('[Console]::Error.WriteLine("folder dialog failed after it was shown');
    expect(script).not.toMatch(/Write-(Output|Host)[^\n]*(unavailable|failed)/);
  });

  it("writes UTF-8 and passes the Chinese title as a single-quoted PowerShell string", () => {
    const script = windowsScript();
    expect(script).toContain("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8");
    expect(script).toContain("$title = '選擇 Work Intelligence 專案資料夾'");
    // The title is a parameter of Pick, never embedded in the C# source.
    expect(script).toContain("Pick($title, $owner.Handle)");
    expect(script).toContain("dialog.SetTitle(title)");
  });

  it("is a fixed script without interpolated or undefined values", () => {
    expect(windowsScript()).not.toMatch(/\$\{|undefined|\[object/);
  });

  it("is passed to execFile without a shell", async () => {
    const source = await readFile(new URL("../../apps/server/src/folder-picker.ts", import.meta.url), "utf8");
    expect(source).toMatch(/execFile\(file, \[\.\.\.args\]/);
    expect(source).not.toMatch(/shell:\s*true|exec\(|execSync/);
  });
});

describe("native folder picker", () => {
  it("returns the chosen macOS folder without its trailing slash", async () => {
    const pick = createFolderPicker(
      "darwin",
      runner({ osascript: { code: 0, stdout: "/Users/me/code/apiary/\n", stderr: "" } }),
    );
    expect(await pick()).toEqual({ outcome: "folder_picked", path: "/Users/me/code/apiary", name: "apiary" });
  });

  it("tells a cancel apart from a machine without a desktop session", async () => {
    const cancelled = createFolderPicker(
      "darwin",
      runner({ osascript: { code: 1, stdout: "", stderr: "execution error: User canceled. (-128)" } }),
    );
    expect(await cancelled()).toEqual({ outcome: "folder_pick_cancelled" });
    const headless = createFolderPicker(
      "darwin",
      runner({ osascript: { code: 1, stdout: "", stderr: "execution error: No user interaction allowed. (-1713)" } }),
    );
    expect(await headless()).toMatchObject({ outcome: "folder_pick_unavailable" });
  });

  it("names Windows folders with Windows path rules and keeps a drive root intact", async () => {
    const pick = createFolderPicker(
      "win32",
      runner({ [POWERSHELL]: { code: 0, stdout: "C:\\Users\\me\\apiary\r\n", stderr: "" } }),
      WINDOWS_ENV,
    );
    expect(await pick()).toEqual({ outcome: "folder_picked", path: "C:\\Users\\me\\apiary", name: "apiary" });
    const root = createFolderPicker(
      "win32",
      runner({ [POWERSHELL]: { code: 0, stdout: "D:\\\r\n", stderr: "" } }),
      WINDOWS_ENV,
    );
    expect(await root()).toMatchObject({ path: "D:\\" });
    const cancelled = createFolderPicker(
      "win32",
      runner({ [POWERSHELL]: { code: 2, stdout: "", stderr: "" } }),
      WINDOWS_ENV,
    );
    expect(await cancelled()).toEqual({ outcome: "folder_pick_cancelled" });
  });

  it("reads a Windows path with a UTF-8 byte order mark, Chinese characters and CRLF", async () => {
    const pick = createFolderPicker(
      "win32",
      runner({ [POWERSHELL]: { code: 0, stdout: "\uFEFFD:\\工作\\專案\r\n", stderr: "" } }),
      WINDOWS_ENV,
    );
    expect(await pick()).toEqual({ outcome: "folder_picked", path: "D:\\工作\\專案", name: "專案" });
  });

  it("treats any Windows exit status other than 0 or 2 as unavailable", async () => {
    const failed = createFolderPicker(
      "win32",
      runner({ [POWERSHELL]: { code: 1, stdout: "", stderr: "Add-Type : error" } }),
      WINDOWS_ENV,
    );
    expect(await failed()).toMatchObject({ outcome: "folder_pick_unavailable" });
    const missing = createFolderPicker("win32", runner({ [POWERSHELL]: "missing" }), WINDOWS_ENV);
    expect(await missing()).toMatchObject({ outcome: "folder_pick_unavailable" });
  });

  it("falls back from zenity to kdialog on Linux and reports when neither exists", async () => {
    const run = runner({ zenity: "missing", kdialog: { code: 0, stdout: "/home/me/apiary\n", stderr: "" } });
    expect(await createFolderPicker("linux", run)()).toMatchObject({ path: "/home/me/apiary" });
    expect(run.calls).toEqual(["zenity", "kdialog"]);
    expect(await createFolderPicker("linux", runner({}))()).toMatchObject({ outcome: "folder_pick_unavailable" });
  });

  it("opens only one dialog at a time", async () => {
    let finish: (result: CommandResult) => void = () => undefined;
    const pending = new Promise<CommandResult>((resolve) => (finish = resolve));
    const pick = createFolderPicker("darwin", () => pending);
    const first = pick();
    expect(await pick()).toEqual({ outcome: "folder_pick_busy" });
    finish({ code: 0, stdout: "/tmp/apiary/\n", stderr: "" });
    expect(await first).toMatchObject({ outcome: "folder_picked" });
  });

  it("never passes request data to the dialog commands", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      for (const command of folderDialogCommands(platform)) {
        expect(command.args.join(" ")).not.toMatch(/\$\{|undefined/);
      }
    }
  });
});
