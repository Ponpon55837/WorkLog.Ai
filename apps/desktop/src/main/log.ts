import { appendFileSync, mkdirSync } from "node:fs";
import type { DesktopPaths } from "./config.js";

export type Logger = (line: string) => void;

/**
 * The log is the contract black-box tests of the packaged App read (`desktop-main.log` in the data directory). These
 * lines are stable; their prefix and wording do not change without updating those tests:
 *
 *   [shell] runtime <already-current|switched|installed|reinstalled> <runtimeId> in <ms> ms   the bundled runtime is ready
 *      Windows, when the ACLs were read: ` acl=<dotnet|get-acl> <ms> ms` is appended, after ` acl-failed=<tier> <ms> ms` for a tier that failed first
 *   [shell] runtime install failed: <RUNTIME_* code>                                          it could not be prepared
 *   [shell] runtime cleanup removed=<n> kept-locked=<n>                                       background removal of old runtimes (only logged when something was found)
 *   [shell] runtime reinstalled after the backend refused it                                  one automatic verify, reinstall and retry per App start (never for permission errors)
 *   [shell] backend started pid=<pid> port=<port>                                             the backend answered and was verified
 *   [shell] owner <UNCONFIGURED|PREPARING|QUIESCING|STARTING|MANAGED|NEEDS_REPAIR|EXTERNAL>   every change of the service owner
 *   [shell] dashboard opened                                                                  the Dashboard was handed to the external browser (an interactive launch that reached MANAGED, the tray, a second launch); never logged by a `--background` launch
 *   [shell] repair window shown                                                               the repair window is visible
 *   [shell] quit requested by --quit                                                          the non-interactive quit began
 *   [shell] second launch carried data that was not understood; treated as a normal launch   (a rejected second-instance payload)
 *
 * A packaged App started with a debugging switch writes `[shell] refusing to run with --<switch>` to stderr and exits 1.
 */

/**
 * The main process log: one timestamped line per call. Logging never takes the App down. The folder is created once,
 * not before every line; if it disappears later (removed by hand), the failed append creates it again and retries once.
 */
export function createLogger(paths: Pick<DesktopPaths, "logsDirectory" | "logFile">): Logger {
  let folderReady = false;
  const ensureFolder = (): void => {
    mkdirSync(paths.logsDirectory, { recursive: true });
    folderReady = true;
  };
  return (line) => {
    const text = `${new Date().toISOString()} ${line}\n`;
    try {
      if (!folderReady) ensureFolder();
      appendFileSync(paths.logFile, text);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
      try {
        ensureFolder();
        appendFileSync(paths.logFile, text);
      } catch {
        // Logging must never take the App down.
      }
    }
  };
}
