import { expect, test, type ElectronApplication } from "@playwright/test";
import { spawn } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { publishIntegrationRecord } from "@work-intelligence/desktop-core";
import {
  appEnvironment,
  attachLog,
  closeQuietly,
  createSandbox,
  electronBinary,
  launchArguments,
  launchApp,
  portIsFree,
  readMainLog,
  removeSandbox,
  runToExit,
  waitForManagedSnapshot,
  waitForSnapshot,
  type Sandbox,
} from "./helpers.js";

/**
 * The plugin's `launch.mjs dashboard` against a real App: the script reads the desktop integration record, starts the
 * App executable detached with `--open-dashboard` and exits. The executable here is a shell wrapper around the test's
 * Electron (the record names one executable, and the test App needs its main script), so POSIX only. Also measures the
 * hand-off: from the script's start to the App's `dashboard opened` log line, warm (App running) and cold (App not running).
 */

const repositoryRoot = join(import.meta.dirname, "..", "..", "..", "..");
const launchScript = join(repositoryRoot, "plugins", "work-intelligence", "scripts", "launch.mjs");
const RUNS = 3;
const OPENED = /^(\S+) \[shell\] dashboard opened$/gm;

let sandbox: Sandbox | undefined;
let app: ElectronApplication | undefined;

test.skip(process.platform === "win32", "the wrapper executable is a shell script");

test.afterEach(async ({ browserName: _browserName }, testInfo) => {
  if (sandbox) attachLog(testInfo, sandbox);
  await closeQuietly(app);
  app = undefined;
  // An App the script started is not Playwright's: ask it to quit the way an installer does.
  if (sandbox) await runToExit(sandbox, {}, 30_000, ["--quit"]).catch(() => undefined);
  if (sandbox) removeSandbox(sandbox);
  sandbox = undefined;
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The record the packaged App would have written, naming a wrapper that starts the test Electron like a user would. */
async function installIntegration(current: Sandbox): Promise<void> {
  const wrapper = join(current.root, "work-intelligence-app");
  const command = [electronBinary, ...launchArguments()].map(shellQuote).join(" ");
  writeFileSync(wrapper, `#!/bin/sh\nexec ${command} "$@"\n`);
  chmodSync(wrapper, 0o755);
  await publishIntegrationRecord(join(current.home, ".work-intelligence", "desktop-integration.json"), {
    runtimeRoot: current.runtimeRoot,
    appExecutable: wrapper,
    appVersion: "0.0.0-smoke",
  });
}

/** Runs `launch.mjs dashboard` the way an Agent skill does; resolves with when it started and how it ended. */
function runPluginDashboard(current: Sandbox): Promise<{ startedAt: number; code: number | null; stdout: string }> {
  const startedAt = Date.now();
  const child = spawn(process.execPath, [launchScript, "dashboard"], {
    cwd: current.root,
    env: appEnvironment(current),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  return new Promise((resolveRun, rejectRun) => {
    child.once("error", rejectRun);
    child.once("close", (code) => resolveRun({ startedAt, code, stdout }));
  });
}

/** Epoch milliseconds of the `index`-th (0-based) `dashboard opened` line, waiting for it. */
async function openedAt(current: Sandbox, index: number): Promise<number> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const stamps = [...readMainLog(current).matchAll(OPENED)].map((match) => Date.parse(match[1] as string));
    if (stamps.length > index) return stamps[index] as number;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error("the App never logged `dashboard opened`");
}

function median(values: readonly number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number;
}

test("the plugin hands the dashboard to a running App, which opens it once at its port", async ({
  browserName: _browserName,
}, testInfo) => {
  sandbox = await createSandbox({ withDatabase: true });
  await installIntegration(sandbox);
  app = await launchApp(sandbox);
  const first = await waitForManagedSnapshot(app);
  await waitForSnapshot(app, (state) => state.openedExternal.length === 1);

  const samples: number[] = [];
  for (let run = 1; run <= RUNS; run += 1) {
    const handOff = await runPluginDashboard(sandbox);
    expect(handOff.code).toBe(0);
    expect(handOff.stdout).toContain("desktop App");
    samples.push((await openedAt(sandbox, run)) - handOff.startedAt);
  }
  const after = await waitForSnapshot(app, (state) => state.openedExternal.length >= 1 + RUNS);
  expect(after.openedExternal.slice(1)).toEqual(Array(RUNS).fill(`http://127.0.0.1:${sandbox.port}/`));
  expect(after.backend?.pid).toBe(first.backend?.pid);
  expect(readMainLog(sandbox).match(/\[shell\] backend started/g)).toHaveLength(1);
  testInfo.annotations.push({
    type: "warm hand-off ms",
    description: `${samples.join(", ")} (median ${median(samples)})`,
  });
  console.log(`dashboard hand-off, App running: ${samples.join(", ")} ms (median ${median(samples)})`);
});

test("the plugin starts an App that is not running, which opens the dashboard once its backend is ready", async ({
  browserName: _browserName,
}, testInfo) => {
  const samples: number[] = [];
  for (let run = 1; run <= RUNS; run += 1) {
    sandbox = await createSandbox({ withDatabase: true });
    await installIntegration(sandbox);
    const handOff = await runPluginDashboard(sandbox);
    expect(handOff.code).toBe(0);
    samples.push((await openedAt(sandbox, 0)) - handOff.startedAt);
    // Exactly one open, and the backend the App manages is the only listener on its port.
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    expect(readMainLog(sandbox).match(OPENED)).toHaveLength(1);
    expect(await portIsFree(sandbox.port)).toBe(false);
    if (run < RUNS) {
      attachLog(testInfo, sandbox);
      await runToExit(sandbox, {}, 30_000, ["--quit"]);
      removeSandbox(sandbox);
      sandbox = undefined;
    }
  }
  testInfo.annotations.push({
    type: "cold hand-off ms",
    description: `${samples.join(", ")} (median ${median(samples)})`,
  });
  console.log(`dashboard hand-off, App not running: ${samples.join(", ")} ms (median ${median(samples)})`);
});
