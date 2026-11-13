#!/usr/bin/env node
/**
 * `pnpm test:start-smoke`: launches the real `pnpm start` entry (scripts/start.mjs) against a throwaway database on a
 * free port, waits for /api/health, checks that / serves the Web UI, then sends SIGTERM and checks the process exited
 * and the port was released. E2E uses an injected-state server and no longer covers this entry.
 *
 * Needs `pnpm build` first. HOME, USERPROFILE, the config directory, the database and the backup directory all point
 * into one fresh temp directory that is removed at the end; the repository's data/ and the default port are untouched.
 * Exit code 1 when any step fails.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import console from "node:console";
import { setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

const startEntry = resolve(dirname(fileURLToPath(import.meta.url)), "start.mjs");
const results = [];

function check(step, condition, detail = "") {
  results.push({ step, ok: Boolean(condition), detail: condition ? "" : detail });
}

function excerpt(text, lines = 6) {
  return text.trim().split(/\r?\n/).slice(-lines).join(" | ");
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

function portIsFree(port) {
  return new Promise((done) => {
    const probe = createServer();
    probe.once("error", () => done(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
  });
}

/** An environment whose every writable default (home, config, database, backups, temp) lives under `root`. */
function isolatedEnvironment(root, port) {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (/^(WORK_INTELLIGENCE_|INIT_CWD$|npm_)/i.test(name)) delete environment[name];
  }
  const home = join(root, "home");
  const scratch = join(root, "tmp");
  for (const directory of [home, scratch, join(root, "data")]) mkdirSync(directory, { recursive: true });
  return {
    ...environment,
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    WORK_INTELLIGENCE_CONFIG_DIR: join(root, "config"),
    WORK_INTELLIGENCE_DB: join(root, "data", "work-intelligence.sqlite"),
    WORK_INTELLIGENCE_BACKUP_DIR: join(root, "backups"),
    WORK_INTELLIGENCE_PORT: String(port),
    TMPDIR: scratch,
    TEMP: scratch,
    TMP: scratch,
  };
}

async function waitForHealth(port, child, getOutput, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`start.mjs exited early (${child.exitCode}): ${excerpt(getOutput())}`);
    try {
      const response = await globalThis.fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return await response.json();
    } catch {
      // Not listening yet.
    }
    await sleep(100);
  }
  throw new Error(`no healthy /api/health within ${timeoutMs / 1000} s: ${excerpt(getOutput())}`);
}

/** SIGTERM, then SIGKILL after `graceMs`. Windows has no signals; kill() ends the process, which is the whole tree here. */
async function stop(child, graceMs = 10_000) {
  if (child.exitCode !== null) return;
  const exited = new Promise((done) => child.once("exit", done));
  child.kill("SIGTERM");
  await Promise.race([exited, sleep(graceMs)]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

async function main() {
  const root = realpathSync(mkdtempSync(join(process.env.WORK_INTELLIGENCE_TEST_TMP?.trim() || tmpdir(), "wi-start-")));
  const port = await freePort();
  let child;
  let output = "";
  try {
    child = spawn(process.execPath, [startEntry], {
      env: isolatedEnvironment(root, port),
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));

    const health = await waitForHealth(port, child, () => output);
    check("start.mjs: /api/health", health.ok === true && health.database === "connected", JSON.stringify(health));

    const page = await globalThis.fetch(`http://127.0.0.1:${port}/`, { headers: { accept: "text/html" } });
    const html = await page.text();
    check("start.mjs: Web UI at /", page.status === 200 && html.includes('id="app"'), `status ${page.status}`);
    check(
      "start.mjs: database is the temporary one",
      output.includes(join(root, "data", "work-intelligence.sqlite")),
      excerpt(output),
    );

    const exited = new Promise((done) => child.once("exit", (code, signal) => done({ code, signal })));
    await stop(child);
    const outcome = await Promise.race([exited, sleep(1_000).then(() => undefined)]);
    check(
      "start.mjs: exited after SIGTERM",
      child.exitCode !== null || child.signalCode !== null,
      JSON.stringify(outcome),
    );
    check("start.mjs: port released", await portIsFree(port), `port ${port} still in use`);
  } catch (error) {
    check("start.mjs smoke", false, String(error?.message ?? error));
    if (child) await stop(child);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

const started = Date.now();
await main();
for (const { step, ok, detail } of results)
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${ok || !detail ? "" : `\n        ${detail}`}`);
const failed = results.filter((result) => !result.ok).length;
console.log(`${results.length - failed}/${results.length} passed in ${((Date.now() - started) / 1000).toFixed(1)} s`);
process.exitCode = failed > 0 ? 1 : 0;
