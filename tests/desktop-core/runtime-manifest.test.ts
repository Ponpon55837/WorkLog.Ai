import { describe, expect, it } from "vitest";
import {
  defaultLauncherRoot,
  launcherCommandPath,
  parseRuntimeManifest,
  renderLaunchFile,
  renderPosixShim,
  renderWindowsShim,
  RuntimeError,
  runtimeErrorCode,
  type RuntimeManifest,
} from "../../packages/desktop-core/src/runtime/index.js";
import {
  casefoldKey,
  relativePathProblem,
  symlinkTargetProblem,
} from "../../packages/desktop-core/src/runtime/paths.js";

const SHA = "a".repeat(64);

function validManifest(): Record<string, unknown> {
  return {
    manifestVersion: 1,
    runtimeId: "1.6.42-node24-linux-x64",
    runtimeKind: "node",
    executable: "node/bin/node",
    actions: { mcp: { entry: "app/mcp.js" }, serve: { entry: "app/serve.mjs", args: ["start"] } },
    files: [
      { path: "node/bin/node", size: 10, sha256: SHA },
      { path: "launcher.mjs", size: 5, sha256: SHA },
      { path: "app/mcp.js", size: 5, sha256: SHA },
      { path: "app/serve.mjs", size: 5, sha256: SHA },
    ],
    symlinks: [{ path: "Frameworks/Current", target: "A" }],
  };
}

function invalidBecause(mutate: (manifest: Record<string, unknown>) => void): string {
  const manifest = validManifest();
  mutate(manifest);
  try {
    parseRuntimeManifest(manifest);
  } catch (error) {
    expect(runtimeErrorCode(error)).toBe("RUNTIME_MANIFEST_INVALID");
    return (error as RuntimeError).message;
  }
  throw new Error("manifest was accepted");
}

describe("parseRuntimeManifest", () => {
  it("accepts a complete manifest and returns it typed", () => {
    const manifest: RuntimeManifest = parseRuntimeManifest(validManifest());
    expect(manifest.files).toHaveLength(4);
    expect(manifest.actions.serve?.args).toEqual(["start"]);
  });

  it("fails closed on anything that is not exactly version 1", () => {
    expect(invalidBecause((m) => (m.manifestVersion = 2))).toContain("manifestVersion");
    expect(invalidBecause((m) => (m.extra = true))).toContain('unknown field "extra"');
    expect(invalidBecause((m) => (m.runtimeKind = "deno"))).toContain("runtimeKind");
    expect(invalidBecause((m) => (m.runtimeId = "../x"))).toContain("runtimeId");
    expect(() => parseRuntimeManifest([])).toThrow(RuntimeError);
    expect(() => parseRuntimeManifest(null)).toThrow(/must be an object/);
  });

  it("rejects actions outside the fixed list and malformed action specs", () => {
    expect(invalidBecause((m) => (m.actions = { bash: { entry: "app/mcp.js" } }))).toContain('unknown field "bash"');
    expect(invalidBecause((m) => (m.actions = []))).toContain("actions: must be an object");
    expect(invalidBecause((m) => (m.actions = { mcp: "app/mcp.js" }))).toContain("actions.mcp: must be an object");
    expect(invalidBecause((m) => (m.actions = { mcp: { entry: "app/mcp.js", shell: true } }))).toContain(
      'unknown field "shell"',
    );
    expect(invalidBecause((m) => (m.actions = { mcp: { entry: "app/mcp.js", args: [1] } }))).toContain(
      "actions.mcp.args",
    );
    expect(invalidBecause((m) => (m.actions = { mcp: { entry: "app/mcp.js", args: ["a\0b"] } }))).toContain("NUL");
  });

  it("rejects absolute paths, traversal, backslashes, drive letters, NUL and odd segments", () => {
    const paths = [
      "/etc/passwd",
      "../x",
      "a/../x",
      "a\\b",
      "C:/x",
      "C:x",
      "a\0b",
      "a//b",
      "a/./b",
      "a/",
      "",
      "a.",
      "a /b",
    ];
    for (const bad of paths) {
      expect(
        invalidBecause((m) => {
          (m.files as { path: string }[])[3]!.path = bad;
        }),
        JSON.stringify(bad),
      ).toContain("files.3.path");
    }
    expect(invalidBecause((m) => (m.executable = 5))).toContain("executable: must be a string");
  });

  it("rejects executable paths the shims could not read safely", () => {
    expect(invalidBecause((m) => (m.executable = "node bin/node"))).toContain("executable");
    expect(invalidBecause((m) => (m.executable = "node/bin/node$"))).toContain("executable");
  });

  it("rejects duplicate paths, including ones that differ only by case, and unlisted entry points", () => {
    expect(
      invalidBecause((m) => {
        (m.files as { path: string }[])[3]!.path = "APP/MCP.JS";
      }),
    ).toContain("duplicate path");
    expect(invalidBecause((m) => (m.symlinks = [{ path: "Launcher.MJS", target: "x" }]))).toContain("duplicate path");
    expect(invalidBecause((m) => (m.executable = "node/bin/other"))).toContain("executable: not listed in files");
    expect(invalidBecause((m) => (m.actions = { mcp: { entry: "app/ghost.js" } }))).toContain("actions.mcp.entry");
  });

  it("validates files and symlinks field by field", () => {
    expect(invalidBecause((m) => (m.files = []))).toContain("non-empty array");
    expect(invalidBecause((m) => (m.files = "x"))).toContain("non-empty array");
    expect(invalidBecause((m) => (m.files = ["x"]))).toContain("files.0: must be an object");
    expect(
      invalidBecause((m) => {
        (m.files as Record<string, unknown>[])[0]!.size = -1;
      }),
    ).toContain("size");
    expect(
      invalidBecause((m) => {
        (m.files as Record<string, unknown>[])[0]!.sha256 = "ABC";
      }),
    ).toContain("sha256");
    expect(
      invalidBecause((m) => {
        (m.files as Record<string, unknown>[])[0]!.mode = 0o777;
      }),
    ).toContain('unknown field "mode"');
    expect(invalidBecause((m) => (m.symlinks = "x"))).toContain("symlinks: must be an array");
    expect(invalidBecause((m) => (m.symlinks = [1]))).toContain("symlinks.0: must be an object");
    expect(invalidBecause((m) => (m.symlinks = [{ path: "l", target: 1 }]))).toContain("target: must be a string");
    expect(invalidBecause((m) => (m.symlinks = [{ path: "l", target: "/etc" }]))).toContain("absolute");
    expect(invalidBecause((m) => (m.symlinks = [{ path: 7, target: "x" }]))).toContain("symlinks.0.path");
  });

  it("caps how many problems one error lists", () => {
    const message = invalidBecause(
      (m) => (m.files = Array.from({ length: 30 }, () => ({ path: "/x", size: -1, sha256: "" }))),
    );
    expect(message).toContain("…(+");
  });
});

describe("path rules", () => {
  it("accepts plain relative paths", () => {
    expect(relativePathProblem("Electron.app/Contents/MacOS/Electron")).toBeUndefined();
    expect(relativePathProblem("locales/zh-TW.pak")).toBeUndefined();
  });

  it("rejects over-long paths", () => {
    expect(relativePathProblem("a/".repeat(600))).toContain("longer");
  });

  it("keeps symlink targets inside the runtime", () => {
    expect(symlinkTargetProblem("Versions/Current", "A")).toBeUndefined();
    expect(symlinkTargetProblem("Frameworks/X.framework/Resources", "Versions/Current/Resources")).toBeUndefined();
    expect(symlinkTargetProblem("a/b", "../c")).toBeUndefined();
    expect(symlinkTargetProblem("a", "../c")).toContain("leaves");
    expect(symlinkTargetProblem("a/b", "../../c")).toContain("leaves");
    expect(symlinkTargetProblem("a", "..")).toContain("leaves");
    expect(symlinkTargetProblem("a/b", "..")).toContain("leaves");
    expect(symlinkTargetProblem("a/b", "../..")).toContain("leaves");
    expect(symlinkTargetProblem("a", ".")).toContain("leaves");
    expect(symlinkTargetProblem("a", "")).toContain("empty");
    expect(symlinkTargetProblem("a", "x\\y")).toContain("forbidden");
    expect(symlinkTargetProblem("a", "/x")).toContain("absolute");
  });

  it("folds case and Unicode normalization for duplicate detection", () => {
    expect(casefoldKey("README.md")).toBe(casefoldKey("readme.MD"));
    expect(casefoldKey("é")).toBe(casefoldKey("é"));
  });
});

describe("defaultLauncherRoot", () => {
  it("uses LOCALAPPDATA on Windows and falls back to the profile", () => {
    expect(
      defaultLauncherRoot({
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
        homedir: "C:\\Users\\me",
      }),
    ).toBe("C:\\Users\\me\\AppData\\Local\\WorkIntelligence\\runtime");
    expect(defaultLauncherRoot({ platform: "win32", env: {}, homedir: "C:\\Users\\me" })).toBe(
      "C:\\Users\\me\\AppData\\Local\\WorkIntelligence\\runtime",
    );
  });

  it("uses Application Support on macOS", () => {
    expect(defaultLauncherRoot({ platform: "darwin", env: {}, homedir: "/Users/me" })).toBe(
      "/Users/me/Library/Application Support/WorkIntelligence/runtime",
    );
  });

  it("uses XDG_DATA_HOME on other systems, but only when it is absolute", () => {
    expect(defaultLauncherRoot({ platform: "linux", env: { XDG_DATA_HOME: "/data" }, homedir: "/home/me" })).toBe(
      "/data/work-intelligence/runtime",
    );
    expect(defaultLauncherRoot({ platform: "linux", env: { XDG_DATA_HOME: "relative" }, homedir: "/home/me" })).toBe(
      "/home/me/.local/share/work-intelligence/runtime",
    );
    expect(defaultLauncherRoot({ platform: "freebsd", env: {}, homedir: "/home/me" })).toBe(
      "/home/me/.local/share/work-intelligence/runtime",
    );
  });

  it("names the shim an Agent should run for each platform", () => {
    expect(launcherCommandPath("/r", "linux")).toBe("/r/bin/work-intelligence-launcher");
    expect(launcherCommandPath("C:\\r", "win32")).toBe("C:\\r\\bin\\work-intelligence-launcher.cmd");
  });
});

describe("shim text", () => {
  it("writes the two launch lines: the kind and the executable, never the launcher entry", () => {
    expect(renderLaunchFile("electron-run-as-node", "electron/electron")).toBe(
      "electron-run-as-node\nelectron/electron\n",
    );
  });

  it("has no launcherEntry field and requires launcher.mjs to be listed", () => {
    expect(invalidBecause((m) => (m.launcherEntry = "launcher.mjs"))).toContain("launcherEntry");
    expect(
      invalidBecause((m) => {
        m.files = (m.files as { path: string }[]).filter((file) => file.path !== "launcher.mjs");
      }),
    ).toContain("launcher: not listed in files");
  });

  it("builds a POSIX shim that quotes every path, validates input and never uses eval", () => {
    const shim = renderPosixShim();
    expect(shim.startsWith("#!/bin/sh\n")).toBe(true);
    expect(shim).toContain('exec "$runtime/$exe" "$runtime/launcher.mjs" "$@"');
    expect(shim).toContain("[!A-Za-z0-9._-]");
    expect(shim).not.toMatch(/\beval\b/);
  });

  it("builds a Windows shim that validates before expanding, passes the exit code and uses CRLF", () => {
    const shim = renderWindowsShim();
    expect(shim).toContain("%~dp0");
    expect(shim).toContain("findstr /R /X /V");
    expect(shim).toContain("exit /b %ERRORLEVEL%");
    expect(shim).toContain('"%RUNTIME%\\%EXE%" "%RUNTIME%\\launcher.mjs" %*');
    expect(shim).toContain('if not "%ID:~128,1%"=="" goto :badpointer');
    expect(shim).not.toContain("ENTRY");
    // The length check runs after the charset check and before the id is used in any path.
    expect(shim.indexOf("findstr")).toBeLessThan(shim.indexOf("%ID:~128,1%"));
    expect(shim.indexOf("%ID:~128,1%")).toBeLessThan(shim.indexOf('set "RUNTIME='));
    expect(shim).not.toMatch(/(?<!\r)\n/);
    expect(shim.indexOf("findstr")).toBeLessThan(shim.indexOf("set /p ID"));
  });
});
