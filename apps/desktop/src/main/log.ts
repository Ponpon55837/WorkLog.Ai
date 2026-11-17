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
 *   [shell] desktop integration record written                                               desktop-integration.json (launcher and App paths for Agents) was created or changed; a warm start writes nothing
 *   [shell] desktop integration record failed: <code>                                         it could not be written; the App starts without it
 *   [shell] desktop settings pointer written                                                  <runtime root>/desktop-settings-path (where launcher actions find the App's database) was created or changed
 *   [shell] desktop settings pointer failed: <code>                                           it could not be written; Agents keep the standalone database rule
 *   [shell] dashboard requested by --open-dashboard                                           a second launch asked the running App for the Dashboard (a deferred one opens when the start is ready)
 *   [shell] repair window shown                                                               the repair window is visible
 *   [shell] quit requested by --quit                                                          the non-interactive quit began
 *   [shell] second launch carried data that was not understood; treated as a normal launch   (a rejected second-instance payload)
 *   [shell] no settings yet: first-run setup                                                  a new install: nothing is written or started until the first-run page (DT-01) says so; an install with settings never logs it
 *   [shell] first-run setup waits for the user (tray)                                         a `--background` new install shows no window; the tray offers "完成首次設定…"
 *   [shell] first-run detection <decision> sources=<n> previews=<n> (<ms> ms)                 the read-only detection behind the first-run page finished
 *   [shell] first-run setup finished                                                          a start from the first-run page worked; the settings were written only now
 *   [shell] first-run start failed: <code>                                                    it did not; nothing was written and the page shows why
 *   [shell] first-run removed the database it created after a failed start                    the new database of a failed default start is gone again (ADR-27)
 *   [shell] legacy service <none|recognised|unrecognised> [<running|stopped|unknown>] (<ms> ms)   the read-only detection of the old login service (`pnpm bootstrap`); only when its result changes
 *   [shell] start held back: the old login service may use this database                     a start waits for "仍要啟動" (LEGACY_SERVICE_ACTIVE); nothing retries it automatically
 *   [shell] start anyway: the user accepted the old login service on this database           the user said "仍要啟動"; remembered until the App quits
 *   [shell] agent setup preview adopt=<bool> files=<n> conflicts=<n>                          the Agent page computed a plan; nothing was written
 *   [shell] agent setup apply <outcome>[ <code>]                                              the previewed plan was applied (journaled)
 *   [shell] agent setup undo <status>[ <code>]                                                the last apply was undone from its journal
 *   [shell] agent self-test <ok|code> (<ms> ms)                                               MCP initialize and tools/list through the fixed launcher
 *   [shell] Agent page requested by --open-agent-setup                                        a second launch (or the Web status page, "…by the Dashboard") asked for the Agent page
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
