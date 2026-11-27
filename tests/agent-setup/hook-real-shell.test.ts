import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commandForLauncherHook } from "../../packages/agent-setup/src/commands.js";

// Hands the Windows hook string to the real shells an Agent may use, with a launcher path holding a space and non-ASCII characters.
describe.runIf(process.platform === "win32")("the Windows hook command in real shells", () => {
  let root: string;
  let shim: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "wi-hook-shell-"));
    const directory = join(root, "Work Intelligence 測試", "bin");
    mkdirSync(directory, { recursive: true });
    shim = join(directory, "work-intelligence-launcher.cmd");
    writeFileSync(shim, "@echo off\r\necho LAUNCHED %*\r\n");
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const action = "claude-finalize-reminder";

  it("runs under cmd.exe, the shell Windows hooks go through by default", () => {
    const command = commandForLauncherHook(shim, action, "win32");
    const result = spawnSync("cmd.exe", ["/d", "/s", "/c", `"${command}"`], {
      encoding: "utf8",
      windowsVerbatimArguments: true,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`LAUNCHED ${action}`);
  });

  it("runs under PowerShell when the call operator leads it, and not without one", () => {
    const command = commandForLauncherHook(shim, action, "win32");
    const run = (text: string) =>
      spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", text], { encoding: "utf8" });
    // A quoted path followed by an argument is not a command to PowerShell: the Agent has to put `& ` in front (M-13).
    expect(run(command).status).not.toBe(0);
    const called = run(`& ${command}`);
    expect(called.status).toBe(0);
    expect(called.stdout).toContain(`LAUNCHED ${action}`);
  });
});
