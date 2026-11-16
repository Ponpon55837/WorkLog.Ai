import { appendFileSync, mkdirSync } from "node:fs";
import type { DesktopPaths } from "./config.js";

export type Logger = (line: string) => void;

/** The main process log: one timestamped line per call. Logging never takes the App down. */
export function createLogger(paths: Pick<DesktopPaths, "logsDirectory" | "logFile">): Logger {
  return (line) => {
    try {
      mkdirSync(paths.logsDirectory, { recursive: true });
      appendFileSync(paths.logFile, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // Logging must never take the App down.
    }
  };
}
