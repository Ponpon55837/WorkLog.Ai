#!/usr/bin/env node
/**
 * `pnpm dashboard` makes the Web UI reachable and prints its address. When the local API already answers on
 * WORK_INTELLIGENCE_PORT (default 3210) it only prints the URL; otherwise it starts the production server from this
 * checkout in the background (the same `node scripts/start.mjs` that `pnpm start` runs), waits until it is healthy,
 * and prints the URL. `--open` also opens it in the default browser. The plugin's dashboard skill runs this script.
 */
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

/** True when the Work Intelligence API answers /api/health with a usable database. */
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

function openInBrowser(url) {
  const [command, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch {
    // The URL is printed either way.
  }
}

/** Returns { url, started } or { error } without exiting, so tests can call it. */
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

if (isEntryPoint()) {
  const result = await ensureDashboard();
  if (result.error) {
    console.error(result.error);
    process.exitCode = 1;
  } else {
    console.log(result.started ? `Started the Work Intelligence server: ${result.url}` : `Dashboard: ${result.url}`);
    if (process.argv.includes("--open")) openInBrowser(result.url);
  }
}
