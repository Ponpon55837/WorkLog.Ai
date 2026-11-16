import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chooseRuntimeRoot } from "@work-intelligence/desktop-core";

/**
 * Environment variables that only a test build reads: they exist so tests can isolate and observe the App. The table is
 * reached only through `overrideFromEnvironment` and `testSwitch`, both behind `__WI_TEST_BUILD__`, so a production
 * bundle drops it with the names in it.
 */
const TEST_ENVIRONMENT = {
  dataDirectory: "WORK_INTELLIGENCE_DESKTOP_DATA_DIR",
  runtimeRoot: "WORK_INTELLIGENCE_DESKTOP_RUNTIME_ROOT",
  autoConfirmQuit: "WORK_INTELLIGENCE_DESKTOP_TEST_AUTOCONFIRM_QUIT",
  recordExternal: "WORK_INTELLIGENCE_DESKTOP_TEST_RECORD_EXTERNAL",
  /** Makes reading userData throw, as Windows does without a Roaming AppData folder, on any platform. */
  failUserData: "WORK_INTELLIGENCE_DESKTOP_TEST_FAIL_USER_DATA",
  /** Writes a native error box to stderr instead of showing it, so a test is not left waiting on a modal. */
  recordErrorBox: "WORK_INTELLIGENCE_DESKTOP_TEST_RECORD_ERROR_BOX",
} as const;

/** One of the test switches, by the name it has in {@link TEST_ENVIRONMENT}. */
export type TestEnvironmentKey = keyof typeof TEST_ENVIRONMENT;

const BUNDLE_DIRECTORY = dirname(fileURLToPath(import.meta.url));

/** The files the App ships next to the main bundle (`dist/main`): the repair page, its preload and the tray icon. */
export const ASSET_FILES = {
  rendererDirectory: join(BUNDLE_DIRECTORY, "..", "renderer", "repair"),
  preloadFile: join(BUNDLE_DIRECTORY, "..", "preload", "repair.cjs"),
  trayIconFile: join(BUNDLE_DIRECTORY, "..", "assets", "tray.png"),
} as const;

export interface DesktopPaths {
  /** Settings, operation journal, logs and the child's working directory live here. */
  readonly dataDirectory: string;
  readonly settingsFile: string;
  readonly journalFile: string;
  readonly logsDirectory: string;
  readonly logFile: string;
  /** The fixed, user-writable directory the backend child starts in (never Electron's own cwd). */
  readonly backendWorkingDirectory: string;
  /** The launcher root whose `current` runtime provides the `serve` action. */
  readonly runtimeRoot: string;
}

export interface DesktopConfigInputs {
  readonly isPackaged: boolean;
  /** `app.getPath("userData")`. */
  readonly userDataDirectory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  /** Chromium was started with `--user-data-dir`. */
  readonly customUserDataDirectory: boolean;
}

/** What the test switches read: never Electron's own paths, so they can be applied before any path is asked for. */
export type EnvironmentInputs = Pick<DesktopConfigInputs, "isPackaged" | "environment">;

/** An absolute path from the environment, or undefined; always undefined in a production build or a packaged App. */
export function overrideFromEnvironment(inputs: EnvironmentInputs, key: TestEnvironmentKey): string | undefined {
  if (!__WI_TEST_BUILD__ || inputs.isPackaged) return undefined;
  const value = inputs.environment[TEST_ENVIRONMENT[key]]?.trim();
  return value && isAbsolute(value) ? value : undefined;
}

/** Whether a test-only switch is on; always false in a production build or a packaged App. */
export function testSwitch(inputs: EnvironmentInputs, key: TestEnvironmentKey): boolean {
  return __WI_TEST_BUILD__ && !inputs.isPackaged && inputs.environment[TEST_ENVIRONMENT[key]] === "1";
}

/**
 * Where everything lives. Packaged: the data directory is Electron's userData, and the runtime root is the fixed per-user
 * launcher root (`%LOCALAPPDATA%\WorkIntelligence\runtime`, `~/Library/Application Support/WorkIntelligence/runtime`; user-
 * writable, so it is installed and switched without elevation, and not roaming), except under Chromium's `--user-data-dir`,
 * where it is `<userData>/runtime` (see chooseRuntimeRoot). Not packaged: the two test variables may redirect the data
 * directory and runtime root, and the runtime root otherwise stays `<userData>/runtime`; a value that is not an absolute
 * path is ignored.
 */
export function resolveDesktopPaths(inputs: DesktopConfigInputs): DesktopPaths {
  const dataDirectory = overrideFromEnvironment(inputs, "dataDirectory") ?? inputs.userDataDirectory;
  const logsDirectory = join(dataDirectory, "logs");
  return {
    dataDirectory,
    settingsFile: join(dataDirectory, "desktop-settings.json"),
    journalFile: join(dataDirectory, "operations-journal.json"),
    logsDirectory,
    logFile: join(logsDirectory, "desktop-main.log"),
    backendWorkingDirectory: join(dataDirectory, "backend-cwd"),
    runtimeRoot:
      overrideFromEnvironment(inputs, "runtimeRoot") ??
      (inputs.isPackaged
        ? chooseRuntimeRoot({
            platform: inputs.platform,
            env: inputs.environment,
            homedir: inputs.homeDirectory,
            userDataDirectory: inputs.userDataDirectory,
            customUserDataDirectory: inputs.customUserDataDirectory,
          })
        : join(inputs.userDataDirectory, "runtime")),
  };
}
