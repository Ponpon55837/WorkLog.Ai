import { _electron, type ElectronApplication, type TestInfo } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { WorkIntelligenceStore } from "@work-intelligence/storage";
import {
  INSTANCE_CHALLENGE_HEADER,
  INSTANCE_PROOF_HEADER,
  computeInstanceProof,
} from "@work-intelligence/shared/instance-proof";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..", "..");

export const mainEntry = join(desktopRoot, "dist", "main", "index.mjs");
/** The path of the Electron binary (the `electron` package exports it). */
export const electronBinary: string = require("electron") as string;

/** What the main process shows through its non-packaged test hook. */
export interface MainSnapshot {
  owner: string;
  backend: { pid: number; port: number; execPath: string; runId: string } | null;
  repairWindowOpen: boolean;
  secondInstanceCount: number;
  lastSecondInstanceDecision: string | null;
  openedExternal: string[];
  recentErrors: string[];
  logFile: string;
}

export interface Sandbox {
  readonly root: string;
  readonly home: string;
  readonly dataDirectory: string;
  readonly databasePath: string;
  readonly port: number;
  readonly emptyBin: string;
  readonly runtimeRoot: string;
}

/** The runtime the smoke script built; the specs never build one themselves. */
export function runtimeRootFromEnvironment(): string {
  const value = process.env.WORK_INTELLIGENCE_SMOKE_RUNTIME_ROOT;
  if (!value) throw new Error("WORK_INTELLIGENCE_SMOKE_RUNTIME_ROOT is not set; run `pnpm test:desktop-smoke`.");
  return value;
}

export async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolvePort(port));
    });
  });
}

export async function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolveFree) => {
    const server = net.createServer();
    server.once("error", () => resolveFree(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolveFree(true)));
  });
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Synthetic data only: a database created by the real store in a temporary folder, never anything of the developer's. */
export async function createSandbox(options: { withDatabase: boolean }): Promise<Sandbox> {
  const root = realpathSync(mkdtempSync(join(os.tmpdir(), "wi-desktop-smoke-")));
  const home = join(root, "home");
  const dataDirectory = join(root, "data");
  const emptyBin = join(root, "empty-bin");
  for (const directory of [home, dataDirectory, emptyBin]) mkdirSync(directory, { recursive: true });
  // Under the isolated home, where the product keeps it, so the repair page shows it as `~/…`.
  const databasePath = join(home, ".work-intelligence", "data", "work-intelligence.sqlite");
  mkdirSync(dirname(databasePath), { recursive: true });
  if (options.withDatabase) new WorkIntelligenceStore(databasePath).close();
  const port = await freePort();
  const runtimeRoot = runtimeRootFromEnvironment();
  writeFileSync(
    join(dataDirectory, "desktop-settings.json"),
    `${JSON.stringify(
      {
        configVersion: 1,
        installId: "synthetic-install-id",
        desired: {
          databasePath,
          port,
          launchAtLogin: false,
          backupDirectory: join(home, ".work-intelligence", "backups"),
        },
      },
      null,
      2,
    )}\n`,
  );
  return { root, home, dataDirectory, databasePath, port, emptyBin, runtimeRoot };
}

export function removeSandbox(sandbox: Sandbox): void {
  rmSync(sandbox.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/** The environment the app runs in: an isolated home, the test switches, and a PATH without any Node. */
export function appEnvironment(sandbox: Sandbox, extra: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (name.startsWith("WORK_INTELLIGENCE_") || name === "ELECTRON_RUN_AS_NODE" || name === "NODE_OPTIONS") continue;
    base[name] = value;
  }
  const systemDirectory = process.env.SystemRoot ? join(process.env.SystemRoot, "System32") : sandbox.emptyBin;
  return {
    ...base,
    HOME: sandbox.home,
    USERPROFILE: sandbox.home,
    APPDATA: join(sandbox.home, "AppData", "Roaming"),
    LOCALAPPDATA: join(sandbox.home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(sandbox.home, ".config"),
    XDG_DATA_HOME: join(sandbox.home, ".local", "share"),
    XDG_STATE_HOME: join(sandbox.home, ".local", "state"),
    XDG_CACHE_HOME: join(sandbox.home, ".cache"),
    PATH: process.platform === "win32" ? systemDirectory : sandbox.emptyBin,
    WORK_INTELLIGENCE_DESKTOP_DATA_DIR: sandbox.dataDirectory,
    WORK_INTELLIGENCE_DESKTOP_RUNTIME_ROOT: sandbox.runtimeRoot,
    WORK_INTELLIGENCE_DESKTOP_TEST_AUTOCONFIRM_QUIT: "1",
    WORK_INTELLIGENCE_DESKTOP_TEST_RECORD_EXTERNAL: "1",
    ...extra,
  };
}

/** Chromium refuses to run its sandbox as root (a Linux container); only the test's launch arguments say otherwise. */
export function launchArguments(): string[] {
  const root = process.platform === "linux" && typeof process.getuid === "function" && process.getuid() === 0;
  return [mainEntry, ...(root ? ["--no-sandbox"] : [])];
}

const closedApplications = new WeakSet<ElectronApplication>();

export async function launchApp(sandbox: Sandbox, extra: Record<string, string> = {}): Promise<ElectronApplication> {
  const launched = await _electron.launch({
    executablePath: electronBinary,
    args: launchArguments(),
    env: appEnvironment(sandbox, extra),
    timeout: 60_000,
  });
  launched.on("close", () => closedApplications.add(launched));
  return launched;
}

/** Starts a second Electron on the same data directory, as a user double-clicking the App again would. */
export function launchSecondInstance(sandbox: Sandbox): ChildProcess {
  return spawn(electronBinary, launchArguments(), { env: appEnvironment(sandbox), stdio: "ignore" });
}

export function readSnapshot(app: ElectronApplication): Promise<MainSnapshot> {
  return app.evaluate(
    () =>
      (
        globalThis as unknown as { __workIntelligenceDesktopTest: { snapshot(): unknown } }
      ).__workIntelligenceDesktopTest.snapshot() as never,
  );
}

/** Polls the hook until `done` holds, then returns that snapshot. */
export async function waitForSnapshot(
  app: ElectronApplication,
  done: (snapshot: MainSnapshot) => boolean,
  timeoutMs = 45_000,
): Promise<MainSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let last: MainSnapshot | undefined;
  while (Date.now() < deadline) {
    last = await readSnapshot(app);
    if (done(last)) return last;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(
    `condition not met in ${timeoutMs} ms; last owner=${last?.owner} errors=${last?.recentErrors.join(",")}`,
  );
}

/** The health endpoint must prove the answering process is the child this App started (HMAC of a fresh challenge). */
export async function healthProofIsValid(port: number, runId: string): Promise<boolean> {
  const challenge = `smoke-challenge-${Date.now()}-abcdefghij`;
  const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
    headers: { [INSTANCE_CHALLENGE_HEADER]: challenge },
  });
  return (
    response.status === 200 && response.headers.get(INSTANCE_PROOF_HEADER) === computeInstanceProof(runId, challenge)
  );
}

/** Keeps the main log with the test result so a CI failure can be read afterwards. */
export function attachLog(testInfo: TestInfo, sandbox: Sandbox): void {
  try {
    const text = readFileSync(join(sandbox.dataDirectory, "logs", "desktop-main.log"), "utf8");
    writeFileSync(testInfo.outputPath("desktop-main.log"), text);
  } catch {
    // No log was written: nothing to attach.
  }
}

export function readMainLog(sandbox: Sandbox): string {
  try {
    return readFileSync(join(sandbox.dataDirectory, "logs", "desktop-main.log"), "utf8");
  } catch {
    return "";
  }
}

/** Quits the way a user does (the confirmation is auto-answered), so the backend is stopped and not left behind. */
export async function closeQuietly(app: ElectronApplication | undefined): Promise<void> {
  if (!app) return;
  if (closedApplications.has(app)) return;
  const closed = app.waitForEvent("close", { timeout: 30_000 }).catch(() => undefined);
  await app.evaluate(({ app: electron }) => electron.quit()).catch(() => undefined);
  await closed;
  await app.close().catch(() => undefined);
}
