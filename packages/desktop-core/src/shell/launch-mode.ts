/** Whether the App was opened by the user (show windows) or silently at login (tray only). */
export type LaunchMode = "interactive" | "background";

/** The flag the login item passes on Windows, and a way to ask for background mode explicitly on any platform. */
export const BACKGROUND_FLAG = "--background";

export interface LaunchModeInputs {
  readonly platform: NodeJS.Platform;
  readonly argv: readonly string[];
  /** macOS: `app.getLoginItemSettings().wasOpenedAtLogin`. Windows and Linux have no such value. */
  readonly wasOpenedAtLogin?: boolean;
}

/**
 * Electron 44 removed `openAsHidden` and `wasOpenedAsHidden`, so background mode comes from what is still reliable:
 * the `--background` argument (the Windows login item passes it) or, on macOS, `wasOpenedAtLogin`.
 */
export function detectLaunchMode(inputs: LaunchModeInputs): LaunchMode {
  if (inputs.argv.includes(BACKGROUND_FLAG)) return "background";
  if (inputs.platform === "darwin" && inputs.wasOpenedAtLogin === true) return "background";
  return "interactive";
}
