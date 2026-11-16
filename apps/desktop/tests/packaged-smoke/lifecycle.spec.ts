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
  leftoverProcesses,
  logLines,
  packagedExecutable,
  pollUntil,
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
  for (const path of cleanupPaths.splice(0))
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  if (sandbox) removeSandbox(sandbox);
  sandbox = undefined;
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

test("an installer run over the running App stops it through --quit", async ({
  browserName: _browserName,
}, testInfo) => {
  test.skip(process.platform !== "win32", "Windows only");
  const installer = requiredEnvironment("WORK_INTELLIGENCE_PACKAGED_INSTALLER");
  const installDirectory = requiredEnvironment("WORK_INTELLIGENCE_PACKAGED_INSTALL_DIR");
  const current = await createSandbox({ withDatabase: true });
  sandbox = current;

  // The installer asks the running App to quit with a bare `<exe> --quit`, which can only find an instance that uses the
  // default userData. So that step is asserted on CI, where the default folder is a throwaway runner's and is removed
  // afterwards; on a developer machine the App runs in the sandbox and only the outcome is asserted, because the real
  // default userData is never touched.
  const [realDefault] = defaultUserDataDirectories(process.env) as [string];
  const strict = Boolean(process.env.CI) && !existsSync(realDefault);
  let observed = current;
  if (strict) {
    mkdirSync(realDefault, { recursive: true });
    cleanupPaths.push(realDefault);
    copyFileSync(join(current.userData, "desktop-settings.json"), join(realDefault, "desktop-settings.json"));
    observed = { ...current, userData: realDefault, logFile: join(realDefault, "logs", "desktop-main.log") };
  }
  const running = startApp(
    current,
    [],
    strict ? { defaultUserData: true, environment: { APPDATA: dirname(realDefault) } } : {},
  );
  app = running;
  const backend = await waitForManaged(observed);

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
  if (strict) expect(logLines(observed, /\[shell\] quit requested by --quit/)).toHaveLength(1);
  else
    testInfo.annotations.push({
      type: "note",
      description: "--quit step not asserted outside CI (default userData is not touched)",
    });
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
