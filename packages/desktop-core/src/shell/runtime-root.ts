import path from "node:path";
import { defaultLauncherRoot, type LauncherRootInputs } from "../runtime/layout.js";

/** Everything that decides where the packaged App installs its runtime; all of it comes from the caller. */
export interface RuntimeRootInputs extends LauncherRootInputs {
  /** The App's data directory (`app.getPath("userData")`). */
  readonly userDataDirectory: string;
  /** Chromium was started with `--user-data-dir`: tests and custom data folders stay self-contained. */
  readonly customUserDataDirectory: boolean;
}

/**
 * The launcher root of a packaged App. Normally the fixed per-user location every Agent config can point at
 * (`defaultLauncherRoot`: `%LOCALAPPDATA%\WorkIntelligence\runtime`, which is not roaming, or
 * `~/Library/Application Support/WorkIntelligence/runtime`). With `--user-data-dir` the runtime lives in
 * `<userData>/runtime` instead, so a profile given on the command line owns everything it installs.
 */
export function chooseRuntimeRoot(inputs: RuntimeRootInputs): string {
  if (inputs.customUserDataDirectory) {
    const pathApi = inputs.platform === "win32" ? path.win32 : path.posix;
    return pathApi.join(inputs.userDataDirectory, "runtime");
  }
  return defaultLauncherRoot(inputs);
}
