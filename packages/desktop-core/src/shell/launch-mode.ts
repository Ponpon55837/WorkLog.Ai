export type LaunchMode = "interactive" | "background";

export const BACKGROUND_FLAG = "--background";

export interface LaunchModeInputs {
  readonly platform: NodeJS.Platform;
  readonly argv: readonly string[];
  readonly wasOpenedAtLogin?: boolean;
}

export function detectLaunchMode(inputs: LaunchModeInputs): LaunchMode {
  if (inputs.argv.includes(BACKGROUND_FLAG)) return "background";
  if (inputs.platform === "darwin" && inputs.wasOpenedAtLogin === true) return "background";
  return "interactive";
}
