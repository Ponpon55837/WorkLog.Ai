#!/usr/bin/env node
// A server that already answers is reported first; otherwise, with the desktop App installed, the request goes to the App
// and no checkout server is started, even if the App is not running.
import { spawn } from "node:child_process";
import console from "node:console";
import { existsSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PORT = 3210;

export function dashboardPort(environment = process.env) {
  const port = Number(environment.WORK_INTELLIGENCE_PORT ?? DEFAULT_PORT);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
}

export async function isHealthy(port) {
  try {
    const response = await globalThis.fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: globalThis.AbortSignal.timeout(1500),
    });
    const body = await response.json();
    return response.ok && body?.ok === true && body?.database !== "unavailable";
  } catch {
    return false;
  }
}

function portIsFree(port) {
  return new Promise((resolvePort) => {
    const probe = createServer()
      .once("error", () => resolvePort(false))
      .once("listening", () => probe.close(() => resolvePort(true)));
    probe.listen(port, "127.0.0.1");
  });
}

/** System32\cmd.exe, never a `cmd` found through PATH; loaded here because only Windows needs it. */
async function windowsCommandShellPath() {
  const { windowsCommandShell } = await import("../packages/shared/dist/windows-system-tool.js");
  return windowsCommandShell();
}

async function openInBrowser(url) {
  const [command, args] =
    process.platform === "win32"
      ? [await windowsCommandShellPath(), ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch {
    // The URL is printed either way.
  }
}

export async function ensureDashboard({ root = repositoryRoot, environment = process.env, timeoutMs = 20_000 } = {}) {
  const port = dashboardPort(environment);
  const url = `http://127.0.0.1:${port}`;
  if (await isHealthy(port)) return { url, started: false };
  if (!(await portIsFree(port))) {
    return {
      error: `Port ${port} is in use by something that is not Work Intelligence. Stop it, or set WORK_INTELLIGENCE_PORT.`,
    };
  }
  const start = join(root, "scripts/start.mjs");
  if (!existsSync(join(root, "apps/server/dist/index.js")) || !existsSync(join(root, "apps/web/dist/index.html"))) {
    return { error: `The Web UI is not built in ${root}. Run pnpm install && pnpm build there first.` };
  }
  const server = spawn(process.execPath, [start], {
    cwd: root,
    env: { ...environment, WORK_INTELLIGENCE_PORT: String(port) },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  server.unref();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy(port)) return { url, started: true };
    await delay(250);
  }
  return { error: `The server did not become ready on ${url}. Run pnpm start in ${root} to see why.` };
}

function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

export async function handOffToDesktopApp(options) {
  let integration;
  try {
    integration = await import("../plugins/work-intelligence/scripts/desktop-integration.mjs");
  } catch {
    return false;
  }
  const app = integration.resolveDesktopApp(options);
  return app !== undefined && (await integration.openDashboardInApp(app, options));
}

async function printDashboard() {
  if (!(await isHealthy(dashboardPort())) && (await handOffToDesktopApp())) {
    console.log("Opening the Work Intelligence Dashboard in the desktop App. The App opens the Dashboard itself.");
    return;
  }
  const result = await ensureDashboard();
  if (result.error) {
    console.error(result.error);
    process.exitCode = 1;
  } else {
    console.log(result.started ? `Started the Work Intelligence server: ${result.url}` : `Dashboard: ${result.url}`);
    if (process.argv.includes("--open")) await openInBrowser(result.url);
  }
}

if (isEntryPoint()) await printDashboard();
