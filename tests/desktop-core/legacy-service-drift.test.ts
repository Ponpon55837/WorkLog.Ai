import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER_PORT } from "../../apps/server/src/server-port.js";
import { WINDOWS_TASK_NAME, createUserServicePlan } from "../../apps/server/src/user-service.js";
import {
  LEGACY_DEFAULT_PORT,
  LEGACY_LAUNCHD_LABEL,
  LEGACY_RUNNER_RELATIVE_PATH,
  LEGACY_SYSTEMD_DESCRIPTION,
  LEGACY_SYSTEMD_UNIT,
  LEGACY_WINDOWS_TASK_NAME,
  legacyServiceDefinitionPath,
  legacyWindowsTaskTarget,
} from "../../packages/desktop-core/src/legacy-service/index.js";

type Platform = "darwin" | "linux" | "win32";

const ENVIRONMENTS: Record<Platform, Array<{ home: string; environment: NodeJS.ProcessEnv }>> = {
  darwin: [{ home: "/Users/ünï", environment: {} }],
  linux: [
    { home: "/home/ünï", environment: {} },
    { home: "/home/ünï", environment: { XDG_CONFIG_HOME: "/xdg/config ü" } },
    { home: "/home/ünï", environment: { XDG_CONFIG_HOME: "relative/ignored" } },
  ],
  win32: [
    { home: "C:\\Users\\Ünï", environment: {} },
    { home: "C:\\Users\\Ünï", environment: { LOCALAPPDATA: "D:\\Local Data" } },
    { home: "C:\\Users\\Ünï", environment: { LOCALAPPDATA: "relative" } },
  ],
};

function plan(platform: Platform, home: string, environment: NodeJS.ProcessEnv) {
  const windows = platform === "win32";
  return createUserServicePlan({
    platform,
    homeDirectory: home,
    repositoryRoot: windows ? "C:\\repo" : "/repo",
    environment,
    nodeExecutable: windows ? "C:\\node.exe" : "/node",
    packageManagerExecutable: windows ? "C:\\pnpm.cmd" : "/pnpm",
    userId: "S-1-5-21-1-2-3-1001",
    uid: 501,
  });
}

describe("legacy service constants agree with apps/server user-service", () => {
  it("uses the same names, target, runner and default port", () => {
    expect(plan("darwin", "/h", {}).serviceName).toBe(LEGACY_LAUNCHD_LABEL);
    expect(plan("linux", "/h", {}).serviceName).toBe(LEGACY_SYSTEMD_UNIT);
    expect(WINDOWS_TASK_NAME).toBe(LEGACY_WINDOWS_TASK_NAME);
    expect(plan("win32", "C:\\h", {}).serviceTarget).toBe(legacyWindowsTaskTarget());
    expect(LEGACY_DEFAULT_PORT).toBe(DEFAULT_SERVER_PORT);
  });

  it("recognises the runner and description the renderers write", () => {
    expect(plan("darwin", "/h", {}).files[0]!.contents).toContain(`/repo/${LEGACY_RUNNER_RELATIVE_PATH}`);
    expect(plan("linux", "/h", {}).files[0]!.contents).toContain(`Description=${LEGACY_SYSTEMD_DESCRIPTION}`);
    expect(plan("win32", "C:\\h", {}).files[0]!.contents).toContain(
      `C:\\repo\\${LEGACY_RUNNER_RELATIVE_PATH.replaceAll("/", "\\")}`,
    );
  });

  for (const platform of ["darwin", "linux", "win32"] as const) {
    it(`writes the ${platform} definition where service:install does, including path overrides`, () => {
      for (const { home, environment } of ENVIRONMENTS[platform]) {
        expect(legacyServiceDefinitionPath({ platform, homeDirectory: home, environment })).toBe(
          plan(platform, home, environment).configPath,
        );
      }
    });
  }
});
