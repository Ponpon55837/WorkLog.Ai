import { spawnSync } from "node:child_process";
import process from "node:process";

/** Runs the package manager selected by the current pnpm lifecycle, with a Windows shell fallback for direct Node runs. */
export function runPnpm(args, options) {
  const pnpmScript = process.env.npm_execpath;
  if (pnpmScript && /\.[cm]?js$/i.test(pnpmScript)) {
    return spawnSync(process.execPath, [pnpmScript, ...args], { ...options, windowsHide: true });
  }
  // Standalone pnpm (@pnpm/exe) exposes a native binary as npm_execpath; Node cannot load it as a module.
  if (pnpmScript) {
    return spawnSync(pnpmScript, args, { ...options, windowsHide: true });
  }
  return spawnSync("pnpm", args, {
    ...options,
    shell: process.platform === "win32",
    windowsHide: true,
  });
}
