import { expect, test } from "@playwright/test";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  chmodSync,
  writeSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import {
  backendFromLog,
  createSandbox,
  defaultRuntimeRoots,
  defaultUserDataDirectories,
  executablePathOf,
  healthStatus,
  isInside,
  leftoverProcesses,
  listProcesses,
  logLines,
  packagedExecutable,
  pollUntil,
  portIsFree,
  processIsAlive,
  profileDirectories,
  programDirectory,
  quitCommand,
  readLog,
  removeSandbox,
  resolvedPath,
  runToExit,
  sleep,
  startApp,
  stopApp,
  waitForLog,
  waitForManaged,
  type PackagedSandbox,
  type RunningApp,
  type StartOptions,
} from "./helpers.js";

const DASHBOARD_SETTLE_MS = 1_500;
// The hand-over may take 10 s or three times this test's own first backend start after the install, whichever is longer, so a slow runner is
// judged against itself; `runToExit`'s 20 s timeout stays the hard ceiling.
const SECOND_LAUNCH_FLOOR_MS = 10_000;
const SECOND_LAUNCH_FIRST_LAUNCH_FACTOR = 3;

const realDefaultDirectories = defaultUserDataDirectories(process.env);
const realRuntimeRoots = defaultRuntimeRoots(process.env);
const realRuntimeRootsBefore = new Set(realRuntimeRoots.filter((directory) => existsSync(directory)));
const realDefaultsBefore = new Set(realDefaultDirectories.filter((directory) => existsSync(directory)));

let sandbox: PackagedSandbox | undefined;
const running: RunningApp[] = [];

async function newSandbox(withDatabase = true, unsafeUserData = false): Promise<PackagedSandbox> {
  sandbox = await createSandbox({ withDatabase, unsafeUserData });
  return sandbox;
}

function launch(extra: readonly string[] = [], options: StartOptions = {}): RunningApp {
  if (!sandbox) throw new Error("no sandbox");
  const app = startApp(sandbox, extra, options);
  running.push(app);
  return app;
}

function installedRuntimeDirectory(current: PackagedSandbox): string {
  const runtimes = join(current.userData, "runtime", "runtimes");
  const [id] = readdirSync(runtimes).filter((name) => !name.startsWith("."));
  if (!id) throw new Error("no runtime installed");
  return join(runtimes, id);
}

function findFile(directory: string, names: readonly string[]): string | undefined {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(path, names);
      if (found) return found;
    } else if (entry.isFile() && names.includes(entry.name)) {
      return path;
    }
  }
  return undefined;
}

function flipOneByte(file: string, offset: number): number {
  chmodSync(file, 0o755);
  const descriptor = openSync(file, "r+");
  try {
    const byte = Buffer.alloc(1);
    readSync(descriptor, byte, 0, 1, offset);
    const original = byte[0] ?? 0;
    writeSync(descriptor, Buffer.from([original ^ 0x01]), 0, 1, offset);
    return original;
  } finally {
    closeSync(descriptor);
  }
}

function byteAt(file: string, offset: number): number {
  return readFileSync(file).subarray(offset, offset + 1)[0] ?? -1;
}

test.afterEach(async ({ browserName: _browserName }, testInfo) => {
  if (sandbox) {
    const log = readLog(sandbox);
    if (log) await testInfo.attach("desktop-main.log", { body: log, contentType: "text/plain" });
  }
  for (const app of running.splice(0)) {
    if (sandbox) await stopApp(sandbox, app);
    else app.kill();
  }
  if (sandbox) await removeSandbox(sandbox);
  sandbox = undefined;
});

test.afterAll(() => {
  for (const directory of realDefaultDirectories) {
    if (!realDefaultsBefore.has(directory))
      expect(existsSync(directory), `${directory} must not be created`).toBe(false);
  }
  for (const directory of realRuntimeRoots) {
    if (!realRuntimeRootsBefore.has(directory))
      expect(existsSync(directory), `${directory} must not be created`).toBe(false);
  }
});

// Interactive: the only test of ADR-01's "an interactive launch opens the Dashboard" (the browser it starts is ended by
// `removeSandbox`). Everything else about the first start is the same in background mode.
test("an interactive start is MANAGED without Node on PATH, on the bundled runtime installed into userData, and opens the Dashboard", async () => {
  const current = await newSandbox();
  launch([], { interactive: true });
  const backend = await waitForManaged(current);
  await waitForLog(current, /\[shell\] dashboard opened/, 20_000);
  expect(logLines(current, /\[shell\] dashboard opened/)).toHaveLength(1);

  const log = readLog(current);
  expect(log.indexOf("[shell] runtime installed")).toBeGreaterThanOrEqual(0);
  expect(log.indexOf("[shell] runtime installed")).toBeLessThan(log.indexOf("[shell] owner MANAGED"));
  expect(await healthStatus(backend.port)).toBe(200);
  expect(backend.port).toBe(current.port);

  const executable = executablePathOf(backend.pid, listProcesses());
  expect(executable, "the backend's executable").toBeDefined();
  const runtimes = resolvedPath(join(current.userData, "runtime", "runtimes"));
  const resolvedExecutable = resolvedPath(executable ?? "");
  expect(
    isInside(runtimes, resolvedExecutable),
    `the backend's executable ${resolvedExecutable} (as reported: ${executable}) lies under ${runtimes}`,
  ).toBe(true);

  for (const directory of defaultRuntimeRoots({ ...profileDirectories(current.home) })) {
    expect(existsSync(directory), `${directory} must not be created`).toBe(false);
  }
  for (const directory of defaultUserDataDirectories({ HOME: current.home, USERPROFILE: current.home })) {
    expect(existsSync(directory), `${directory} must not be created`).toBe(false);
  }
});

test("a second launch exits quickly and leaves the first instance with the only backend", async () => {
  const current = await newSandbox();
  const first = launch();
  const launchedAt = performance.now();
  // The first start installs the runtime; only the time after the install is this runner's speed at starting the backend.
  const installedAt = waitForLog(current, /\[shell\] runtime installed /).then(
    () => performance.now(),
    () => launchedAt,
  );
  const backend = await waitForManaged(current);
  const firstLaunchMs = performance.now() - (await installedAt);
  // The first instance is a background launch: it opened nothing. Only the second launch asks it to open the Dashboard.
  await sleep(DASHBOARD_SETTLE_MS);
  expect(logLines(current, /\[shell\] dashboard opened/), "a background launch opens no Dashboard").toEqual([]);

  const boundMs = Math.max(SECOND_LAUNCH_FLOOR_MS, SECOND_LAUNCH_FIRST_LAUNCH_FACTOR * firstLaunchMs);
  process.stdout.write(
    `[perf] second launch first launch ms=${Math.round(firstLaunchMs)} bound ms=${Math.round(boundMs)}\n`,
  );
  const started = performance.now();
  // The hand-over makes the first instance open the Dashboard: the browser it starts is expected (and ended on CI).
  const second = await runToExit(current, [], 20_000, { opensDashboard: true }).finally(() => {
    process.stdout.write(`[perf] second launch handover ms=${Math.round(performance.now() - started)}\n`);
  });
  const handoverMs = performance.now() - started;
  expect(second.code).toBe(0);
  expect(handoverMs, `the hand-over took ${Math.round(handoverMs)} ms, bound ${Math.round(boundMs)} ms`).toBeLessThan(
    boundMs,
  );
  await waitForLog(current, /\[shell\] dashboard opened/, 20_000);
  expect(logLines(current, /\[shell\] dashboard opened/), "the hand-over opens the Dashboard once").toHaveLength(1);

  expect(first.hasExited()).toBe(false);
  expect(backendFromLog(current)).toEqual(backend);
  expect(logLines(current, /\[shell\] backend started/)).toHaveLength(1);
  expect(processIsAlive(backend.pid)).toBe(true);
  expect(await healthStatus(backend.port)).toBe(200);
});

test("a missing database shows the repair window and creates no database", async () => {
  const current = await newSandbox(false);
  const app = launch([], { interactive: true });
  await waitForLog(current, /\[shell\] repair window shown/);

  expect(existsSync(current.databasePath)).toBe(false);
  expect(logLines(current, /\[shell\] backend started/)).toHaveLength(0);
  expect(await portIsFree(current.port)).toBe(true);

  expect((await quitCommand(current)).code).toBe(0);
  expect((await app.exited).code).toBe(0);
  expect(existsSync(current.databasePath)).toBe(false);
});

test("a userData folder writable by BUILTIN\\Users is refused: repair window, no runtime, no backend", async () => {
  test.skip(
    process.platform !== "win32",
    "the ACL check is Windows only; POSIX modes are covered by desktop-core tests",
  );
  const current = await newSandbox(true, true);
  const app = launch([], { interactive: true });
  await waitForLog(current, /\[shell\] runtime install failed: RUNTIME_UNSAFE_PERMISSIONS/);
  await waitForLog(current, /\[shell\] repair window shown/);

  expect(logLines(current, /\[shell\] owner NEEDS_REPAIR/).length).toBeGreaterThan(0);
  expect(logLines(current, /\[shell\] backend started/)).toHaveLength(0);
  expect(existsSync(join(current.userData, "runtime", "current"))).toBe(false);
  expect(await portIsFree(current.port)).toBe(true);
  expect(app.hasExited()).toBe(false);

  expect((await quitCommand(current)).code).toBe(0);
  expect((await app.exited).code).toBe(0);
});

test("--quit stops the backend, frees the port and leaves no process behind", async () => {
  const current = await newSandbox();
  const app = launch();
  const backend = await waitForManaged(current);
  // A background launch reaches MANAGED without opening the Dashboard, so no external browser exists and the leftover
  // check below needs no exception: every process it finds is the App's.
  await sleep(DASHBOARD_SETTLE_MS);
  expect(logLines(current, /\[shell\] dashboard opened/), "a background launch opens no Dashboard").toEqual([]);

  const quit = await quitCommand(current);
  expect(quit.code).toBe(0);
  const exit = await app.exited;
  expect(exit.code).toBe(0);

  await pollUntil(
    async () => (!processIsAlive(backend.pid) && (await portIsFree(backend.port)) ? true : undefined),
    "the backend gone and its port free",
    20_000,
  );
  expect(logLines(current, /\[shell\] quit requested by --quit/)).toHaveLength(1);
  const markers = [current.root, programDirectory(packagedExecutable())];
  await pollUntil(
    () => (leftoverProcesses(markers).length === 0 ? true : undefined),
    "no leftover process",
    20_000,
  ).catch(() => undefined);
  expect(leftoverProcesses(markers)).toEqual([]);
});

test("the second cold start reuses the installed runtime", async () => {
  const current = await newSandbox();
  const first = launch();
  await waitForManaged(current);
  await stopApp(current, first);
  expect(logLines(current, /\[shell\] runtime installed/)).toHaveLength(1);

  const since = readLog(current).length;
  launch();
  await waitForManaged(current, since);
  expect(readLog(current).slice(since)).toMatch(/\[shell\] runtime already-current /);
  expect(readLog(current).slice(since)).not.toMatch(/\[shell\] runtime (installed|reinstalled)/);
});

test("a tampered installed runtime is reinstalled from the bundle before anything runs", async () => {
  const current = await newSandbox();
  const first = launch();
  await waitForManaged(current);
  await stopApp(current, first);

  const node = findFile(installedRuntimeDirectory(current), ["node", "node.exe"]);
  expect(node, "the installed Node binary").toBeDefined();
  const offset = Math.min(4096, statSync(node ?? "").size - 1);
  const original = flipOneByte(node ?? "", offset);

  const since = readLog(current).length;
  launch();
  await waitForManaged(current, since);

  // The launcher refused the tampered file, the App reinstalled once from the bundle, and only then started the backend.
  const log = readLog(current).slice(since);
  expect(log).toMatch(/\[shell\] runtime reinstalled after the backend refused it/);
  expect(log.indexOf("runtime reinstalled after the backend refused it")).toBeLessThan(
    log.lastIndexOf("[shell] backend started"),
  );
  expect(byteAt(node ?? "", offset)).toBe(original);
});

test("--remote-debugging-port is refused: exit 1, no backend", async () => {
  const current = await newSandbox();
  const started = performance.now();
  const exit = await runToExit(current, ["--remote-debugging-port=0"], 20_000);

  expect(exit.code).toBe(1);
  expect(performance.now() - started).toBeLessThan(15_000);
  expect(exit.stderr).toContain("refusing to run with --remote-debugging-port");
  expect(logLines(current, /\[shell\] backend started/)).toHaveLength(0);
  expect(await portIsFree(current.port)).toBe(true);
  expect(leftoverProcesses([current.root])).toEqual([]);
});
