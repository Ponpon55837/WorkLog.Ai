import { describe, expect, it } from "vitest";
import {
  createFolderPicker,
  folderDialogCommands,
  type CommandResult,
  type CommandRunner,
} from "../../apps/server/src/folder-picker.js";

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
      runner({ "powershell.exe": { code: 0, stdout: "C:\\Users\\me\\apiary\r\n", stderr: "" } }),
    );
    expect(await pick()).toEqual({ outcome: "folder_picked", path: "C:\\Users\\me\\apiary", name: "apiary" });
    const root = createFolderPicker("win32", runner({ "powershell.exe": { code: 0, stdout: "D:\\\r\n", stderr: "" } }));
    expect(await root()).toMatchObject({ path: "D:\\" });
    const cancelled = createFolderPicker("win32", runner({ "powershell.exe": { code: 2, stdout: "", stderr: "" } }));
    expect(await cancelled()).toEqual({ outcome: "folder_pick_cancelled" });
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
