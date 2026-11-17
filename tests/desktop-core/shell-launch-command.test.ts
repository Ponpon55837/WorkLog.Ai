import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_DEBUG_SWITCHES,
  QUIT_SECOND_INSTANCE_DATA,
  chooseRuntimeRoot,
  decideLaunch,
  decideRuntimeRecovery,
  findForbiddenDebugSwitch,
  interpretSecondInstanceData,
  isOpenDashboardLaunch,
  OPEN_DASHBOARD_FLAG,
  OPEN_DASHBOARD_SECOND_INSTANCE_DATA,
  isQuitLaunch,
} from "../../packages/desktop-core/src/shell/index.js";

describe("interpretSecondInstanceData", () => {
  it("accepts exactly { action: 'quit' } as a quit request", () => {
    expect(interpretSecondInstanceData({ action: "quit" })).toEqual({ command: "quit" });
    expect(interpretSecondInstanceData(QUIT_SECOND_INSTANCE_DATA)).toEqual({ command: "quit" });
  });

  it("reads exactly { action: 'open-dashboard' } as a request for the Dashboard", () => {
    expect(interpretSecondInstanceData(OPEN_DASHBOARD_SECOND_INSTANCE_DATA)).toEqual({ command: "open-dashboard" });
    expect(interpretSecondInstanceData({ action: "open-dashboard", url: "https://example.com" })).toEqual({
      command: "open",
      rejected: true,
    });
  });

  it("recognizes the --open-dashboard flag by its exact spelling", () => {
    expect(OPEN_DASHBOARD_FLAG).toBe("--open-dashboard");
    expect(isOpenDashboardLaunch(["app", "--open-dashboard"])).toBe(true);
    expect(isOpenDashboardLaunch(["app", "--open-dashboard=1", "--open"])).toBe(false);
  });

  it.each([undefined, null, {}])("treats %j as a normal second launch", (data) => {
    expect(interpretSecondInstanceData(data)).toEqual({ command: "open", rejected: false });
  });

  it.each([
    ["an extra field", { action: "quit", path: "C:\\evil" }],
    ["another action", { action: "restart" }],
    ["an uppercase action", { action: "QUIT" }],
    ["a missing action", { other: 1 }],
    ["a non-string action", { action: 1 }],
    ["a string", "quit"],
    ["an array", ["quit"]],
    ["a number", 1],
    ["a nested object", { action: { value: "quit" } }],
  ])("never interprets %s: a rejected normal launch", (_name, data) => {
    expect(interpretSecondInstanceData(data)).toEqual({ command: "open", rejected: true });
  });
});

describe("isQuitLaunch", () => {
  it("looks for the exact flag", () => {
    expect(isQuitLaunch(["app.exe", "--quit"])).toBe(true);
    expect(isQuitLaunch(["app.exe", "--quit=1"])).toBe(false);
    expect(isQuitLaunch(["app.exe", "--background"])).toBe(false);
  });
});

describe("decideLaunch", () => {
  it.each([
    [{ quitRequested: false, gotLock: true }, "run"],
    [{ quitRequested: true, gotLock: true }, "exit-without-starting"],
    [{ quitRequested: false, gotLock: false }, "hand-over-and-exit"],
    [{ quitRequested: true, gotLock: false }, "hand-over-and-exit"],
  ] as const)("%j is %s", (inputs, expected) => {
    expect(decideLaunch(inputs)).toBe(expected);
  });
});

describe("findForbiddenDebugSwitch", () => {
  it("names the first debugging switch present", () => {
    expect(findForbiddenDebugSwitch((name) => name === "inspect-brk")).toBe("inspect-brk");
    expect(findForbiddenDebugSwitch((name) => name === "remote-debugging-pipe")).toBe("remote-debugging-pipe");
  });

  it("finds nothing on a clean command line, and covers all four switches", () => {
    expect(findForbiddenDebugSwitch(() => false)).toBeUndefined();
    expect(FORBIDDEN_DEBUG_SWITCHES).toEqual([
      "remote-debugging-port",
      "remote-debugging-pipe",
      "inspect",
      "inspect-brk",
    ]);
  });
});

describe("chooseRuntimeRoot", () => {
  const base = { env: {}, userDataDirectory: "", customUserDataDirectory: false };

  it("uses the fixed non-roaming launcher root on Windows", () => {
    expect(
      chooseRuntimeRoot({
        ...base,
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
        homedir: "C:\\Users\\me",
        userDataDirectory: "C:\\Users\\me\\AppData\\Roaming\\Work Intelligence",
      }),
    ).toBe("C:\\Users\\me\\AppData\\Local\\WorkIntelligence\\runtime");
  });

  it("uses Application Support on macOS", () => {
    expect(
      chooseRuntimeRoot({ ...base, platform: "darwin", homedir: "/Users/me", userDataDirectory: "/Users/me/x" }),
    ).toBe("/Users/me/Library/Application Support/WorkIntelligence/runtime");
  });

  it.each([
    ["win32", "C:\\data\\profile", "C:\\data\\profile\\runtime"],
    ["darwin", "/tmp/profile", "/tmp/profile/runtime"],
    ["linux", "/tmp/profile", "/tmp/profile/runtime"],
  ] as const)("keeps %s self-contained with --user-data-dir", (platform, userData, expected) => {
    expect(
      chooseRuntimeRoot({
        ...base,
        platform,
        homedir: "/h",
        userDataDirectory: userData,
        customUserDataDirectory: true,
      }),
    ).toBe(expected);
  });
});

describe("decideRuntimeRecovery", () => {
  const base = { canReinstall: true, failureCode: "RUNTIME_MISSING", alreadyAttempted: false };

  it("verifies, reinstalls and retries once when the backend launch refused the runtime", () => {
    expect(decideRuntimeRecovery(base)).toBe("verify-reinstall-and-retry");
  });

  it.each([
    "RUNTIME_FILE_TAMPERED",
    "RUNTIME_MANIFEST_INVALID",
    "RUNTIME_FILE_MISSING",
    "RUNTIME_FILE_UNEXPECTED",
    "RUNTIME_SYMLINK_REJECTED",
  ])("reinstalls once for the content error %s", (failureCode) => {
    expect(decideRuntimeRecovery({ ...base, failureCode })).toBe("verify-reinstall-and-retry");
  });

  it.each([
    ["it was already tried", { alreadyAttempted: true }],
    ["the App cannot reinstall (not packaged)", { canReinstall: false }],
    ["permissions are unsafe", { failureCode: "RUNTIME_UNSAFE_PERMISSIONS" }],
    ["the ACL could not be read", { failureCode: "RUNTIME_ACL_UNREADABLE" }],
    [
      "a runtime file was refused by a content check but this was the second try",
      { failureCode: "RUNTIME_FILE_TAMPERED", alreadyAttempted: true },
    ],
    ["the install itself failed", { failureCode: "RUNTIME_INSTALL_FAILED" }],
    ["another error", { failureCode: "CHILD_EXITED" }],
  ])("does nothing when %s", (_name, change) => {
    expect(decideRuntimeRecovery({ ...base, ...change })).toBe("none");
  });
});
