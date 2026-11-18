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
  /** Answers the native port-change confirmation with 「變更」 instead of showing it. */
  autoConfirmPort: "WORK_INTELLIGENCE_DESKTOP_TEST_AUTOCONFIRM_PORT",
  recordExternal: "WORK_INTELLIGENCE_DESKTOP_TEST_RECORD_EXTERNAL",
  /** Makes reading userData throw, as Windows does without a Roaming AppData folder, on any platform. */
  failUserData: "WORK_INTELLIGENCE_DESKTOP_TEST_FAIL_USER_DATA",
  /** Writes a native error box to stderr instead of showing it, so a test is not left waiting on a modal. */
  recordErrorBox: "WORK_INTELLIGENCE_DESKTOP_TEST_RECORD_ERROR_BOX",
  /** Turns the window's developer tools off in an unpackaged build, as they are in a packaged App (the smoke test proves the setting). */
  devToolsOff: "WORK_INTELLIGENCE_DESKTOP_TEST_DEVTOOLS_OFF",
  /** Milliseconds the success card stays before the repair window closes (default 1500). */
  repairSuccessDelayMs: "WORK_INTELLIGENCE_DESKTOP_TEST_REPAIR_SUCCESS_DELAY_MS",
  /** Answers the native 「複製到本機磁碟並改用」 confirmation with 「複製並改用」 instead of showing it. */
  autoConfirmCopy: "WORK_INTELLIGENCE_DESKTOP_TEST_AUTOCONFIRM_COPY",
  /** The port a first-run default setup uses instead of the product default, so a smoke test never needs a fixed port. */
  defaultPort: "WORK_INTELLIGENCE_DESKTOP_TEST_DEFAULT_PORT",
  /**
   * A file holding a synthetic old-login-service detection (JSON): the smoke tests cannot install a real `pnpm bootstrap`
   * service, and the file-level detection is unit-tested per platform (tests/desktop-core/legacy-service.test.ts).
   */
  legacyServiceFile: "WORK_INTELLIGENCE_DESKTOP_TEST_LEGACY_SERVICE_FILE",
  /**
   * A JSON file that maps a path prefix to a storage verdict (network, removable, ...): the smoke tests cannot mount a
   * share or plug in a drive, and the real classifier is unit-tested per platform with fakes.
   */
  storageRiskFile: "WORK_INTELLIGENCE_DESKTOP_TEST_STORAGE_RISK_FILE",
  /**
   * An absolute path `P`: the backend child waits before opening the database (so before any migration) until the file
   * `P` exists, and writes its pid to `P.held`, so a smoke test can kill it mid-upgrade or let it go on.
   */
  holdMigrationFile: "WORK_INTELLIGENCE_DESKTOP_TEST_HOLD_MIGRATION_FILE",
  /**
   * `http://127.0.0.1:<port>`: a local fake server the update check asks instead of the GitHub API. Only the API origin
   * changes; the release page and installer links it returns must still be github.com links of the repository.
   */
  updateApiOrigin: "WORK_INTELLIGENCE_DESKTOP_TEST_UPDATE_API_ORIGIN",
  /** `<platform>/<arch>` (for example `win32/x64`) the update check uses to pick the installer, so any host can test each one. */
  updatePlatform: "WORK_INTELLIGENCE_DESKTOP_TEST_UPDATE_PLATFORM",
} as const;

/** One of the test switches, by the name it has in {@link TEST_ENVIRONMENT}. */
export type TestEnvironmentKey = keyof typeof TEST_ENVIRONMENT;

const BUNDLE_DIRECTORY = dirname(fileURLToPath(import.meta.url));

/** The files the App ships next to the main bundle (`dist/main`): the repair page, its preload and the tray icon. */
export const ASSET_FILES = {
  rendererDirectory: join(BUNDLE_DIRECTORY, "..", "renderer", "repair"),
  preloadFile: join(BUNDLE_DIRECTORY, "..", "preload", "repair.cjs"),
  trayIconFile: join(BUNDLE_DIRECTORY, "..", "assets", "tray.png"),
  /** macOS menu-bar template image; `trayTemplate@2x.png` sits beside it and Electron picks it up on Retina displays. */
  trayTemplateFile: join(BUNDLE_DIRECTORY, "..", "assets", "trayTemplate.png"),
} as const;

/** The Agent skill the App installs: a resources file when packaged (electron-builder SKILL_RESOURCE), else dist/skills. */
export function skillSourceFile(isPackaged: boolean, resourcesPath: string): string {
  return isPackaged
    ? join(resourcesPath, "skills", "work-intelligence", "SKILL.md")
    : join(BUNDLE_DIRECTORY, "..", "skills", "work-intelligence", "SKILL.md");
}

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

/** How long the success card shows before the repair window closes and the Dashboard opens. */
export const REPAIR_SUCCESS_DELAY_MS = 1500;

/** The success-card pause: the default, or a non-negative integer from the environment in a test build. */
export function repairSuccessDelayMs(inputs: EnvironmentInputs): number {
  // The test branch is a block under the build flag, so a production bundle drops it together with the variable name.
  if (__WI_TEST_BUILD__ && !inputs.isPackaged) {
    const value = Number(inputs.environment[TEST_ENVIRONMENT.repairSuccessDelayMs]);
    if (Number.isInteger(value) && value >= 0) return value;
  }
  return REPAIR_SUCCESS_DELAY_MS;
}

/** The first-run default port from the environment in a test build (1024-65535), else undefined: the product default. */
export function defaultPortOverride(inputs: EnvironmentInputs): number | undefined {
  if (__WI_TEST_BUILD__ && !inputs.isPackaged) {
    const value = Number(inputs.environment[TEST_ENVIRONMENT.defaultPort]);
    if (Number.isInteger(value) && value >= 1024 && value <= 65535) return value;
  }
  return undefined;
}

/** The synthetic legacy-detection file of a test build, else undefined (the real read-only detection runs). */
export function legacyServiceFileOverride(inputs: EnvironmentInputs): string | undefined {
  if (__WI_TEST_BUILD__ && !inputs.isPackaged) {
    const value = inputs.environment[TEST_ENVIRONMENT.legacyServiceFile];
    if (value && isAbsolute(value)) return value;
  }
  return undefined;
}

/** The synthetic storage-verdict file of a test build, else undefined (the real classifier answers every path). */
export function storageRiskFileOverride(inputs: EnvironmentInputs): string | undefined {
  return overrideFromEnvironment(inputs, "storageRiskFile");
}

/** The fake update server's origin in a test build that is not packaged, else undefined (the GitHub API answers). */
export function updateApiOriginOverride(inputs: EnvironmentInputs): string | undefined {
  if (__WI_TEST_BUILD__ && !inputs.isPackaged) {
    try {
      const url = new URL(inputs.environment[TEST_ENVIRONMENT.updateApiOrigin] ?? "");
      // Loopback over plain http with an explicit port: the one shape a local fake server has, and nothing a user's own
      // environment could use to send the request anywhere else.
      const plain = url.username === "" && url.password === "" && url.search === "" && url.hash === "";
      if (
        plain &&
        url.protocol === "http:" &&
        url.hostname === "127.0.0.1" &&
        url.port !== "" &&
        url.pathname === "/"
      ) {
        return url.origin;
      }
    } catch {
      // Not a URL: the real endpoint is used.
    }
  }
  return undefined;
}

/** The platform and architecture the update check reports: the test build's override, else the real ones. */
export function updateTarget(
  inputs: EnvironmentInputs,
  real: { readonly platform: string; readonly arch: string },
): { readonly platform: string; readonly arch: string } {
  if (__WI_TEST_BUILD__ && !inputs.isPackaged) {
    const [platform, arch, ...rest] = (inputs.environment[TEST_ENVIRONMENT.updatePlatform] ?? "").split("/");
    if (platform && arch && rest.length === 0 && /^[a-z0-9]+$/.test(platform) && /^[a-z0-9]+$/.test(arch)) {
      return { platform, arch };
    }
  }
  return real;
}

/** Whether a test-only switch is on; always false in a production build or a packaged App. */
export function testSwitch(inputs: EnvironmentInputs, key: TestEnvironmentKey): boolean {
  return __WI_TEST_BUILD__ && !inputs.isPackaged && inputs.environment[TEST_ENVIRONMENT[key]] === "1";
}

/**
 * Extra environment for the backend child: the migration hold in a test build that is not packaged, else undefined. The
 * name the child reads sits inside the build-flag block, so a production bundle contains neither it nor this variable.
 * The child's own environment is an allowlist, so nothing else a user sets can reach it either.
 */
export function backendTestEnvironment(inputs: EnvironmentInputs): Readonly<Record<string, string>> | undefined {
  if (__WI_TEST_BUILD__ && !inputs.isPackaged) {
    const file = overrideFromEnvironment(inputs, "holdMigrationFile");
    if (file) return { WORK_INTELLIGENCE_TEST_HOLD_MIGRATION_FILE: file };
  }
  return undefined;
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
