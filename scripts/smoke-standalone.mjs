#!/usr/bin/env node
/**
 * `pnpm test:standalone`: builds the standalone package into a temp directory, unpacks the tarball there, and runs the
 * installed command the way a user without a checkout would: `--version`, `start` (health, Web UI, a backup through
 * the worker thread), `track`, `db backups`, `check` and an MCP stdio session. With `--tarball <path>` it skips the
 * build and checks that tarball instead, so a release can test the exact file it uploads.
 *
 * Needs `pnpm build` first (for apps/web/dist). Everything it can write to (HOME, USERPROFILE, CODEX_HOME,
 * CLAUDE_CONFIG_DIR, WORK_INTELLIGENCE_CONFIG_DIR, TMP) is redirected into one fresh temp directory, which is removed
 * at the end. It never touches data/, a root SQLite file, ~/.work-intelligence, ~/.claude, the login service, or the
 * default port 3210 (it picks a free one). Exit code 1 when any step fails.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import process from "node:process";
import console from "node:console";
import { clearTimeout, setTimeout } from "node:timers";
import { gunzipSync } from "node:zlib";
import { buildStandalone } from "./build-standalone.mjs";

const results = [];

function record(step, ok, detail = "") {
  results.push({ step, ok, detail });
}

function check(step, condition, detail = "") {
  record(step, Boolean(condition), condition ? "" : detail);
}

function excerpt(text, lines = 6) {
  return text.trim().split(/\r?\n/).slice(0, lines).join(" | ");
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

async function portIsFree(port) {
  return new Promise((done) => {
    const probe = createServer();
    probe.once("error", () => done(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
  });
}

/** Extracts a tar.gz written by scripts/build-standalone.mjs (ustar, regular files only) with no external tool. */
function extractTarGz(tarball, destination) {
  const data = gunzipSync(readFileSync(tarball));
  const text = (start, length) => data.toString("utf8", start, start + length).replace(/\0.*$/s, "");
  let offset = 0;
  let files = 0;
  while (offset + 512 <= data.length && data[offset] !== 0) {
    const name = [text(offset + 345, 155), text(offset, 100)].filter(Boolean).join("/");
    const size = parseInt(text(offset + 124, 12).trim(), 8);
    const mode = parseInt(text(offset + 100, 8).trim(), 8);
    offset += 512;
    const target = resolve(destination, name);
    if (!target.startsWith(destination + sep)) throw new Error(`Tar entry escapes the destination: ${name}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data.subarray(offset, offset + size), { mode });
    offset += Math.ceil(size / 512) * 512;
    files += 1;
  }
  return files;
}

function isolatedEnvironment(root, port) {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (/^(WORK_INTELLIGENCE_|INIT_CWD$|npm_)/i.test(name)) delete environment[name];
  }
  const home = join(root, "home");
  const scratch = join(root, "tmp");
  for (const directory of [home, scratch, join(home, ".codex"), join(home, ".claude")])
    mkdirSync(directory, { recursive: true });
  return {
    ...environment,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    WORK_INTELLIGENCE_CONFIG_DIR: join(root, "config"),
    WORK_INTELLIGENCE_PORT: String(port),
    TMPDIR: scratch,
    TEMP: scratch,
    TMP: scratch,
  };
}

function run(bin, args, environment, cwd) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    env: environment,
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}`, stdout: result.stdout ?? "" };
}

async function waitForHealth(port, child, getOutput) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${excerpt(getOutput())}`);
    try {
      const response = await globalThis.fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return await response.json();
    } catch {
      // Not listening yet.
    }
    await sleep(200);
  }
  throw new Error("server did not become healthy in 30 s");
}

async function stop(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((done) => child.once("exit", done));
  child.kill("SIGTERM");
  await Promise.race([exited, sleep(10_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function checkServer(bin, environment, root, port, version) {
  const child = spawn(process.execPath, [bin, "start"], {
    env: environment,
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  try {
    const health = await waitForHealth(port, child, () => output);
    check(
      "start: /api/health",
      health.ok === true && health.version === version && health.database === "connected",
      JSON.stringify(health),
    );
    const databaseLine = /SQLite database: (.+)/.exec(output)?.[1]?.trim() ?? "";
    const expectedDatabase = join(root, "config", "data", "work-intelligence.sqlite");
    check(
      "start: database defaults to the config directory",
      databaseLine === expectedDatabase,
      `${databaseLine} != ${expectedDatabase}`,
    );

    const page = await globalThis.fetch(`http://127.0.0.1:${port}/`, { headers: { accept: "text/html" } });
    const html = await page.text();
    check("start: Web UI at /", page.status === 200 && html.includes('id="app"'), `status ${page.status}`);
    const assetPath = /(?:src|href)="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    const asset = assetPath ? await globalThis.fetch(`http://127.0.0.1:${port}${assetPath}`) : undefined;
    check(
      "start: Web UI script asset",
      asset?.status === 200 && (await asset.arrayBuffer()).byteLength > 1000,
      assetPath ?? "no script referenced",
    );

    // A backup is made by the worker thread, which is a separate bundle file next to the server bundle.
    const backup = await globalThis.fetch(`http://127.0.0.1:${port}/api/backups`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const backups = existsSync(join(root, "config", "data", "backups"))
      ? readdirSync(join(root, "config", "data", "backups"))
      : [];
    check(
      "start: backup through the worker thread",
      backup.status === 201 && backups.length === 1,
      `status ${backup.status}, files ${backups.length}`,
    );
  } catch (error) {
    record("start", false, String(error?.message ?? error));
  } finally {
    await stop(child);
    check("start: port released after SIGTERM", await portIsFree(port), `port ${port} still in use`);
  }
}

/** One MCP stdio session over newline-delimited JSON-RPC. */
async function mcpSession(bin, environment, root, projectFolder) {
  const child = spawn(process.execPath, [bin, "mcp"], {
    env: environment,
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const pending = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        const message = JSON.parse(line);
        pending.get(message.id)?.(message);
      }
    }
  });
  let nextId = 1;
  const request = (method, params) =>
    new Promise((done, fail) => {
      const id = nextId++;
      const timer = setTimeout(() => fail(new Error(`${method} timed out: ${excerpt(stderr, 3)}`)), 20_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        done(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  try {
    const initialize = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "standalone-smoke", version: "0" },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const tools = await request("tools/list", {});
    const status = await request("tools/call", {
      name: "work_read",
      arguments: { operation: "work_get_project_status", arguments: { projectRoot: projectFolder } },
    });
    const statusText = status.result?.content?.[0]?.text ?? "";
    return {
      serverInfo: initialize.result?.serverInfo,
      toolNames: (tools.result?.tools ?? []).map((tool) => tool.name),
      projectStatus: (() => {
        try {
          const parsed = JSON.parse(statusText);
          return parsed.project?.status ?? parsed.status;
        } catch {
          return undefined;
        }
      })(),
    };
  } finally {
    child.stdin.end();
    await stop(child);
  }
}

/** The tarball after `--tarball <path>`, or undefined; any other argument is a usage error. */
function givenTarball(argv = process.argv.slice(2)) {
  if (argv.length === 0) return undefined;
  if (argv.length === 2 && argv[0] === "--tarball" && argv[1]) return resolve(argv[1]);
  console.error("用法：node scripts/smoke-standalone.mjs [--tarball <work-intelligence-版本.tgz>]");
  process.exit(2);
}

/** Builds a fresh package, or uses the given tarball (its version and file count are read after unpacking). */
async function builtOrGivenTarball(buildDirectory) {
  const tarball = givenTarball();
  return tarball ? { tarball, version: undefined, fileCount: undefined } : buildStandalone(buildDirectory);
}

/** The version in the single unpacked package folder's package.json. */
function unpackedVersion(installRoot) {
  const [folder] = readdirSync(installRoot);
  try {
    return JSON.parse(readFileSync(join(installRoot, folder, "package.json"), "utf8")).version;
  } catch {
    return undefined;
  }
}

/** Whether `text` mentions `path`; Windows project paths are stored lowercased, so compare case-insensitively there. */
function containsPath(text, path) {
  return process.platform === "win32" ? text.toLowerCase().includes(path.toLowerCase()) : text.includes(path);
}

async function main() {
  // The real path: on macOS tmpdir() goes through a /var -> /private/var link and a process reports its cwd resolved.
  const root = realpathSync(
    mkdtempSync(join(process.env.WORK_INTELLIGENCE_TEST_TMP?.trim() || tmpdir(), "work-intelligence-standalone-")),
  );
  try {
    const built = await builtOrGivenTarball(join(root, "build"));
    check("build: tarball written", existsSync(built.tarball), built.tarball);
    const installRoot = join(root, "install");
    const files = extractTarGz(built.tarball, installRoot);
    if (built.fileCount === undefined) {
      built.version = unpackedVersion(installRoot);
      check("build: tarball unpacks", files > 0 && built.version !== undefined, `${files} files`);
    } else {
      check("build: tarball unpacks", files === built.fileCount, `${files} != ${built.fileCount}`);
    }
    if (process.platform !== "win32") {
      const listing = spawnSync("tar", ["-tzf", built.tarball], { encoding: "utf8" });
      check(
        "build: system tar reads the tarball",
        listing.status === 0 && listing.stdout.split("\n").filter(Boolean).length === files,
        excerpt(listing.stderr),
      );
    }
    const bin = join(installRoot, `work-intelligence-${built.version}`, "bin", "work-intelligence.mjs");
    const port = await freePort();
    const environment = isolatedEnvironment(root, port);
    const workingDirectory = join(root, "elsewhere");
    mkdirSync(workingDirectory, { recursive: true });
    const projectFolder = join(root, "synthetic project");
    mkdirSync(projectFolder, { recursive: true });

    const version = run(bin, ["--version"], environment, workingDirectory);
    check(
      "--version",
      version.status === 0 && version.stdout.trim() === `work-intelligence ${built.version}`,
      excerpt(version.output),
    );
    const help = run(bin, ["--help"], environment, workingDirectory);
    check("--help", help.status === 0 && help.stdout.includes("track <資料夾>"), excerpt(help.output));
    const unknown = run(bin, ["nope"], environment, workingDirectory);
    check("unknown command exits 2", unknown.status === 2, `exit ${unknown.status}`);

    await checkServer(bin, environment, root, port, built.version);

    // A relative folder resolves against the directory the command was typed in, not an inherited INIT_CWD.
    const track = run(
      bin,
      ["track", "../synthetic project", "--yes"],
      { ...environment, INIT_CWD: tmpdir() },
      workingDirectory,
    );
    check(
      "track <folder> --yes",
      track.status === 0 && track.output.includes("已開始記錄") && containsPath(track.output, projectFolder),
      excerpt(track.output),
    );
    const again = run(bin, ["track", projectFolder, "--yes"], environment, workingDirectory);
    check("track again is a no-op", again.status === 0 && again.output.includes("已在記錄中"), excerpt(again.output));

    const backups = run(bin, ["db", "backups"], environment, workingDirectory);
    check(
      "db backups lists the worker's backup",
      backups.status === 0 && /總計 1 份/.test(backups.output),
      excerpt(backups.output),
    );
    const dbHelp = run(bin, ["db"], environment, workingDirectory);
    check(
      "db prints standalone command names",
      dbHelp.stdout.includes("work-intelligence db backups") && !dbHelp.stdout.includes("pnpm"),
      excerpt(dbHelp.output),
    );

    const doctor = run(bin, ["check"], environment, workingDirectory);
    check(
      "check: package integrity, no checkout-only advice",
      doctor.status === 0 &&
        doctor.output.includes("✓ 套件檔案") &&
        doctor.output.includes("✓ 套件版本") &&
        !doctor.output.includes("pnpm"),
      excerpt(doctor.output, 12),
    );

    try {
      const mcp = await mcpSession(bin, environment, root, projectFolder);
      check(
        "mcp: initialize",
        mcp.serverInfo?.name === "work-intelligence" && mcp.serverInfo?.version === built.version,
        JSON.stringify(mcp.serverInfo),
      );
      check(
        "mcp: tools/list",
        ["work_read", "work_write_idempotent", "work_write_additive", "work_write_overwrite"].every((name) =>
          mcp.toolNames.includes(name),
        ),
        mcp.toolNames.join(","),
      );
      check("mcp: sees the project tracked from the CLI", mcp.projectStatus === "tracked", String(mcp.projectStatus));
    } catch (error) {
      record("mcp", false, String(error?.message ?? error));
    }

    check("nothing listens on the test port", await portIsFree(port), `port ${port}`);
    console.log(
      `tarball ${(built.tarballBytes / 1024).toFixed(0)} KiB, unpacked ${(built.unpackedBytes / 1024).toFixed(0)} KiB, ${built.fileCount} files`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  record("smoke test", false, String(error?.stack ?? error));
}
for (const { step, ok, detail } of results)
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${ok || !detail ? "" : `\n        ${detail}`}`);
const failed = results.filter((result) => !result.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exitCode = failed > 0 ? 1 : 0;
