import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_WINDOWS_SYSTEM_ROOT,
  windowsCommandShell,
  windowsPowerShell,
  windowsSystem32Directory,
  windowsSystemRoot,
  windowsSystemTool,
} from "../../packages/shared/src/windows-system-tool.js";
import { currentUserSid } from "../../scripts/desktop-runtime-spike/secure-directory.mjs";

const REAL_SID = /^S-1-5-21(?:-\d+)+$/;
const WHOAMI_ARGUMENTS = ["/user", "/fo", "csv", "/nh"];
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A directory that holds a fake `whoami.exe` (a copy of node.exe, which rejects `/user` as Git's coreutils one does). */
function directoryWithFakeWhoami(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "wi-fake-whoami-"));
  directories.push(directory);
  copyFileSync(process.execPath, path.join(directory, "whoami.exe"));
  return directory;
}

describe("windowsSystemRoot", () => {
  it("uses SystemRoot when it is an absolute Windows path", () => {
    expect(windowsSystemRoot({ SystemRoot: "D:\\Windows" })).toBe("D:\\Windows");
  });

  it("reads the variable name case-insensitively, as a plain object does not", () => {
    expect(windowsSystemRoot({ SYSTEMROOT: "E:\\Win" })).toBe("E:\\Win");
    expect(windowsSystemRoot({ systemroot: "E:\\Win" })).toBe("E:\\Win");
  });

  it.each([{}, { SystemRoot: "" }, { SystemRoot: undefined }, { SystemRoot: "Windows" }, { SystemRoot: "\\Windows" }])(
    "falls back to C:\\Windows for %j",
    (env) => {
      expect(windowsSystemRoot(env)).toBe(DEFAULT_WINDOWS_SYSTEM_ROOT);
    },
  );

  it("ignores windir and PATH, which a caller may control", () => {
    expect(windowsSystemRoot({ windir: "D:\\Other", Path: "C:\\Git\\usr\\bin" })).toBe("C:\\Windows");
  });
});

describe("windowsSystemTool", () => {
  const env = { SystemRoot: "D:\\Windows" };

  it("returns an absolute Windows path under System32, whatever the host platform", () => {
    expect(windowsSystemTool("whoami.exe", env)).toBe("D:\\Windows\\System32\\whoami.exe");
    expect(path.win32.isAbsolute(windowsSystemTool("icacls.exe", env))).toBe(true);
    expect(windowsSystem32Directory(env)).toBe("D:\\Windows\\System32");
  });

  it("tolerates a trailing separator in SystemRoot", () => {
    expect(windowsSystemTool("schtasks.exe", { SystemRoot: "D:\\Windows\\" })).toBe(
      "D:\\Windows\\System32\\schtasks.exe",
    );
  });

  it("uses the default root without SystemRoot", () => {
    expect(windowsSystemTool("taskkill.exe", {})).toBe("C:\\Windows\\System32\\taskkill.exe");
  });

  it.each(["", "..\\evil.exe", "C:\\Git\\usr\\bin\\whoami.exe", "a/b.exe", ".hidden", "who ami.exe"])(
    "refuses %j, which is not a plain file name",
    (name) => {
      expect(() => windowsSystemTool(name, env)).toThrow(RangeError);
    },
  );

  it("finds PowerShell 5.1 under System32\\WindowsPowerShell\\v1.0", () => {
    expect(windowsPowerShell(env)).toBe("D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  });

  it("always names System32\\cmd.exe and ignores ComSpec", () => {
    expect(windowsCommandShell({ ...env, ComSpec: "C:\\Git\\usr\\bin\\cmd.exe" })).toBe(
      "D:\\Windows\\System32\\cmd.exe",
    );
    expect(windowsCommandShell({})).toBe("C:\\Windows\\System32\\cmd.exe");
  });
});

describe.skipIf(process.platform !== "win32")("on Windows with a look-alike whoami.exe first on PATH", () => {
  it("a bare name runs the look-alike, the resolved path runs the real tool", () => {
    const fake = directoryWithFakeWhoami();
    const env = { ...process.env, PATH: `${fake};${process.env.PATH ?? ""}` };
    expect(() => execFileSync("whoami.exe", WHOAMI_ARGUMENTS, { env, encoding: "utf8", stdio: "pipe" })).toThrow();
    const output = execFileSync(windowsSystemTool("whoami.exe", env), WHOAMI_ARGUMENTS, { env, encoding: "utf8" });
    expect(output.trim()).toMatch(/,"S-1-5-21(?:-\d+)+"$/);
  });

  it("the spike helper reads the real SID", () => {
    const fake = directoryWithFakeWhoami();
    const original = process.env.PATH;
    process.env.PATH = `${fake};${original ?? ""}`;
    try {
      expect(currentUserSid()).toMatch(REAL_SID);
    } finally {
      process.env.PATH = original;
    }
  });
});
