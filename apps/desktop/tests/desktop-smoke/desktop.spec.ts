import { expect, test, type ElectronApplication } from "@playwright/test";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import {
  attachLog,
  closeQuietly,
  createSandbox,
  healthProofIsValid,
  launchApp,
  portIsFree,
  profileDirectories,
  processIsAlive,
  readMainLog,
  readSnapshot,
  removeSandbox,
  runToExit,
  windowsLeftovers,
  waitForSnapshot,
  type Sandbox,
} from "./helpers.js";

let sandbox: Sandbox | undefined;
let app: ElectronApplication | undefined;

test.afterEach(async ({ browserName: _browserName }, testInfo) => {
  if (sandbox) attachLog(testInfo, sandbox);
  await closeQuietly(app);
  app = undefined;
  if (sandbox) removeSandbox(sandbox);
  sandbox = undefined;
});

/** Windows paths compare without case and with either slash. */
function samePathPrefix(path: string, directory: string): boolean {
  const normalize = (value: string) => {
    const unified = value.replaceAll("\\", "/");
    return process.platform === "win32" ? unified.toLowerCase() : unified;
  };
  return normalize(path).startsWith(`${normalize(directory).replace(/\/+$/, "")}/`);
}

test("starts the managed backend and proves its identity", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  app = await launchApp(sandbox);

  const snapshot = await waitForSnapshot(app, (state) => state.owner === "MANAGED" && state.backend !== null);
  const backend = snapshot.backend;
  if (!backend) throw new Error("no backend");
  expect(backend.port).toBe(sandbox.port);
  expect(await portIsFree(backend.port)).toBe(false);
  expect(await healthProofIsValid(backend.port, backend.runId)).toBe(true);
  // A wrong run id must not verify: the proof is what separates this child from any other service on the port.
  expect(await healthProofIsValid(backend.port, `${backend.runId}x`)).toBe(false);
  // The interactive start opens the Dashboard (recorded, not launched, in the test). It opens right after MANAGED is
  // published, so the snapshot above can precede it: wait for the first open, then require exactly that one.
  const opened = await waitForSnapshot(app, (state) => state.openedExternal.length > 0);
  expect(opened.openedExternal).toEqual([`http://127.0.0.1:${backend.port}/`]);
});

test("a second launch exits at once and the first keeps the only backend", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  app = await launchApp(sandbox);
  const first = await waitForSnapshot(app, (state) => state.owner === "MANAGED" && state.backend !== null);
  const pid = first.backend?.pid;
  if (!pid) throw new Error("no backend");

  const second = await runToExit(sandbox);
  expect({ code: second.code, signal: second.signal }, `second instance stderr:\n${second.stderr}`).toEqual({
    code: 0,
    signal: null,
  });

  const after = await waitForSnapshot(app, (state) => state.secondInstanceCount >= 1);
  expect(after.lastSecondInstanceDecision).toBe("open-dashboard");
  expect(after.backend?.pid).toBe(pid);
  expect(processIsAlive(pid)).toBe(true);
  expect(await portIsFree(sandbox.port)).toBe(false);
  // Exactly one start in the whole run: the second process never reached the backend.
  expect(readMainLog(sandbox).match(/\[shell\] backend started/g)).toHaveLength(1);
});

test("a missing database opens the repair window and creates nothing", async () => {
  sandbox = await createSandbox({ withDatabase: false });
  app = await launchApp(sandbox);

  const window = await app.firstWindow({ timeout: 45_000 });
  const snapshot = await waitForSnapshot(app, (state) => state.owner === "NEEDS_REPAIR" && state.repairWindowOpen);
  expect(snapshot.recentErrors).toContain("DB_MISSING");
  expect(snapshot.backend).toBeNull();
  expect(existsSync(sandbox.databasePath)).toBe(false);
  expect(await portIsFree(sandbox.port)).toBe(true);

  await expect(window.getByText("DB_MISSING")).toBeVisible();
  expect(window.url()).toBe("wi-repair://app/index.html");

  // The page has no Node: no require, no process, only the narrow bridge from the preload.
  const page = await window.evaluate(() => ({
    require: typeof (globalThis as { require?: unknown }).require,
    process: typeof (globalThis as { process?: unknown }).process,
    bridge: Object.keys(
      (globalThis as unknown as { workIntelligenceRepair: Record<string, unknown> }).workIntelligenceRepair,
    ).sort(),
    // The CSP allows no inline script: a script element built from text must not run.
    inlineScript: (() => {
      const element = document.createElement("script");
      element.textContent = "globalThis.__inlineScriptRan = true";
      document.head.append(element);
      return (globalThis as { __inlineScriptRan?: boolean }).__inlineScriptRan === true ? "ran" : "blocked";
    })(),
  }));
  expect(page.require).toBe("undefined");
  expect(page.process).toBe("undefined");
  expect(page.inlineScript).toBe("blocked");
  expect(page.bridge).toEqual([
    "chooseDatabase",
    "confirmDatabase",
    "exportDiagnostics",
    "getState",
    "openFolder",
    "retryStart",
  ]);

  // What the scheme serves: the page and its two files carry the policy; anything else is a 404 with it too.
  const served = await app.evaluate(async ({ net }) => {
    const answer = async (url: string) => {
      const response = await net.fetch(url);
      return { status: response.status, csp: response.headers.get("content-security-policy") };
    };
    return {
      page: await answer("wi-repair://app/index.html"),
      script: await answer("wi-repair://app/repair.js"),
      traversal: await answer("wi-repair://app/../../etc/passwd"),
      unknown: await answer("wi-repair://app/secret.txt"),
    };
  });
  const policy =
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  expect(served.page).toEqual({ status: 200, csp: policy });
  expect(served.script).toEqual({ status: 200, csp: policy });
  expect(served.traversal.status).toBe(404);
  expect(served.unknown.status).toBe(404);

  // Nothing in the state the page receives is a real path of this machine.
  const pageState = (await window.evaluate(() =>
    (
      globalThis as unknown as { workIntelligenceRepair: { getState(): Promise<unknown> } }
    ).workIntelligenceRepair.getState(),
  )) as { database?: { display?: string } };
  const state = JSON.stringify(pageState);
  // Both spellings of the sandbox root: as is, and as JSON escapes it (each Windows backslash doubled).
  expect(state).not.toContain(sandbox.root);
  expect(state).not.toContain(JSON.stringify(sandbox.root).slice(1, -1));
  // The product shows the platform's own separators (backslashes on Windows).
  expect(pageState.database?.display).toBe(["~", ".work-intelligence", "data", "work-intelligence.sqlite"].join(sep));
  expect(readdirSync(dirname(sandbox.databasePath))).toEqual([]);
});

test("quitting stops the backend and frees the port", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  app = await launchApp(sandbox);
  const snapshot = await waitForSnapshot(app, (state) => state.owner === "MANAGED" && state.backend !== null);
  const pid = snapshot.backend?.pid;
  if (!pid) throw new Error("no backend");

  const closed = app.waitForEvent("close", { timeout: 40_000 });
  await app.evaluate(({ app: electron }) => electron.quit()).catch(() => undefined);
  await closed;

  await expect.poll(() => processIsAlive(pid), { timeout: 10_000 }).toBe(false);
  await expect.poll(() => portIsFree(sandbox?.port ?? 0), { timeout: 10_000 }).toBe(true);
  expect(readMainLog(sandbox)).toMatch(/\[shell\] stop: graceful=true forced=false exited=true portReleased=true/);
});

test("starts without any Node on the PATH and runs the bundled runtime", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  app = await launchApp(sandbox);
  const snapshot = await waitForSnapshot(app, (state) => state.owner === "MANAGED" && state.backend !== null);
  const execPath = snapshot.backend?.execPath ?? "";
  // `.native`: it expands Windows 8.3 short names (the runner's temp folder is under `RUNNER~1`); the JS one does not.
  expect(samePathPrefix(realpathSync.native(execPath), realpathSync.native(sandbox.runtimeRoot))).toBe(true);
  expect((await readSnapshot(app)).recentErrors).toEqual([]);
});

test("a backend that dies is restarted by the bounded retry", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  app = await launchApp(sandbox);
  const first = await waitForSnapshot(app, (state) => state.owner === "MANAGED" && state.backend !== null);
  const pid = first.backend?.pid;
  if (!pid) throw new Error("no backend");

  process.kill(pid, "SIGKILL");

  const recovered = await waitForSnapshot(
    app,
    (state) => state.owner === "MANAGED" && state.backend !== null && state.backend.pid !== pid,
  );
  expect(recovered.recentErrors).toContain("CHILD_EXITED");
  // A transient exit is retried quietly: no repair window opens for it.
  expect(recovered.repairWindowOpen).toBe(false);
  expect(await healthProofIsValid(recovered.backend?.port ?? 0, recovered.backend?.runId ?? "")).toBe(true);
});

test("the repair page previews a chosen database and confirms only one that is ok", async () => {
  sandbox = await createSandbox({ withDatabase: false });
  const donor = await createSandbox({ withDatabase: true });
  let backendPid: number | undefined;
  try {
    app = await launchApp(sandbox);
    const window = await app.firstWindow({ timeout: 45_000 });
    await waitForSnapshot(app, (state) => state.owner === "NEEDS_REPAIR" && state.repairWindowOpen);

    const choose = async (path: string) => {
      // The native file dialog cannot be driven: main's dialog answers with the path under test.
      await app?.evaluate(({ dialog }, picked) => {
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [picked],
        })) as typeof dialog.showOpenDialog;
      }, path);
      await window.locator('[data-id="choose-database"]').click();
    };

    // A file that does not exist is shown with its status and offers no confirm button.
    await choose(join(donor.root, "nothing-here.sqlite"));
    await expect(window.locator('[data-id^="candidate:"]')).toHaveCount(0);
    await expect(window.getByText("nothing-here.sqlite")).toBeVisible();
    expect(existsSync(join(donor.root, "nothing-here.sqlite"))).toBe(false);

    // A database the preview found ok can be confirmed; the backend then runs on it.
    await choose(donor.databasePath);
    await expect(window.locator('[data-id^="candidate:"]')).toHaveCount(1);
    if (process.platform === "win32") {
      // Windows refuses to rename an open file: this succeeds only if the preview child closed the database it checked.
      const aside = `${donor.databasePath}.aside`;
      renameSync(donor.databasePath, aside);
      renameSync(aside, donor.databasePath);
    }
    await window.locator('[data-id^="candidate:"]').click();
    const running = await waitForSnapshot(app, (state) => state.owner === "MANAGED" && state.backend !== null);
    backendPid = running.backend?.pid;
    expect(running.backend?.port).toBe(sandbox.port);
    expect(await portIsFree(sandbox.port)).toBe(false);
  } finally {
    // The backend now runs on the donor's database and holds it open, and Windows does not delete an open file: quit the
    // App and wait for its backend to be gone before the donor folder is removed.
    await closeQuietly(app);
    app = undefined;
    if (backendPid) await expect.poll(() => processIsAlive(backendPid!), { timeout: 10_000 }).toBe(false);
    await expect.poll(() => portIsFree(sandbox?.port ?? 0), { timeout: 10_000 }).toBe(true);
    if (sandbox && backendPid) {
      const log = readMainLog(sandbox);
      expect(log).not.toContain("a preview child did not exit");
      expect(log).toMatch(/\[shell\] stop: graceful=true forced=false exited=true portReleased=true/);
    }
    removeSandbox(donor);
  }
});

test("the sandbox profile has every folder its environment names", async () => {
  sandbox = await createSandbox({ withDatabase: false });
  for (const [name, directory] of Object.entries(profileDirectories(sandbox.home))) {
    expect(statSync(directory, { throwIfNoEntry: false })?.isDirectory(), name).toBe(true);
  }
});

/** A launch that cannot find its data folder: it says so and exits 1, before any lock, tray or backend. */
async function expectStartupFailure(extra: Record<string, string>): Promise<void> {
  const exit = await runToExit(sandbox!, { WORK_INTELLIGENCE_DESKTOP_TEST_RECORD_ERROR_BOX: "1", ...extra });
  expect({ code: exit.code, signal: exit.signal }, `stderr:\n${exit.stderr}`).toEqual({ code: 1, signal: null });
  expect(exit.stderr).toContain("[shell] cannot start: the application data folder is unavailable");
  expect(exit.stderr).toMatch(/\[shell\] error box: (Work Intelligence cannot start|Work Intelligence 無法啟動)/);
  expect(existsSync(join(sandbox!.dataDirectory, "logs"))).toBe(false);
  expect(await portIsFree(sandbox!.port)).toBe(true);
}

test("a data folder that cannot be resolved closes the App with an error box instead of crashing", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  await expectStartupFailure({ WORK_INTELLIGENCE_DESKTOP_TEST_FAIL_USER_DATA: "1" });
});

/**
 * Crashpad's `kTerminationCodeNotConnectedToHandler` (crashpad util/win/termination_codes.h): what a Windows Electron
 * ends with when it crashes before its Crashpad handler is connected.
 */
const CRASHPAD_NOT_CONNECTED = 0xffff7003;

/**
 * A known limitation, recorded as it really behaves. With the profile's Roaming AppData folder gone, Electron ends in its
 * native start-up before it loads the App's script: the start-up guard never runs, so there is no error box and no
 * line of ours on stderr (CI of 48c3d02: exit 0xFFFF7003 and only Crashpad's "not connected" line). The App cannot fix
 * a profile that broken; what it must still guarantee is that it leaves nothing behind.
 */
test("on Windows, a profile without Roaming AppData ends in Electron before the App runs, leaving nothing behind", async () => {
  test.skip(process.platform !== "win32", "only Windows resolves userData through a folder that must exist");
  sandbox = await createSandbox({ withDatabase: true });
  const roaming = profileDirectories(sandbox.home).APPDATA!;
  rmSync(roaming, { recursive: true, force: true });
  // No redirect: Electron asks Windows for the real (missing) folder.
  const exit = await runToExit(sandbox, {
    WORK_INTELLIGENCE_DESKTOP_DATA_DIR: "",
    WORK_INTELLIGENCE_DESKTOP_TEST_RECORD_ERROR_BOX: "1",
  });
  expect({ code: exit.code, signal: exit.signal }, `stderr:\n${exit.stderr}`).toEqual({
    code: CRASHPAD_NOT_CONNECTED,
    signal: null,
  });
  // The App's script never ran: none of its lines, and nothing it would have created.
  expect(exit.stderr).not.toContain("[shell]");
  expect(existsSync(roaming)).toBe(false);
  expect(existsSync(join(sandbox.dataDirectory, "logs"))).toBe(false);
  expect(await portIsFree(sandbox.port)).toBe(true);
  expect(processIsAlive(exit.pid)).toBe(false);
  // Electron's own helpers (GPU, network, Crashpad) end with it.
  await expect.poll(() => windowsLeftovers(exit.pid, sandbox?.root ?? ""), { timeout: 10_000 }).toEqual([]);
});

test("a relaunch with the same backend leaves the settings file as it was", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  const settingsFile = join(sandbox.dataDirectory, "desktop-settings.json");
  app = await launchApp(sandbox);
  await waitForSnapshot(app, (state) => state.owner === "MANAGED" && state.backend !== null);
  await closeQuietly(app);
  app = undefined;
  const recorded = readFileSync(settingsFile, "utf8");
  expect(JSON.parse(recorded)).toHaveProperty("active.serviceOwner", "desktop");
  const before = statSync(settingsFile);

  app = await launchApp(sandbox);
  await waitForSnapshot(app, (state) => state.owner === "MANAGED" && state.backend !== null);
  // Same port, runtime and database: the active record is unchanged, so the start skips the fsync'd rewrite.
  expect(readFileSync(settingsFile, "utf8")).toBe(recorded);
  const after = statSync(settingsFile);
  expect({ ino: after.ino, mtimeMs: after.mtimeMs }).toEqual({ ino: before.ino, mtimeMs: before.mtimeMs });
});
