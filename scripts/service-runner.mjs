import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import process from "node:process";

const [repositoryRoot, databasePath, backupDirectory, packageManagerExecutable, logPath] = process.argv.slice(2);

if (![repositoryRoot, databasePath, backupDirectory, packageManagerExecutable, logPath].every(Boolean)) {
  process.stderr.write("Work Intelligence service runner received an invalid configuration.\n");
  process.exitCode = 1;
} else {
  let logDescriptor;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    logDescriptor = openSync(logPath, "a");
    writeSync(logDescriptor, `[${new Date().toISOString()}] Starting pnpm start. Database: ${databasePath}\n`);
  } catch (error) {
    process.stderr.write(
      `Work Intelligence could not open its service log: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }

  if (logDescriptor !== undefined) {
    const command =
      process.platform === "win32"
        ? {
            executable: process.env.SystemRoot
              ? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
              : "powershell.exe",
            args: [
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `& '${packageManagerExecutable.replaceAll("'", "''")}' start`,
            ],
          }
        : { executable: packageManagerExecutable, args: ["start"] };
    const child = spawn(command.executable, command.args, {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PATH: [dirname(process.execPath), dirname(packageManagerExecutable), process.env.PATH ?? process.env.Path]
          .filter(Boolean)
          .join(delimiter),
        WORK_INTELLIGENCE_DB: databasePath,
        WORK_INTELLIGENCE_BACKUP_DIR: backupDirectory,
      },
      stdio: ["ignore", logDescriptor, logDescriptor],
    });

    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.once(signal, () => child.kill(signal));
    }

    child.once("error", (error) => {
      writeSync(logDescriptor, `[${new Date().toISOString()}] Could not start pnpm: ${error.message}\n`);
    });
    child.once("close", (code, signal) => {
      writeSync(
        logDescriptor,
        `[${new Date().toISOString()}] pnpm start stopped (code=${code ?? "null"}, signal=${signal ?? "none"}).\n`,
      );
      closeSync(logDescriptor);
      process.exitCode = code ?? 1;
    });
  }
}
