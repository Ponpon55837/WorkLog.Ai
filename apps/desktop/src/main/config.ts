import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Environment variables that only a non-packaged build reads: they exist so tests can isolate and observe the App. */
export const TEST_ENVIRONMENT = {
  dataDirectory: "WORK_INTELLIGENCE_DESKTOP_DATA_DIR",
  runtimeRoot: "WORK_INTELLIGENCE_DESKTOP_RUNTIME_ROOT",
  autoConfirmQuit: "WORK_INTELLIGENCE_DESKTOP_TEST_AUTOCONFIRM_QUIT",
  recordExternal: "WORK_INTELLIGENCE_DESKTOP_TEST_RECORD_EXTERNAL",
} as const;

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
}

/** What the test switches read: never Electron's own paths, so they can be applied before any path is asked for. */
export type EnvironmentInputs = Pick<DesktopConfigInputs, "isPackaged" | "environment">;

/** An absolute path from the environment, or undefined; ignored entirely when the App is packaged. */
export function overrideFromEnvironment(inputs: EnvironmentInputs, name: string): string | undefined {
  const value = inputs.isPackaged ? undefined : inputs.environment[name]?.trim();
  return value && isAbsolute(value) ? value : undefined;
}

/** Whether a test-only switch is on; always false in a packaged App. */
export function testSwitch(inputs: EnvironmentInputs, name: string): boolean {
  return !inputs.isPackaged && inputs.environment[name] === "1";
}

/**
 * Where everything lives. Packaged: the data directory is Electron's userData and the runtime root is `runtime/` inside
 * it (a user-writable place, so the launcher root can be installed and switched without elevation). Not packaged: the two
 * test variables may redirect them; a value that is not an absolute path is ignored.
 */
export function resolveDesktopPaths(inputs: DesktopConfigInputs): DesktopPaths {
  const dataDirectory = overrideFromEnvironment(inputs, TEST_ENVIRONMENT.dataDirectory) ?? inputs.userDataDirectory;
  const logsDirectory = join(dataDirectory, "logs");
  return {
    dataDirectory,
    settingsFile: join(dataDirectory, "desktop-settings.json"),
    journalFile: join(dataDirectory, "operations-journal.json"),
    logsDirectory,
    logFile: join(logsDirectory, "desktop-main.log"),
    backendWorkingDirectory: join(dataDirectory, "backend-cwd"),
    runtimeRoot:
      overrideFromEnvironment(inputs, TEST_ENVIRONMENT.runtimeRoot) ?? join(inputs.userDataDirectory, "runtime"),
  };
}
