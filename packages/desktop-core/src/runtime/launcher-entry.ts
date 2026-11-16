import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runLauncher, type LauncherHost } from "./launcher-main.js";

/**
 * The script bundled as `launcher.mjs` at the top of every runtime directory. It only wires `runLauncher` to this
 * process; the logic and its tests live in launcher-main.ts. Excluded from coverage because it runs at import time.
 */
// Inside Electron, read .asar files as plain files so verification sees their real size and bytes. The shims already
// set ELECTRON_NO_ASAR; this covers a launcher started without them.
if (process.versions.electron !== undefined) (process as { noAsar?: boolean }).noAsar = true;

const host: LauncherHost = {
  execPath: process.execPath,
  versions: process.versions,
  platform: process.platform,
  arch: process.arch,
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  unsetEnv: (name) => void delete process.env[name],
  setArgv: (argv) => void (process.argv = argv),
  importModule: (url) => import(url),
};

const outcome = await runLauncher(
  { runtimeDirectory: path.dirname(fileURLToPath(import.meta.url)), argv: process.argv.slice(2) },
  host,
);
if (outcome.kind === "exit") process.exitCode = outcome.code;
