import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveDesktopDatabase } from "./desktop-database.js";
import { createLease } from "./lease.js";
import { runLauncher, type LauncherHost } from "./launcher-main.js";

// Read .asar files as plain files inside Electron so verification sees real sizes and bytes.
if (process.versions.electron !== undefined) (process as { noAsar?: boolean }).noAsar = true;

const host: LauncherHost = {
  execPath: process.execPath,
  versions: process.versions,
  platform: process.platform,
  arch: process.arch,
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  unsetEnv: (name) => void delete process.env[name],
  getEnv: (name) => process.env[name],
  setEnv: (name, value) => void (process.env[name] = value),
  desktopDatabase: (launcherRoot) => resolveDesktopDatabase(launcherRoot),
  setArgv: (argv) => void (process.argv = argv),
  importModule: (url) => import(url),
  acquireLease: createLease,
  onExit: (handler) => void process.once("exit", handler),
  startHeartbeat: (tick, intervalMs) => void setInterval(tick, intervalMs).unref(),
};

const outcome = await runLauncher(
  { runtimeDirectory: path.dirname(fileURLToPath(import.meta.url)), argv: process.argv.slice(2) },
  host,
);
if (outcome.kind === "exit") process.exitCode = outcome.code;
