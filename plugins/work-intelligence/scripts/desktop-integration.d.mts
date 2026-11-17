/** Types for tests and tooling; the plugin itself runs the plain .mjs (scripts/build-plugin.mjs leaves this file out). */
export interface DesktopIntegrationRecord {
  version: 1;
  launcherPath: string;
  runtimeRoot: string;
  appExecutable: string;
  appVersion: string;
  writtenAt: string;
}

export interface DesktopLauncher {
  command: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

export interface DesktopLocationOptions {
  environment?: Record<string, string | undefined>;
  home?: string;
  platform?: NodeJS.Platform;
  /** The uid every POSIX entry must belong to; defaults to this process's. */
  uid?: number;
}

export interface RunDesktopLauncherOptions {
  hook: boolean;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  environment?: Record<string, string | undefined>;
  spawnProcess?: (file: string, args: readonly string[], options: object) => unknown;
  /** The process whose signals are forwarded and whose exit code is set; defaults to `process`. */
  host?: NodeJS.Process;
}

export const INTEGRATION_RECORD_FILE_NAME: string;
export const OPEN_DASHBOARD_FLAG: string;
export const LAUNCHER_ACTIONS: Record<string, string>;
export const HOOK_TIMEOUT_MS: number;
export function configDirectory(environment?: Record<string, string | undefined>, home?: string): string;
export function parseDesktopIntegration(text: string, platform?: NodeJS.Platform): DesktopIntegrationRecord | undefined;
export function readDesktopIntegration(options?: DesktopLocationOptions): DesktopIntegrationRecord | undefined;
export function resolveDesktopLauncher(
  command: string,
  options?: DesktopLocationOptions & { onProblem?: (problem: string) => void },
): DesktopLauncher | undefined;
export function resolveDesktopApp(options?: DesktopLocationOptions): string | undefined;
export function openDashboardInApp(
  appExecutable: string,
  options?: { environment?: Record<string, string | undefined>; spawnProcess?: unknown },
): Promise<boolean>;
export function runDesktopLauncher(launcher: DesktopLauncher, options: RunDesktopLauncherOptions): void;
