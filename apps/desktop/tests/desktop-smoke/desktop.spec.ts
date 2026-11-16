import { expect, test, type ElectronApplication } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  attachLog,
  closeQuietly,
  createSandbox,
  healthProofIsValid,
  launchApp,
  portIsFree,
  processIsAlive,
  readMainLog,
  readSnapshot,
  removeSandbox,
  runSecondInstance,
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
  // The interactive start opens the Dashboard (recorded, not launched, in the test).
  expect(snapshot.openedExternal).toEqual([`http://127.0.0.1:${backend.port}/`]);
});

test("a second launch exits at once and the first keeps the only backend", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  app = await launchApp(sandbox);
  const first = await waitForSnapshot(app, (state) => state.owner === "MANAGED" && state.backend !== null);
  const pid = first.backend?.pid;
  if (!pid) throw new Error("no backend");

  const second = await runSecondInstance(sandbox);
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
  const state = JSON.stringify(
    await window.evaluate(() =>
      (
        globalThis as unknown as { workIntelligenceRepair: { getState(): Promise<unknown> } }
      ).workIntelligenceRepair.getState(),
    ),
  );
  expect(state).not.toContain(sandbox.root);
  expect(state).toContain("~/.work-intelligence/data/work-intelligence.sqlite");
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
    await window.locator('[data-id^="candidate:"]').click();
    const running = await waitForSnapshot(app, (state) => state.owner === "MANAGED" && state.backend !== null);
    expect(running.backend?.port).toBe(sandbox.port);
    expect(await portIsFree(sandbox.port)).toBe(false);
  } finally {
    removeSandbox(donor);
  }
});
