import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { windowsPowerShell } from "@work-intelligence/shared/windows-system-tool";
import { classifyStorageRisk, type StorageRiskDeps, type StorageRiskResult } from "./storage-risk.js";

const MAX_OUTPUT_BYTES = 1024 * 1024;

export function runCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const file = command === "powershell.exe" ? windowsPowerShell(environment) : command;
  return new Promise<string>((resolve, reject) => {
    execFile(
      file,
      [...args],
      { timeout: timeoutMs, killSignal: "SIGKILL", windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8" },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

export interface NodeStorageRiskOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
}

export function createNodeStorageRiskDeps(options: NodeStorageRiskOptions = {}): StorageRiskDeps {
  const environment = options.environment ?? process.env;
  return {
    platform: options.platform ?? process.platform,
    environment,
    homeDirectory: options.homeDirectory ?? homedir(),
    realpath: (target) => fs.realpath(target),
    lstat: (target) => fs.lstat(target, { bigint: true }),
    readFile: (target) => fs.readFile(target, "utf8"),
    run: (command, args, timeoutMs) => runCommand(command, args, timeoutMs, environment),
    cache: new Map<string, Promise<StorageRiskResult>>(),
  };
}

export function createStorageRiskClassifier(
  options: NodeStorageRiskOptions = {},
): (databasePath: string) => Promise<StorageRiskResult> {
  const deps = createNodeStorageRiskDeps(options);
  return (databasePath) => classifyStorageRisk(databasePath, deps);
}
