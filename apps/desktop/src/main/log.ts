import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import type { DesktopPaths } from "./config.js";

export type Logger = (line: string) => void;

/** The log is the contract black-box tests of the packaged App read (`desktop-main.log`): keep each line's prefix and wording stable. */

export function createLogger(paths: Pick<DesktopPaths, "logsDirectory" | "logFile">): Logger {
  let folderReady = false;
  let fileSecured = false;
  // The log holds the database path, so it is owner-only; a log an older version created is tightened once.
  const ensureFolder = (): void => {
    mkdirSync(paths.logsDirectory, { recursive: true, mode: 0o700 });
    folderReady = true;
  };
  const append = (text: string): void => {
    appendFileSync(paths.logFile, text, { mode: 0o600 });
    if (fileSecured) return;
    fileSecured = true;
    try {
      chmodSync(paths.logFile, 0o600);
    } catch {
      // Not every file system has modes; the log is still written.
    }
  };
  return (line) => {
    const text = `${new Date().toISOString()} ${line}\n`;
    try {
      if (!folderReady) ensureFolder();
      append(text);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
      try {
        ensureFolder();
        append(text);
      } catch {
        // Logging must never take the App down.
      }
    }
  };
}
