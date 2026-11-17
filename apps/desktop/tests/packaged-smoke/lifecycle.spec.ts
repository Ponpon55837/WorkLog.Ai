import { expect, test } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { windowsCommandShell } from "@work-intelligence/shared/windows-system-tool";
import {
  PRODUCT_NAME,
  createSandbox,
  defaultUserDataDirectories,
  describeLaunch,
  leftoverProcesses,
  logLines,
  packagedExecutable,
  pollUntil,
  profileDirectories,
  portIsFree,
  processIsAlive,
  removeSandbox,
  requiredEnvironment,
  startApp,
  stopApp,
  waitForManaged,
  type PackagedSandbox,
  type RunningApp,
} from "./helpers.js";
import { decideInstallerProfile } from "./installer-profile.js";

/**
 * What installing, upgrading and removing do, seen from outside. Windows: the NSIS installer run again over the running
 * App, then the uninstaller. macOS: the DMG's contents. These run after the other specs (see run-packaged-smoke.mjs),
 * because the uninstall removes the App they test.
 */

const SETUP_TIMEOUT_MS = 180_000;
const UNINSTALL_TIMEOUT_MS = 90_000;

let sandbox: PackagedSandbox | undefined;
let app: RunningApp | undefined;
let cleanupPaths: string[] = [];

test.describe.configure({ mode: "serial" });

test.afterEach(async () => {
  if (sandbox) await stopApp(sandbox, app);
  app = undefined;
  // First: it ends whatever still holds the sandbox, which can also hold the default userData made below.
  if (sandbox) await removeSandbox(sandbox);
  sandbox = undefined;
  for (const path of cleanupPaths.splice(0))
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

/**
 * NSIS reads `/D=` raw and last: the command line is built by hand and handed to cmd without Node's quoting. A setup is
 * a GUI program, which cmd does not wait for unless `start /wait` runs it; that also returns its exit code.
 */
function runSetup(file: string, args: readonly string[]): Promise<number | null> {
  const commandLine = `"start /wait "" ${[`"${file}"`, ...args].join(" ")}"`;
  return new Promise((resolveExit, rejectExit) => {
    const child = spawn(windowsCommandShell(), ["/d", "/s", "/c", commandLine], {
      windowsVerbatimArguments: true,
      stdio: "ignore",
    });
    const timer = setTimeout(() => child.kill(), SETUP_TIMEOUT_MS);
    child.once("error", rejectExit);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
}

/** Every file below `directory` as `relative path -> size`, to prove a folder was left untouched. */
function snapshot(directory: string, base = directory): Record<string, number> {
  const entries: Record<string, number> = {};
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) Object.assign(entries, snapshot(path, base));
    else entries[path.slice(base.length)] = stat.size;
  }
  return entries;
}

test("an installer run over the running App stops it through --quit", async () => {
  test.skip(process.platform !== "win32", "Windows only");
  // The real profile is used only where that is safe (see installer-profile.ts): skipped on a developer's machine,
  // refused before anything is created when its default userData already exists.
  const existingDefaults = defaultUserDataDirectories(process.env).filter((directory) => existsSync(directory));
  const decision = decideInstallerProfile(process.env, existingDefaults);
  test.skip(decision.mode === "skip", decision.mode === "skip" ? decision.reason : "");
  if (decision.mode === "refuse") throw new Error(decision.reason);
  const installer = requiredEnvironment("WORK_INTELLIGENCE_PACKAGED_INSTALLER");
  const installDirectory = requiredEnvironment("WORK_INTELLIGENCE_PACKAGED_INSTALL_DIR");
  const [realDefault] = defaultUserDataDirectories(process.env) as [string];
  const current = await createSandbox({ withDatabase: true });
  sandbox = current;

  mkdirSync(realDefault, { recursive: true });
  cleanupPaths.push(realDefault);
  copyFileSync(join(current.userData, "desktop-settings.json"), join(realDefault, "desktop-settings.json"));
  const observed = { ...current, userData: realDefault, logFile: join(realDefault, "logs", "desktop-main.log") };
  // The profile of the installer, which runs with this process's environment. Electron finds the default userData
  // through the Windows known folder, which can expand %USERPROFILE%, so USERPROFILE must be the real one too, not only
  // APPDATA: with the sandbox's, the App's userData (its log and its single-instance lock) is in the sandbox home, where
  // neither this test nor the installer's `--quit` looks. LOCALAPPDATA stays in the sandbox: the runtime goes there.
  const realProfile: Record<string, string> = { APPDATA: dirname(realDefault) };
  for (const name of ["USERPROFILE", "HOME"] as const) {
    const value = process.env[name];
    if (value !== undefined) realProfile[name] = value;
  }
  const running = startApp(current, [], { defaultUserData: true, environment: realProfile });
  app = running;
  const backend = await waitForManaged(observed).catch((error: unknown) => {
    // Every folder the log could have gone to: the observed one, and the default userData of the real and the sandbox
    // profile.
    const candidates = [
      observed.userData,
      ...defaultUserDataDirectories(process.env),
      ...defaultUserDataDirectories(profileDirectories(current.home)),
    ].map((directory) => join(directory, "logs", "desktop-main.log"));
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${describeLaunch(running, candidates)}`,
    );
  });

  expect(await runSetup(installer, ["/S", `/D=${installDirectory}`])).toBe(0);

  await running.exited;
  await pollUntil(
    async () => (!processIsAlive(backend.pid) && (await portIsFree(backend.port)) ? true : undefined),
    "the backend gone and its port free",
    30_000,
  );
  expect(existsSync(packagedExecutable())).toBe(true);
  expect(existsSync(current.databasePath)).toBe(true);
  expect(leftoverProcesses([current.root, installDirectory])).toEqual([]);
  expect(logLines(observed, /\[shell\] quit requested by --quit/)).toHaveLength(1);
});

test("the uninstaller removes the program files and keeps the user's data", async () => {
  test.skip(process.platform !== "win32", "Windows only");
  const installDirectory = requiredEnvironment("WORK_INTELLIGENCE_PACKAGED_INSTALL_DIR");
  const uninstaller = join(installDirectory, `Uninstall ${PRODUCT_NAME}.exe`);
  expect(existsSync(uninstaller)).toBe(true);
  const current = await createSandbox({ withDatabase: true });
  sandbox = current;
  // A user's data after some use: the database, a backup and the App's own userData (run once so it has a runtime and a log).
  mkdirSync(current.backupDirectory, { recursive: true });
  const backupFile = join(current.backupDirectory, "synthetic-backup.sqlite");
  writeFileSync(backupFile, "synthetic backup");
  const running = startApp(current);
  app = running;
  await waitForManaged(current);
  await stopApp(current, running);
  app = undefined;
  const before = snapshot(current.userData);

  // The uninstaller copies itself to a temp folder and returns early, so the end is the install folder disappearing.
  await runSetup(uninstaller, ["/S"]);
  await pollUntil(
    () => (existsSync(installDirectory) ? undefined : true),
    "the install folder removed",
    UNINSTALL_TIMEOUT_MS,
  );

  expect(existsSync(packagedExecutable())).toBe(false);
  expect(existsSync(current.databasePath)).toBe(true);
  expect(existsSync(backupFile)).toBe(true);
  expect(snapshot(current.userData)).toEqual(before);
  // The uninstaller's temp copy names the install folder in its command line until it ends.
  await pollUntil(
    () => (leftoverProcesses([installDirectory]).length === 0 ? true : undefined),
    "no uninstaller left",
    30_000,
  );
});

test("the DMG holds the app and an Applications link", () => {
  test.skip(process.platform !== "darwin", "macOS only");
  const dmg = requiredEnvironment("WORK_INTELLIGENCE_PACKAGED_DMG");
  const mountPoint = mkdtempSync(join(os.tmpdir(), "wi-packaged-dmg-"));
  cleanupPaths.push(mountPoint);
  const attach = spawnSync("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mountPoint, dmg], {
    encoding: "utf8",
  });
  expect(attach.status, attach.stderr).toBe(0);
  try {
    const names = readdirSync(mountPoint);
    expect(names.some((name) => name.endsWith(".app") && statSync(join(mountPoint, name)).isDirectory())).toBe(true);
    expect(lstatSync(join(mountPoint, "Applications")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(mountPoint, "Applications"))).toBe("/Applications");
  } finally {
    spawnSync("hdiutil", ["detach", mountPoint, "-force"], { encoding: "utf8" });
  }
});
