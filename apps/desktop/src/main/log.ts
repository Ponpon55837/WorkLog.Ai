import { appendFileSync, mkdirSync } from "node:fs";
import type { DesktopPaths } from "./config.js";

export type Logger = (line: string) => void;

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
