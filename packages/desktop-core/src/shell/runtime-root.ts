import path from "node:path";
import { defaultLauncherRoot, type LauncherRootInputs } from "../runtime/layout.js";

export interface RuntimeRootInputs extends LauncherRootInputs {
  readonly userDataDirectory: string;
  readonly customUserDataDirectory: boolean;
}

export function chooseRuntimeRoot(inputs: RuntimeRootInputs): string {
  if (inputs.customUserDataDirectory) {
    const pathApi = inputs.platform === "win32" ? path.win32 : path.posix;
    return pathApi.join(inputs.userDataDirectory, "runtime");
  }
  return defaultLauncherRoot(inputs);
}
