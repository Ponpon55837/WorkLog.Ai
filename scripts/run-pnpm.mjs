import { spawnSync } from "node:child_process";
import process from "node:process";

const CMD_UNSAFE_CHARACTERS = /["%^&|<>\r\n\0]/;
const CMD_PLAIN_ARGUMENT = /^[A-Za-z0-9_\-.=:/\\@+,]+$/;

/** Quotes one argument for cmd.exe; characters cmd.exe would interpret are rejected, not escaped, so a future caller cannot inject shell text. */
export function quoteCmdArgument(argument) {
  if (typeof argument !== "string" || CMD_UNSAFE_CHARACTERS.test(argument)) {
    throw new Error("pnpm 參數含有 cmd.exe 無法安全傳遞的字元。");
  }
  if (CMD_PLAIN_ARGUMENT.test(argument)) return argument;
  // A trailing backslash would escape the closing quote, so double it.
  return `"${argument.replace(/\\+$/, (slashes) => slashes + slashes)}"`;
}

/** Builds the single command line handed to cmd.exe (a string, so Node does not warn about shell + args: DEP0190). */
export function buildWindowsPnpmCommandLine(args) {
  return ["pnpm", ...args.map(quoteCmdArgument)].join(" ");
}

export function runPnpm(args, options) {
  const pnpmScript = process.env.npm_execpath;
  if (pnpmScript && /\.[cm]?js$/i.test(pnpmScript)) {
    return spawnSync(process.execPath, [pnpmScript, ...args], { ...options, windowsHide: true });
  }
  // Standalone pnpm (@pnpm/exe) exposes a native binary as npm_execpath; Node cannot load it as a module.
  if (pnpmScript) {
    return spawnSync(pnpmScript, args, { ...options, windowsHide: true });
  }
  if (process.platform === "win32") {
    return spawnSync(buildWindowsPnpmCommandLine(args), { ...options, shell: true, windowsHide: true });
  }
  return spawnSync("pnpm", args, { ...options, windowsHide: true });
}
