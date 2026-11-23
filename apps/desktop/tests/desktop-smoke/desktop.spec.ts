import { expect, test, type ElectronApplication } from "@playwright/test";
import { diagnosticsMessages } from "@work-intelligence/desktop-core/shell/diagnostics-i18n";
import { formatMessage } from "@work-intelligence/desktop-core/shell/i18n";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
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
  waitForManagedSnapshot,
  waitForSnapshot,
  type Sandbox,
  openTab,
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

  const snapshot = await waitForManagedSnapshot(app);
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
  const first = await waitForManagedSnapshot(app);
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

test("a second launch with --open-dashboard opens the Dashboard once more and starts no second backend", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  app = await launchApp(sandbox);
  const first = await waitForManagedSnapshot(app);
  const pid = first.backend?.pid;
  if (!pid) throw new Error("no backend");
  // The interactive start opens the Dashboard once; the request below must add exactly one more.
  await waitForSnapshot(app, (state) => state.openedExternal.length === 1);

  const second = await runToExit(sandbox, {}, 20_000, ["--open-dashboard"]);
  expect({ code: second.code, signal: second.signal }, `second instance stderr:\n${second.stderr}`).toEqual({
    code: 0,
    signal: null,
  });

  const after = await waitForSnapshot(app, (state) => state.openedExternal.length >= 2);
  expect(after.lastSecondInstanceDecision).toBe("open-dashboard");
  expect(after.secondInstanceCount).toBe(1);
  // It reaches the running instance at its current port, and nothing else happens after it.
  expect(after.openedExternal).toEqual(Array(2).fill(`http://127.0.0.1:${sandbox.port}/`));
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  const settled = await readSnapshot(app);
  expect(settled.openedExternal).toHaveLength(2);
  expect(settled.backend?.pid).toBe(pid);
  expect(await portIsFree(sandbox.port)).toBe(false);
  const log = readMainLog(sandbox);
  expect(log.match(/\[shell\] backend started/g)).toHaveLength(1);
  expect(log.match(/\[shell\] dashboard requested by --open-dashboard/g)).toHaveLength(1);
});

test("a first launch with --open-dashboard opens the Dashboard once, when the backend is ready, even in the background", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  // `--background` alone opens nothing; the flag is what asks for the Dashboard.
  app = await launchApp(sandbox, {}, ["--background", "--open-dashboard"]);
  const ready = await waitForManagedSnapshot(app);
  const opened = await waitForSnapshot(app, (state) => state.openedExternal.length > 0);
  expect(opened.openedExternal).toEqual([`http://127.0.0.1:${ready.backend?.port}/`]);
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  expect((await readSnapshot(app)).openedExternal).toHaveLength(1);
  expect(readMainLog(sandbox).match(/\[shell\] dashboard opened/g)).toHaveLength(1);
});

test("a background start opens no Dashboard and shows no repair success feedback", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  app = await launchApp(sandbox, {}, ["--background"]);
  await waitForManagedSnapshot(app);
  await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));

  const settled = await readSnapshot(app);
  expect(settled.openedExternal).toEqual([]);
  expect(settled.notifications).toEqual([]);
  expect(settled.repairWindowOpen).toBe(false);
  expect(readMainLog(sandbox)).not.toMatch(/\[shell\] dashboard opened/);
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
  // The whole bridge, so a new method is a reviewed change: every one sends only ids, booleans and enum names to main.
  expect(page.bridge).toEqual([
    "acknowledgeRecovery",
    "agentsApply",
    "agentsDiscard",
    "agentsGetState",
    "agentsPreview",
    "agentsRemovePreview",
    "agentsSelfTest",
    "agentsUndo",
    "agentsUseCheckoutDatabase",
    "approveMigration",
    "checkForUpdates",
    "chooseBackupDirectory",
    "chooseDatabase",
    "confirmDatabase",
    "copyToLocal",
    "getState",
    "getTab",
    "legacyDisableConfirm",
    "legacyDisablePreview",
    "legacyRecheck",
    "legacyStartNow",
    "onSelectTab",
    "onUpdateChanged",
    "openFolder",
    "openSystemSettings",
    "openUpdateLink",
    "portChange",
    "previewDiagnostics",
    "rememberTab",
    "restoreList",
    "restorePick",
    "restoreRun",
    "retryStart",
    "runMaintenance",
    "saveDiagnostics",
    "setLanguage",
    "setLaunchAtLogin",
    "setupChooseFile",
    "setupCopyToLocal",
    "setupGetState",
    "setupLater",
    "setupUseDefaults",
    "setupUseSource",
    "showAgents",
    "startAnyway",
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
      styles: await answer("wi-repair://app/repair.css"),
      tokens: await answer("wi-repair://app/tokens.css"),
      traversal: await answer("wi-repair://app/../../etc/passwd"),
      unknown: await answer("wi-repair://app/secret.txt"),
    };
  });
  const policy =
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  expect(served.page).toEqual({ status: 200, csp: policy });
  expect(served.script).toEqual({ status: 200, csp: policy });
  expect(served.styles).toEqual({ status: 200, csp: policy });
  expect(served.tokens).toEqual({ status: 200, csp: policy });
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
  const snapshot = await waitForManagedSnapshot(app);
  const pid = snapshot.backend?.pid;
  if (!pid) throw new Error("no backend");

  const closed = app.waitForEvent("close", { timeout: 40_000 });
  await app.evaluate(({ app: electron }) => electron.quit()).catch(() => undefined);
  await closed;

  await expect.poll(() => processIsAlive(pid), { timeout: 10_000 }).toBe(false);
  await expect.poll(() => portIsFree(sandbox?.port ?? 0), { timeout: 10_000 }).toBe(true);
  expect(readMainLog(sandbox)).toMatch(/\[shell\] stop: graceful=true forced=false exited=true portReleased=true/);
});

test("--quit asks the running App for its non-interactive quit: backend stopped, port free, exit 0 for both", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  app = await launchApp(sandbox);
  const snapshot = await waitForManagedSnapshot(app);
  const pid = snapshot.backend?.pid;
  if (!pid) throw new Error("no backend");

  const closed = app.waitForEvent("close", { timeout: 40_000 });
  const quit = await runToExit(sandbox, {}, 20_000, ["--quit"]);
  expect({ code: quit.code, signal: quit.signal }, `--quit stderr:\n${quit.stderr}`).toEqual({ code: 0, signal: null });
  await closed;

  await expect.poll(() => processIsAlive(pid), { timeout: 10_000 }).toBe(false);
  await expect.poll(() => portIsFree(sandbox?.port ?? 0), { timeout: 10_000 }).toBe(true);
  const log = readMainLog(sandbox);
  expect(log).toMatch(/\[shell\] quit requested by --quit/);
  expect(log).toMatch(/\[shell\] stop: graceful=true forced=false exited=true portReleased=true/);
});

test("--quit with nothing running exits 0 at once and starts nothing", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  const quit = await runToExit(sandbox, {}, 20_000, ["--quit"]);
  expect({ code: quit.code, signal: quit.signal }, `--quit stderr:\n${quit.stderr}`).toEqual({ code: 0, signal: null });
  expect(await portIsFree(sandbox.port)).toBe(true);
  expect(readMainLog(sandbox)).not.toMatch(/backend started/);
});

test("starts without any Node on the PATH and runs the bundled runtime", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  app = await launchApp(sandbox);
  const snapshot = await waitForManagedSnapshot(app);
  const execPath = snapshot.backend?.execPath ?? "";
  // `.native`: it expands Windows 8.3 short names (the runner's temp folder is under `RUNNER~1`); the JS one does not.
  expect(samePathPrefix(realpathSync.native(execPath), realpathSync.native(sandbox.runtimeRoot))).toBe(true);
  expect((await readSnapshot(app)).recentErrors).toEqual([]);
});

test("a backend that dies is restarted by the bounded retry", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  app = await launchApp(sandbox);
  const first = await waitForManagedSnapshot(app);
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
    // The success card stays long enough for the assertions below to see it before the window closes.
    app = await launchApp(sandbox, { WORK_INTELLIGENCE_DESKTOP_TEST_REPAIR_SUCCESS_DELAY_MS: "3000" });
    const window = await app.firstWindow({ timeout: 45_000 });
    const failed = await waitForSnapshot(app, (state) => state.owner === "NEEDS_REPAIR" && state.repairWindowOpen);
    // The failed start opened no Dashboard and sent no success notification.
    expect(failed.openedExternal).toEqual([]);
    expect(failed.notifications).toEqual([]);

    // The failed start opened Status (the blocking tab); choosing a database is the Data tab's.
    await openTab(window, "data");
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

    // The user's repair worked: the window shows the success card (the language follows the OS) with the database and
    // the project count of the fictional donor database, and the stale DB_MISSING error is gone.
    // (The success card is the Status tab's; the user is looking at Data, so the test goes back to Status as a user does.)
    await openTab(window, "status");
    const card = window.locator("#recovered");
    await expect(card).toContainText(/✓ (已恢復|Recovered)/);
    await expect(card).toContainText(/0 (projects|個專案)/);
    await expect(card).toContainText("work-intelligence.sqlite");
    await expect(window.getByText("DB_MISSING")).toHaveCount(0);
    const celebrating = await readSnapshot(app);
    expect(celebrating.recentErrors).toEqual([]);
    expect(celebrating.notifications).toHaveLength(1);
    expect(celebrating.notifications[0]).toMatch(/Work Intelligence (已可使用|is ready)/);

    // Then the window closes and the Dashboard opens exactly once.
    const done = await waitForSnapshot(app, (state) => !state.repairWindowOpen && state.openedExternal.length > 0);
    expect(done.openedExternal).toEqual([`http://127.0.0.1:${sandbox.port}/`]);
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    const settled = await readSnapshot(app);
    expect(settled.openedExternal).toHaveLength(1);
    expect(settled.notifications).toHaveLength(1);
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
  await waitForManagedSnapshot(app);
  await closeQuietly(app);
  app = undefined;
  const recorded = readFileSync(settingsFile, "utf8");
  expect(JSON.parse(recorded)).toHaveProperty("active.serviceOwner", "desktop");
  const before = statSync(settingsFile);

  app = await launchApp(sandbox);
  await waitForManagedSnapshot(app);
  // Same port, runtime and database: the active record is unchanged, so the start skips the fsync'd rewrite.
  expect(readFileSync(settingsFile, "utf8")).toBe(recorded);
  const after = statSync(settingsFile);
  expect({ ino: after.ino, mtimeMs: after.mtimeMs }).toEqual({ ino: before.ino, mtimeMs: before.mtimeMs });
});

test("exports diagnostics through a preview: the saved file is the previewed text and holds none of what was planted", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  app = await launchApp(sandbox);
  await waitForManagedSnapshot(app);

  // Synthetic markers the file must not contain: a token, another user's home paths, an e-mail address, a line of work content.
  const planted = {
    token: ["ghp", "SyntheticSmokeToken0123456789abcdef"].join("_"),
    posixPath: "/home/synthetic-other-user/ClientX/notes.md",
    windowsPath: "C:\\Users\\SyntheticOtherUser\\ClientX\\notes.md",
    email: "synthetic.person@example.test",
    work: "SYNTHETIC-WORK-CONTENT rewrote the orchard irrigation schedule",
  };
  type TestHook = { plantOutput(lines: readonly string[]): void; openRepair(): void };
  await app.evaluate(
    (_electron, lines) =>
      (globalThis as unknown as { __workIntelligenceDesktopTest: TestHook }).__workIntelligenceDesktopTest.plantOutput(
        lines,
      ),
    [
      `[backend] token=${planted.token}`,
      `[shell] opening ${planted.posixPath}`,
      `[shell] opening ${planted.windowsPath}`,
      `[shell] mail ${planted.email}`,
      planted.work,
    ],
  );
  await app.evaluate(() =>
    (globalThis as unknown as { __workIntelligenceDesktopTest: TestHook }).__workIntelligenceDesktopTest.openRepair(),
  );
  const window = await app.firstWindow({ timeout: 45_000 });
  const lang = await window.evaluate(() => document.documentElement.lang);
  const text = diagnosticsMessages(lang === "zh-Hant" ? "zh-TW" : "en");
  const trigger = window.locator('[data-id="export-diagnostics"]');
  const panel = window.locator("dialog.preview-dialog");
  const box = panel.locator("textarea.preview-text");

  // A preview that was replaced by a newer one, or already saved, cannot be saved: the page previews again.
  const stale = await window.evaluate(async () => {
    const api = (
      globalThis as unknown as {
        workIntelligenceRepair: {
          previewDiagnostics(): Promise<{ ok: boolean; previewId?: string }>;
          saveDiagnostics(previewId: string): Promise<{ ok: boolean; reason?: string }>;
        };
      }
    ).workIntelligenceRepair;
    const first = await api.previewDiagnostics();
    await api.previewDiagnostics();
    return {
      first: await api.saveDiagnostics(first.previewId ?? ""),
      unknown: await api.saveDiagnostics("00000000-0000-4000-8000-000000000000"),
    };
  });
  expect(stale).toEqual({ first: { ok: false, reason: "expired" }, unknown: { ok: false, reason: "expired" } });

  // The export button lives on the Diagnostics tab; the window opened on Status, so the test selects the tab as a user does.
  await openTab(window, "diagnostics");
  // Esc closes the panel and focus goes back to the button that opened it.
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  await trigger.click();
  await expect(panel).toBeVisible();
  await expect(box).toBeFocused();
  await window.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(trigger).toBeFocused();

  // The saved file's place is chosen by the (stubbed) native dialog.
  const outputDirectory = join(sandbox.root, "exported");
  mkdirSync(outputDirectory);
  const target = join(outputDirectory, "work-intelligence-diagnostics.json");
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog;
  }, target);

  await trigger.click();
  await expect(panel).toBeVisible();
  const previewed = await box.inputValue();
  expect(existsSync(target)).toBe(false);

  // The summary says what was masked and how many lines of other output were skipped.
  const parsed = JSON.parse(previewed) as { omittedOutputLines: number; recentOutput: string[] };
  expect(parsed.omittedOutputLines).toBeGreaterThanOrEqual(1);
  const summary = (await panel.locator(".preview-summary p").first().innerText()).trim();
  const numbers = summary.match(/\d+/g)?.map(Number) ?? [];
  const [paths = 0, authCodes = 0, tokens = 0, emails = 0, omitted = 0] = numbers;
  expect(paths).toBeGreaterThanOrEqual(2);
  expect(authCodes).toBe(0);
  expect(tokens).toBeGreaterThanOrEqual(1);
  expect(emails).toBe(1);
  expect(omitted).toBe(parsed.omittedOutputLines);
  expect(summary).toBe(
    formatMessage(text.summary, {
      paths: String(paths),
      authCodes: String(authCodes),
      tokens: String(tokens),
      emails: String(emails),
      omitted: String(omitted),
    }),
  );

  await panel.locator('[data-id="diagnostics-save"]').click();
  await expect(panel).toBeHidden();
  await expect(window.locator("#status")).toHaveText(text.saved);

  // The file is exactly the text the user read, and the planted values are in neither.
  const saved = readFileSync(target, "utf8");
  expect(saved).toBe(previewed);
  if (process.platform !== "win32") expect(statSync(target).mode & 0o777).toBe(0o600);
  for (const value of [
    planted.token,
    "SyntheticSmokeToken",
    "synthetic-other-user",
    "SyntheticOtherUser",
    "ClientX",
    planted.email,
    "SYNTHETIC-WORK-CONTENT",
    "orchard",
    sandbox.root,
  ]) {
    expect(saved, value).not.toContain(value);
  }
  expect(parsed.recentOutput).toContain("[backend] token=[redacted]");
  expect(parsed.recentOutput.filter((line) => line === "[shell] opening [redacted path]")).toHaveLength(2);
  expect(parsed.recentOutput).toContain("[shell] mail [redacted email]");
});

test("hooks installed in launcher form read as installed on the Agent page and in the status API", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { CODEX_POST_TOOL_USE_MATCHER, commandForLauncherHook } = await import("@work-intelligence/agent-setup");
  const { launcherShimPath } = await import("@work-intelligence/desktop-core");
  const { setupMessages } = await import("@work-intelligence/desktop-core/shell/setup-i18n");

  sandbox = await createSandbox({ withDatabase: true });
  // What the App's "套用變更" writes: the fixed launcher shim and the plain launcher action, in the sandbox home only.
  const shim = launcherShimPath(sandbox.runtimeRoot, process.platform);
  const claudeCommand = commandForLauncherHook(shim, "claude-finalize-reminder", process.platform);
  const codexCommand = commandForLauncherHook(shim, "codex-finalize-reminder", process.platform);
  const handler = (command: string) => [{ type: "command", command }];
  mkdirSync(join(sandbox.home, ".claude"), { recursive: true });
  mkdirSync(join(sandbox.home, ".codex"), { recursive: true });
  writeFileSync(
    join(sandbox.home, ".claude", "settings.json"),
    JSON.stringify({ hooks: { Stop: [{ hooks: handler(claudeCommand) }] } }),
  );
  writeFileSync(
    join(sandbox.home, ".codex", "hooks.json"),
    JSON.stringify({
      hooks: {
        Stop: [{ hooks: handler(codexCommand) }],
        PostToolUse: [{ matcher: CODEX_POST_TOOL_USE_MATCHER, hooks: handler(codexCommand) }],
      },
    }),
  );

  app = await launchApp(sandbox, {}, ["--open-agent-setup"]);
  const running = await waitForManagedSnapshot(app);
  const window = await app.firstWindow({ timeout: 45_000 });
  const language = await window.evaluate(() => document.documentElement.lang);
  const text = setupMessages(language === "zh-Hant" ? "zh-TW" : "en");

  // The Agent page: the hook is installed, managed by the App.
  for (const agent of ["codex", "claude-code"]) {
    await expect(window.locator(`[data-agent="${agent}"]`)).toContainText(text.agentHookInstalled.app);
  }

  // The status the Web UI shows (the doctor's view of the same files).
  const response = await fetch(`http://127.0.0.1:${running.backend?.port}/api/system/status`);
  const body = (await response.json()) as {
    agents?: Record<"codex" | "claudeCode", { hook: string; hookSource?: string; hookEvents?: { state: string }[] }>;
    mcp?: { monitoringAvailable: boolean; message: string };
  };
  // The packaged runtime's MCP build is readable: the page must not ask for a reconnect that cannot fix anything.
  expect(body.mcp?.monitoringAvailable).toBe(true);
  expect(body.mcp?.message).not.toContain("無法確認");
  for (const agent of ["codex", "claudeCode"] as const) {
    expect(body.agents?.[agent]?.hook).toBe("installed");
    expect(body.agents?.[agent]?.hookSource).toBe("app");
  }
  expect(body.agents?.codex.hookEvents?.filter((event) => event.state === "installed")).toHaveLength(2);
});
