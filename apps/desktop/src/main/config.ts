import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chooseRuntimeRoot, LANGUAGE_PREFERENCES_FILE_NAME } from "@work-intelligence/desktop-core";

const TEST_ENVIRONMENT = {
  dataDirectory: "WORK_INTELLIGENCE_DESKTOP_DATA_DIR",
  runtimeRoot: "WORK_INTELLIGENCE_DESKTOP_RUNTIME_ROOT",
  autoConfirmQuit: "WORK_INTELLIGENCE_DESKTOP_TEST_AUTOCONFIRM_QUIT",
  autoConfirmPort: "WORK_INTELLIGENCE_DESKTOP_TEST_AUTOCONFIRM_PORT",
  recordExternal: "WORK_INTELLIGENCE_DESKTOP_TEST_RECORD_EXTERNAL",
  failUserData: "WORK_INTELLIGENCE_DESKTOP_TEST_FAIL_USER_DATA",
  recordErrorBox: "WORK_INTELLIGENCE_DESKTOP_TEST_RECORD_ERROR_BOX",
  devToolsOff: "WORK_INTELLIGENCE_DESKTOP_TEST_DEVTOOLS_OFF",
  repairSuccessDelayMs: "WORK_INTELLIGENCE_DESKTOP_TEST_REPAIR_SUCCESS_DELAY_MS",
  autoConfirmCopy: "WORK_INTELLIGENCE_DESKTOP_TEST_AUTOCONFIRM_COPY",
  autoConfirmRestore: "WORK_INTELLIGENCE_DESKTOP_TEST_AUTOCONFIRM_RESTORE",
  restoreChooseFile: "WORK_INTELLIGENCE_DESKTOP_TEST_RESTORE_CHOOSE_FILE",
  defaultPort: "WORK_INTELLIGENCE_DESKTOP_TEST_DEFAULT_PORT",
  legacyServiceFile: "WORK_INTELLIGENCE_DESKTOP_TEST_LEGACY_SERVICE_FILE",
  storageRiskFile: "WORK_INTELLIGENCE_DESKTOP_TEST_STORAGE_RISK_FILE",
  holdMigrationFile: "WORK_INTELLIGENCE_DESKTOP_TEST_HOLD_MIGRATION_FILE",
  pauseOperationFile: "WORK_INTELLIGENCE_DESKTOP_TEST_PAUSE_OPERATION_FILE",
  updateApiOrigin: "WORK_INTELLIGENCE_DESKTOP_TEST_UPDATE_API_ORIGIN",
  updatePlatform: "WORK_INTELLIGENCE_DESKTOP_TEST_UPDATE_PLATFORM",
} as const;

export type TestEnvironmentKey = keyof typeof TEST_ENVIRONMENT;

const BUNDLE_DIRECTORY = dirname(fileURLToPath(import.meta.url));

export const ASSET_FILES = {
  rendererDirectory: join(BUNDLE_DIRECTORY, "..", "renderer", "repair"),
  preloadFile: join(BUNDLE_DIRECTORY, "..", "preload", "repair.cjs"),
  trayIconFile: join(BUNDLE_DIRECTORY, "..", "assets", "tray.png"),
  /** macOS menu-bar template image; Electron picks up `trayTemplate@2x.png` beside it on Retina displays. */
  trayTemplateFile: join(BUNDLE_DIRECTORY, "..", "assets", "trayTemplate.png"),
} as const;

export function skillSourceFile(isPackaged: boolean, resourcesPath: string): string {
  return isPackaged
    ? join(resourcesPath, "skills", "work-intelligence", "SKILL.md")
    : join(BUNDLE_DIRECTORY, "..", "skills", "work-intelligence", "SKILL.md");
}

export interface DesktopPaths {
  readonly dataDirectory: string;
  readonly settingsFile: string;
  readonly preferencesFile: string;
  readonly journalFile: string;
  readonly logsDirectory: string;
  readonly logFile: string;
  readonly backendWorkingDirectory: string;
  readonly runtimeRoot: string;
}

export interface DesktopConfigInputs {
  readonly isPackaged: boolean;
  readonly userDataDirectory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly customUserDataDirectory: boolean;
}

export type EnvironmentInputs = Pick<DesktopConfigInputs, "isPackaged" | "environment">;

export function overrideFromEnvironment(inputs: EnvironmentInputs, key: TestEnvironmentKey): string | undefined {
  if (!__WI_TEST_BUILD__ || inputs.isPackaged) return undefined;
  const value = inputs.environment[TEST_ENVIRONMENT[key]]?.trim();
  return value && isAbsolute(value) ? value : undefined;
}

export const REPAIR_SUCCESS_DELAY_MS = 1500;

export function repairSuccessDelayMs(inputs: EnvironmentInputs): number {
  // The test branch is a block under the build flag, so a production bundle drops it together with the variable name.
  if (__WI_TEST_BUILD__ && !inputs.isPackaged) {
    const value = Number(inputs.environment[TEST_ENVIRONMENT.repairSuccessDelayMs]);
    if (Number.isInteger(value) && value >= 0) return value;
  }
  return REPAIR_SUCCESS_DELAY_MS;
}

export function defaultPortOverride(inputs: EnvironmentInputs): number | undefined {
  if (__WI_TEST_BUILD__ && !inputs.isPackaged) {
    const value = Number(inputs.environment[TEST_ENVIRONMENT.defaultPort]);
    if (Number.isInteger(value) && value >= 1024 && value <= 65535) return value;
  }
  return undefined;
}

export function legacyServiceFileOverride(inputs: EnvironmentInputs): string | undefined {
  if (__WI_TEST_BUILD__ && !inputs.isPackaged) {
    const value = inputs.environment[TEST_ENVIRONMENT.legacyServiceFile];
    if (value && isAbsolute(value)) return value;
  }
  return undefined;
}

export function storageRiskFileOverride(inputs: EnvironmentInputs): string | undefined {
  return overrideFromEnvironment(inputs, "storageRiskFile");
}

export function restoreChooseFileOverride(inputs: EnvironmentInputs): string | undefined {
  return overrideFromEnvironment(inputs, "restoreChooseFile");
}

export function updateApiOriginOverride(inputs: EnvironmentInputs): string | undefined {
  if (__WI_TEST_BUILD__ && !inputs.isPackaged) {
    try {
      const url = new URL(inputs.environment[TEST_ENVIRONMENT.updateApiOrigin] ?? "");
      // Loopback over plain http with an explicit port: the one shape a local fake server has, and nothing a user's environment could use to redirect the request.
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

export function testSwitch(inputs: EnvironmentInputs, key: TestEnvironmentKey): boolean {
  return __WI_TEST_BUILD__ && !inputs.isPackaged && inputs.environment[TEST_ENVIRONMENT[key]] === "1";
}

export function backendTestEnvironment(inputs: EnvironmentInputs): Readonly<Record<string, string>> | undefined {
  if (__WI_TEST_BUILD__ && !inputs.isPackaged) {
    const file = overrideFromEnvironment(inputs, "holdMigrationFile");
    if (file) return { WORK_INTELLIGENCE_TEST_HOLD_MIGRATION_FILE: file };
  }
  return undefined;
}

export function resolveDesktopPaths(inputs: DesktopConfigInputs): DesktopPaths {
  const dataDirectory = overrideFromEnvironment(inputs, "dataDirectory") ?? inputs.userDataDirectory;
  const logsDirectory = join(dataDirectory, "logs");
  return {
    dataDirectory,
    settingsFile: join(dataDirectory, "desktop-settings.json"),
    preferencesFile: join(dataDirectory, LANGUAGE_PREFERENCES_FILE_NAME),
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
