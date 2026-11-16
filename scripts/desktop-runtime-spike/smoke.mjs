#!/usr/bin/env node
/**
 * `pnpm spike:runtime:smoke [--runtime node|electron] [--out <launcher root>] [--runs 5] [--idle-seconds 10]` proves the
 * launcher root made by `pnpm spike:runtime:build` runs on a machine with no Node.js: PATH holds no directory with a
 * `node` executable, NODE_* is empty, the proxy points at an unreachable port, and only the fixed shim is started.
 *
 *   1. serve: Web UI, a synthetic project and knowledge note, FTS5 search, a backup through the worker thread, and the
 *      bundled runtime's own path, versions and `sqlite_version()` (the launcher's --print-runtime-info).
 *   2. mcp, after the server is stopped: `initialize` and `tools/list` over stdio with nothing but JSON-RPC on stdout,
 *      and a read of the synthetic database; hook actions.
 *   3. tampering: a changed byte (mtime restored), a damaged manifest, a planted file, a missing `current`, and an
 *      action that is not allowed; each is refused with its error code (hooks are let through) and repaired runs again.
 *   4. numbers: sizes, verification and cold start times, idle memory and CPU. Written to
 *      dist/desktop-runtime-spike/<platform>-<arch>-<runtime>.json and, in GitHub Actions, to the step summary.
 *
 * Everything the runtime can write to lives in one fresh temp directory (with a space and Chinese characters in its
 * name) that is removed at the end; the real home, ~/.work-intelligence and port 3210 are never touched.
 * Exit code 1 when any check fails.
 */
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import console from "node:console";
import { pathToFileURL } from "node:url";
import { checkBundledSqlite } from "../check-sqlite-version.mjs";
import { median, parseSpikeArguments, platformTag, readJson, repositoryRoot } from "./common.mjs";
import {
  McpSession,
  cpuSeconds,
  excerpt,
  findNodeOnPath,
  freePort,
  noNodeEnvironment,
  portIsFree,
  residentBytes,
  runShim,
  runtimePid,
  sleep,
  startShim,
  waitForHealth,
  Launched,
} from "./harness.mjs";
import { appendStepSummary, writeReport } from "./report.mjs";

const WINDOWS = process.platform === "win32";
/** What the shims set for an Electron runtime (see ELECTRON_AS_NODE_ENV in desktop-core); direct starts need it too. */
const ELECTRON_AS_NODE_ENV = { ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ASAR: "1" };
const RUNTIME_ID_POINTER = "current";
const TAMPER_TARGET = "app/web/index.html";
const results = [];

function check(step, condition, detail = "") {
  results.push({ step, ok: Boolean(condition), detail: condition ? "" : detail });
}

function runtimeFacts(root) {
  const runtimeId = readFileSync(join(root, RUNTIME_ID_POINTER), "utf8").trim();
  const runtimeDirectory = join(root, "runtimes", runtimeId);
  const manifest = readJson(join(runtimeDirectory, "runtime-manifest.json"));
  return { runtimeId, runtimeDirectory, manifest };
}

/** The scratch area of one test: environment, working directory and a synthetic project folder. */
function scratch(workRoot, label, port) {
  const root = join(workRoot, label);
  mkdirSync(root, { recursive: true });
  const projectFolder = join(root, "synthetic project 專案");
  mkdirSync(projectFolder, { recursive: true });
  return { root, projectFolder, env: noNodeEnvironment(root, port), port };
}

function samePath(left, right) {
  const normalize = (value) => (WINDOWS || process.platform === "darwin" ? value.toLowerCase() : value);
  return normalize(realpathSync.native(left)) === normalize(realpathSync.native(right));
}

async function jsonRequest(port, method, path, body) {
  const response = await globalThis.fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => undefined) };
}

/** Starts the server through the shim on a fresh config directory; resolves when /api/health answers. */
async function startServer(ctx, { direct = false } = {}) {
  const port = await freePort();
  const area = scratch(ctx.workRoot, `serve-${port}`, port);
  const launched = direct
    ? new Launched(
        join(ctx.runtimeDirectory, ctx.manifest.executable),
        [join(ctx.runtimeDirectory, "app/bin/work-intelligence.mjs"), "start"],
        {
          env: { ...area.env, ...(ctx.electron ? ELECTRON_AS_NODE_ENV : {}) },
          cwd: area.root,
        },
      )
    : startShim(ctx.shim, ["serve"], { env: area.env, cwd: area.root });
  const health = await waitForHealth(port, launched);
  return { port, area, launched, health, milliseconds: performance.now() - launched.startedAt };
}

async function stopServer(server) {
  await server.launched.stop();
  return portIsFree(server.port);
}

async function startMcp(ctx, area, { direct = false } = {}) {
  const launched = direct
    ? new Launched(
        join(ctx.runtimeDirectory, ctx.manifest.executable),
        [join(ctx.runtimeDirectory, "app/libexec/apps/mcp/dist/index.js")],
        {
          env: { ...area.env, ...(ctx.electron ? ELECTRON_AS_NODE_ENV : {}) },
          cwd: area.root,
        },
      )
    : startShim(ctx.shim, ["mcp"], { env: area.env, cwd: area.root });
  const session = new McpSession(launched);
  const initialize = await session.initialize();
  return { launched, session, initialize, milliseconds: performance.now() - launched.startedAt };
}

async function stopMcp(mcp) {
  mcp.launched.child.stdin.end();
  await mcp.launched.stop();
}

async function timedRuns(runs, one) {
  const samples = [];
  for (let index = 0; index < runs; index += 1) samples.push(await one());
  return samples;
}

function removeVerificationCache(ctx) {
  rmSync(join(ctx.runtimeDirectory, ".verified.json"), { force: true });
}

/** Verification cost in this process: every file hashed, versus every file accepted from its stat fingerprint. */
async function measureVerification(ctx) {
  const { verifyRuntime } = await import(
    pathToFileURL(join(repositoryRoot, "packages/desktop-core/dist/index.js")).href
  );
  const time = async (options) => {
    const started = performance.now();
    const verified = await verifyRuntime(ctx.root, ctx.runtimeId, options);
    return { milliseconds: performance.now() - started, verified };
  };
  const full = [];
  for (let index = 0; index < 3; index += 1) full.push((await time({ useCache: false })).milliseconds);
  removeVerificationCache(ctx);
  const first = await time({});
  const cached = [];
  for (let index = 0; index < ctx.runs; index += 1) cached.push((await time({})).milliseconds);
  check(
    "verify: first run hashes every file",
    first.verified.hashedCount === first.verified.fileCount,
    JSON.stringify(first.verified),
  );
  check(
    "verify: later runs hash nothing (stat cache)",
    cached.length > 0 && (await time({})).verified.hashedCount === 0,
    "cache was not used",
  );
  return { verifyFullMs: median(full), verifyCachedMs: median(cached) };
}

async function measureStarts(ctx) {
  removeVerificationCache(ctx);
  const serverFirst = await timedStop(await startServer(ctx));
  const serverRuns = await timedRuns(ctx.runs, async () => timedStop(await startServer(ctx)));
  const serverDirect = await timedRuns(ctx.runs, async () => timedStop(await startServer(ctx, { direct: true })));
  const area = scratch(ctx.workRoot, "mcp-starts", await freePort());
  const mcpTimes = async (options) => {
    const mcp = await startMcp(ctx, area, options);
    await stopMcp(mcp);
    return mcp.milliseconds;
  };
  removeVerificationCache(ctx);
  const mcpFirst = await mcpTimes();
  const mcpRuns = await timedRuns(ctx.runs, () => mcpTimes());
  const mcpDirect = await timedRuns(ctx.runs, () => mcpTimes({ direct: true }));
  return {
    serverFirstMs: serverFirst,
    serverMedianMs: median(serverRuns),
    serverDirectMs: median(serverDirect),
    mcpFirstMs: mcpFirst,
    mcpMedianMs: median(mcpRuns),
    mcpDirectMs: median(mcpDirect),
  };
}

async function timedStop(server) {
  await stopServer(server);
  return server.milliseconds;
}

/** Idle memory and CPU of `pid` over `seconds`. */
async function sampleIdle(pid, seconds) {
  await sleep(1000);
  const startCpu = cpuSeconds(pid);
  const started = performance.now();
  await sleep(seconds * 1000);
  const elapsed = (performance.now() - started) / 1000;
  return { rssBytes: residentBytes(pid), cpuPercent: ((cpuSeconds(pid) - startCpu) / elapsed) * 100 };
}

async function checkServer(ctx, info) {
  const server = await startServer(ctx);
  const { port, area, health } = server;
  let idle = { rssBytes: 0, cpuPercent: 0 };
  try {
    check(
      "serve: /api/health reports the bundled SQLite",
      health.ok === true && health.database === "connected" && health.sqlite?.version === info.sqlite.version,
      JSON.stringify(health),
    );
    const databaseLine = /SQLite database: (.+)/.exec(server.launched.output)?.[1]?.trim() ?? "";
    check(
      "serve: database is inside the temporary config directory",
      samePath(databaseLine, join(area.root, "config", "data", "work-intelligence.sqlite")),
      databaseLine,
    );
    if (process.platform === "linux") {
      check(
        "serve: the process runs the bundled executable",
        samePath(`/proc/${server.launched.child.pid}/exe`, join(ctx.runtimeDirectory, ctx.manifest.executable)),
        "/proc/<pid>/exe differs from the bundled executable",
      );
    }
    const page = await globalThis.fetch(`http://127.0.0.1:${port}/`, { headers: { accept: "text/html" } });
    const html = await page.text();
    check("serve: Web UI at /", page.status === 200 && html.includes('id="app"'), `status ${page.status}`);

    const project = await jsonRequest(port, "POST", "/api/projects", {
      name: "合成 runtime spike",
      rootPath: area.projectFolder,
    });
    const tracked = await jsonRequest(port, "PATCH", `/api/projects/${project.body?.id}`, { status: "tracked" });
    check(
      "serve: synthetic project created and tracked",
      project.status === 201 && tracked.body?.status === "tracked",
      JSON.stringify(project.body),
    );
    const note = await jsonRequest(port, "POST", "/api/knowledge", {
      projectRoot: area.projectFolder,
      idempotencyKey: "runtime-spike-1",
      kind: "decision",
      title: "合成的 runtime spike 決策",
      body: "Synthetic zebracrossing note written by the runtime spike.",
    });
    check(
      "serve: synthetic record written to the database",
      note.status === 200 || note.status === 201,
      `status ${note.status}`,
    );
    const found = await jsonRequest(port, "GET", `/api/knowledge?q=${encodeURIComponent("zebracrossing")}`);
    check(
      "serve: FTS5 search finds the record",
      found.body?.items?.length === 1,
      JSON.stringify(found.body).slice(0, 200),
    );

    const backup = await jsonRequest(port, "POST", "/api/backups", {});
    const backupDirectory = join(area.root, "config", "data", "backups");
    const backups = existsSync(backupDirectory) ? readdirSync(backupDirectory) : [];
    check(
      "serve: backup through the worker thread",
      backup.status === 201 && backups.length === 1,
      `status ${backup.status}, files ${backups.length}`,
    );

    const pid = runtimePid(server.launched, basename(ctx.manifest.executable));
    check("serve: runtime process found for sampling", pid !== undefined, "no runtime pid");
    if (pid !== undefined) idle = await sampleIdle(pid, ctx.idleSeconds);
  } finally {
    check("serve: port released after stopping the server", await stopServer(server), `port ${port} still in use`);
  }
  return { area, idle };
}

async function checkMcp(ctx, area) {
  const mcp = await startMcp(ctx, area);
  let idle = { rssBytes: 0, cpuPercent: 0 };
  try {
    check(
      "mcp: initialize",
      mcp.initialize.result?.serverInfo?.name === "work-intelligence",
      JSON.stringify(mcp.initialize.result?.serverInfo),
    );
    const tools = await mcp.session.request("tools/list", {});
    const names = (tools.result?.tools ?? []).map((tool) => tool.name);
    check(
      "mcp: tools/list",
      ["work_read", "work_write_idempotent"].every((name) => names.includes(name)),
      names.join(","),
    );
    const status = await mcp.session.request("tools/call", {
      name: "work_read",
      arguments: { operation: "work_get_project_status", arguments: { projectRoot: area.projectFolder } },
    });
    const text = status.result?.content?.[0]?.text ?? "";
    check("mcp: reads the synthetic database", /tracked/.test(text), excerpt(text, 2));
    check(
      "mcp: stdout holds only JSON-RPC",
      mcp.session.nonProtocolLines.length === 0,
      mcp.session.nonProtocolLines.join(" | "),
    );
    const pid = runtimePid(mcp.launched, basename(ctx.manifest.executable));
    if (pid !== undefined) idle = await sampleIdle(pid, ctx.idleSeconds);
  } finally {
    await stopMcp(mcp);
  }
  return idle;
}

async function checkHooks(ctx, area) {
  for (const action of ["codex-finalize-reminder", "claude-finalize-reminder"]) {
    const result = await runShim(ctx.shim, [action], { env: area.env, cwd: area.root, input: "{}" });
    check(`hook ${action}: exits 0`, result.code === 0, `exit ${result.code}: ${excerpt(result.stderr)}`);
    const clean =
      result.stdout.trim() === "" ||
      (() => {
        try {
          JSON.parse(result.stdout);
          return true;
        } catch {
          return false;
        }
      })();
    check(`hook ${action}: stdout is empty or JSON`, clean, excerpt(result.stdout));
  }
}

/** Each case damages the installed runtime, expects the launcher to refuse with `code`, then repairs it. */
async function checkTampering(ctx, area) {
  const refused = async (label, code) => {
    const mcp = await runShim(ctx.shim, ["mcp"], { env: area.env, cwd: area.root });
    check(
      `tamper ${label}: mcp refused with ${code}`,
      mcp.code === 78 && mcp.stderr.includes(code),
      `exit ${mcp.code}: ${excerpt(mcp.stderr)}`,
    );
    check(`tamper ${label}: mcp stdout stays empty`, mcp.stdout === "", excerpt(mcp.stdout));
    const hook = await runShim(ctx.shim, ["codex-finalize-reminder"], { env: area.env, cwd: area.root, input: "{}" });
    check(
      `tamper ${label}: hook lets the Agent through`,
      hook.code === 0 && hook.stderr.includes(code),
      `exit ${hook.code}: ${excerpt(hook.stderr)}`,
    );
    return mcp;
  };
  const recovered = async (label) => {
    const info = await runShim(ctx.shim, ["--print-runtime-info"], { env: area.env, cwd: area.root });
    check(`tamper ${label}: runs again after repair`, info.code === 0, `exit ${info.code}: ${excerpt(info.stderr)}`);
    return info;
  };

  // 1. One byte changed, same size, mtime put back: only the content hash and ctime can notice.
  const target = join(ctx.runtimeDirectory, TAMPER_TARGET);
  const original = readFileSync(target);
  const before = statSync(target);
  const changed = Buffer.from(original);
  changed[0] ^= 0x01;
  writeFileSync(target, changed);
  utimesSync(target, before.atime, before.mtime);
  const refusedByte = await refused("changed byte", "RUNTIME_FILE_TAMPERED");
  check(
    "tamper changed byte: the message names the file",
    refusedByte.stderr.includes(TAMPER_TARGET),
    excerpt(refusedByte.stderr),
  );
  writeFileSync(target, original);
  const info = await recovered("changed byte");
  check(
    "tamper changed byte: only the repaired file was hashed again",
    JSON.parse(info.stdout || "{}").verification?.hashed === 1,
    excerpt(info.stdout),
  );

  // 2. Damaged manifest.
  const manifestPath = join(ctx.runtimeDirectory, "runtime-manifest.json");
  const manifestText = readFileSync(manifestPath, "utf8");
  writeFileSync(manifestPath, "{ not json");
  await refused("damaged manifest", "RUNTIME_MANIFEST_INVALID");
  writeFileSync(manifestPath, manifestText);
  await recovered("damaged manifest");

  // 3. A file the manifest does not list.
  const planted = join(ctx.runtimeDirectory, "app/web/planted.js");
  writeFileSync(planted, "// planted");
  await refused("planted file", "RUNTIME_FILE_UNEXPECTED");
  unlinkSync(planted);
  await recovered("planted file");

  // 4. Missing pointer.
  const pointer = join(ctx.root, RUNTIME_ID_POINTER);
  renameSync(pointer, `${pointer}.off`);
  await refused("missing current", "RUNTIME_POINTER_MISSING");
  renameSync(`${pointer}.off`, pointer);
  await recovered("missing current");

  // 5. An action that is not on the list.
  const bogus = await runShim(ctx.shim, ["bash"], { env: area.env, cwd: area.root });
  check(
    "action not on the list is refused",
    bogus.code === 64 && bogus.stderr.includes("RUNTIME_ACTION_NOT_ALLOWED"),
    `exit ${bogus.code}: ${excerpt(bogus.stderr)}`,
  );
}

function directoryBytes(prefix, manifest) {
  return manifest.files.filter((file) => file.path.startsWith(prefix)).reduce((total, file) => total + file.size, 0);
}

function measureSizes(ctx) {
  const archive = join(ctx.workRoot, "runtime-size.tgz");
  const tar = WINDOWS ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  const packed = spawnSync(tar, ["-czf", archive, "-C", ctx.runtimeDirectory, "."], {
    encoding: "utf8",
    windowsHide: true,
  });
  check("sizes: runtime directory compresses to tar.gz", packed.status === 0, packed.stderr);
  const runtimePrefix = ctx.electron ? "electron/" : "node/";
  return {
    totalBytes: ctx.manifest.files.reduce((total, file) => total + file.size, 0),
    fileCount: ctx.manifest.files.length,
    compressedBytes: existsSync(archive) ? statSync(archive).size : 0,
    executableBytes: directoryBytes(runtimePrefix, ctx.manifest),
    bundleBytes: directoryBytes("app/libexec/", ctx.manifest),
    webBytes: directoryBytes("app/web/", ctx.manifest),
    launcherBytes: directoryBytes("launcher.mjs", ctx.manifest),
  };
}

async function main() {
  const options = parseSpikeArguments(process.argv.slice(2), {
    runs: { type: "string", default: "5" },
    "idle-seconds": { type: "string", default: "10" },
  });
  const { runtimeId, runtimeDirectory, manifest } = runtimeFacts(options.root);
  const workRoot = realpathSync(mkdtempSync(join(tmpdir(), "work-intelligence runtime 測試-")));
  const ctx = {
    root: options.root,
    runtimeId,
    runtimeDirectory,
    manifest,
    electron: manifest.runtimeKind === "electron-run-as-node",
    shim: join(options.root, "bin", WINDOWS ? "work-intelligence-launcher.cmd" : "work-intelligence-launcher"),
    workRoot,
    runs: Number(options.runs),
    idleSeconds: Number(options["idle-seconds"]),
  };
  try {
    const probe = scratch(workRoot, "probe", 1);
    check(
      "environment: no node on PATH",
      findNodeOnPath(probe.env.PATH ?? probe.env.Path) === undefined,
      probe.env.PATH ?? probe.env.Path,
    );
    check(
      "layout: root contains spaces and non-ASCII characters",
      /\s/.test(options.root) && [...options.root].some((character) => character.charCodeAt(0) > 127),
      options.root,
    );

    const infoRun = await runShim(ctx.shim, ["--print-runtime-info"], { env: probe.env, cwd: probe.root });
    check("launcher: --print-runtime-info", infoRun.code === 0, `exit ${infoRun.code}: ${excerpt(infoRun.stderr)}`);
    const info = JSON.parse(infoRun.stdout || "{}");
    check(
      "runtime: the process is the bundled executable",
      info.execPath && samePath(info.execPath, join(runtimeDirectory, manifest.executable)),
      `${info.execPath}`,
    );
    check(
      "runtime: SQLite with FTS5",
      Boolean(info.sqlite?.version) && info.sqlite.fts5 === true,
      JSON.stringify(info.sqlite),
    );
    const sqlite = await checkBundledSqlite(info.sqlite?.version ?? "");
    check(
      `runtime: SQLite ${info.sqlite?.version} has the WAL-reset fix`,
      !sqlite.affected,
      "fixed in 3.51.3, 3.50.7, 3.44.6",
    );

    const verification = await measureVerification(ctx);
    const starts = await measureStarts(ctx);
    const serverRun = await checkServer(ctx, info);
    const mcpIdle = await checkMcp(ctx, serverRun.area);
    await checkHooks(ctx, serverRun.area);
    await checkTampering(ctx, serverRun.area);
    const sizes = measureSizes(ctx);

    const failed = results.filter((result) => !result.ok).length;
    const report = {
      platform: platformTag,
      generatedAt: new Date().toISOString(),
      runtime: {
        choice: options.runtime,
        kind: manifest.runtimeKind,
        id: runtimeId,
        version: info.electronVersion ?? info.nodeVersion,
        nodeVersion: info.nodeVersion,
        electronVersion: info.electronVersion,
        execPath: info.execPath,
        acl: info.verification?.acl,
      },
      sqlite: { version: info.sqlite?.version, fts5: info.sqlite?.fts5, walResetFixed: !sqlite.affected },
      sizes,
      timings: { ...verification, ...starts },
      idle: {
        idleSeconds: ctx.idleSeconds,
        serverRssBytes: serverRun.idle.rssBytes,
        serverCpuPercent: serverRun.idle.cpuPercent,
        mcpRssBytes: mcpIdle.rssBytes,
        mcpCpuPercent: mcpIdle.cpuPercent,
      },
      checks: results,
      passed: results.length - failed,
      failed,
    };
    console.log(`report: ${writeReport(report)}`);
    appendStepSummary(report);
    console.log(JSON.stringify({ sizes, timings: report.timings, idle: report.idle }, null, 2));
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

/** On a failure the checks run so far still go to the report file, so the CI artifact shows how far it got. */
function writePartialReport() {
  const runtimeFlag = process.argv.indexOf("--runtime");
  const failed = results.filter((result) => !result.ok).length;
  const report = {
    platform: platformTag,
    generatedAt: new Date().toISOString(),
    partial: true,
    runtime: { choice: runtimeFlag === -1 ? "node" : (process.argv[runtimeFlag + 1] ?? "unknown") },
    checks: results,
    passed: results.length - failed,
    failed,
  };
  console.log(`partial report: ${writeReport(report)}`);
}

try {
  await main();
} catch (error) {
  check("smoke test", false, String(error?.stack ?? error));
  writePartialReport();
}
for (const { step, ok, detail } of results)
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${ok || !detail ? "" : `\n        ${detail}`}`);
const failed = results.filter((result) => !result.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exitCode = failed > 0 ? 1 : 0;
