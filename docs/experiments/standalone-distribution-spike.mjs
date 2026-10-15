#!/usr/bin/env node
/**
 * Spike: can Work Intelligence ship without a checkout? (docs/experiments/standalone-distribution-spike-2026-10-15.md)
 *
 * Usage (from anywhere inside the repository, needs the repo's node_modules for esbuild):
 *   node docs/experiments/standalone-distribution-spike.mjs [--skip-verify] [--keep-temp] [--port 3399]
 *
 * What it does
 *   1. Bundles the server, CLI, doctor, setup-agents, service CLI and MCP entry points with esbuild into
 *      <repo>/dist/standalone-spike/libexec/apps/{server,mcp}/dist (dist/ is gitignored).
 *   2. Copies the EXISTING apps/web/dist and the agent resources into the bundle, and writes
 *      bin/work-intelligence.mjs plus a package.json (private: true, so `npm publish` is refused).
 *   3. Unless --skip-verify: runs the bundle against a synthetic database in a temp directory (Web UI + API on the
 *      spike port, an MCP stdio session, track/check/setup-agents preview, `npm pack`, install into a temp prefix,
 *      and `npx <tarball>`), prints a result table and writes results.json into the temp directory.
 *
 * Writes only to
 *   - <repo>/dist/standalone-spike/            (rebuilt on every run)
 *   - a fresh temp directory (os.tmpdir()/work-intelligence-spike-*), which also holds the npm cache, the fake
 *     HOME / USERPROFILE / CODEX_HOME / CLAUDE_CONFIG_DIR and the synthetic database. Removed unless --keep-temp.
 *
 * Never touches
 *   - <repo>/data/ and any root *.sqlite (real user data); the database is always a temp path.
 *   - apps/* /dist and packages/* /dist (no `pnpm build`), the user's server on 3210, ~/.work-intelligence,
 *     the user's Agent configuration or login service, the global npm prefix and cache.
 *   - the network: nothing is published, uploaded or logged in to.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import console from "node:console";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const outputRoot = join(repositoryRoot, "dist", "standalone-spike");
const libexec = join(outputRoot, "libexec");
const args = process.argv.slice(2);
const skipVerify = args.includes("--skip-verify");
const keepTemp = args.includes("--keep-temp");
const portIndex = args.indexOf("--port");
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 3399;
const isWindows = process.platform === "win32";

if (!Number.isInteger(port) || port === 3210 || port < 1024 || port > 65535) {
  console.error("Use a spike port other than 3210 (the real server).");
  process.exit(2);
}

const SERVER_ENTRIES = ["index", "cli", "doctor", "setup-agents", "service-cli"];
const MCP_ENTRIES = ["index", "finalize-reminder", "codex-finalize-reminder"];
const AGENT_RESOURCES = [
  ".agents/skills/work-intelligence/SKILL.md",
  "docs/work-record-and-report-format.md",
  ".agents/skills/worklog-report-writing/SKILL.md",
  ".agents/skills/worklog-report-writing/references/en.md",
  ".agents/skills/worklog-report-writing/references/zh-TW.md",
];

/** Same trick as scripts/build-plugin.mjs: workspace packages resolve to their TypeScript source, no dist needed. */
const workspaceSources = {
  name: "work-intelligence-workspace-sources",
  setup(builder) {
    builder.onResolve({ filter: /^@work-intelligence\/[^/]+(\/.+)?$/ }, (resolveArgs) => {
      const [, name, subpath = "index"] = /^@work-intelligence\/([^/]+)(?:\/(.+))?$/.exec(resolveArgs.path);
      const source = join(repositoryRoot, "packages", name, "src", `${subpath}.ts`);
      return existsSync(source) ? { path: source } : undefined;
    });
  },
};

const BIN_SOURCE = `#!/usr/bin/env node
// Minimal dispatcher for the standalone spike. Runs the bundled entry points in-process (no child process), so
// signals and stdio behave exactly as they do for \`node apps/.../index.js\`.
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const libexec = join(packageRoot, "libexec");
const COMMANDS = {
  start: ["apps/server/dist/index.js", []],
  mcp: ["apps/mcp/dist/index.js", []],
  "finalize-reminder": ["apps/mcp/dist/finalize-reminder.js", []],
  "codex-finalize-reminder": ["apps/mcp/dist/codex-finalize-reminder.js", []],
  check: ["apps/server/dist/doctor.js", []],
  track: ["apps/server/dist/cli.js", ["track"]],
  db: ["apps/server/dist/cli.js", []],
  "setup-agents": ["apps/server/dist/setup-agents.js", []],
  service: ["apps/server/dist/service-cli.js", []],
};

const [command, ...rest] = process.argv.slice(2);
if (!command || command === "--help" || !(command in COMMANDS)) {
  console.error("Usage: work-intelligence <start|mcp|check|track|db|setup-agents|service|finalize-reminder|codex-finalize-reminder> [args]");
  process.exit(command && !(command in COMMANDS) ? 2 : 0);
}

// Standalone defaults, applied only when the caller has not chosen: database under the config directory (never
// inside the installed package), and the bundled Web UI.
const configDirectory = process.env.WORK_INTELLIGENCE_CONFIG_DIR?.trim() || join(homedir(), ".work-intelligence");
if (!process.env.WORK_INTELLIGENCE_DB?.trim()) {
  process.env.WORK_INTELLIGENCE_DB = join(configDirectory, "data", "work-intelligence.sqlite");
  mkdirSync(dirname(process.env.WORK_INTELLIGENCE_DB), { recursive: true });
}
if (!process.env.WORK_INTELLIGENCE_WEB_DIST?.trim() && existsSync(join(libexec, "apps/web/dist/index.html"))) {
  process.env.WORK_INTELLIGENCE_WEB_DIST = join(libexec, "apps/web/dist");
}
process.env.INIT_CWD ??= process.cwd();

const [entry, prefix] = COMMANDS[command];
const target = resolve(libexec, entry);
// The CLIs only run when they are the process entry point, so present the target as argv[1].
process.argv = [process.argv[0], target, ...prefix, ...rest];
await import(pathToFileURL(target).href);
`;

function listFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

function directorySize(directory) {
  return listFiles(directory).reduce((total, file) => total + statSync(file).size, 0);
}

function kib(bytes) {
  return `${(bytes / 1024).toFixed(0)} KiB`;
}

async function bundle(appName, entries, outdir, options = {}) {
  return build({
    entryPoints: entries.map((name) => join(repositoryRoot, `apps/${appName}/src/${name}.ts`)),
    outdir,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "warning",
    legalComments: "none",
    metafile: true,
    define: { __WORK_INTELLIGENCE_STANDALONE__: "true" },
    plugins: [workspaceSources],
    banner: {
      js: 'import { createRequire as __createRequire } from "node:module";const require = __createRequire(import.meta.url);',
    },
    ...options,
  });
}

/** Package names that end up inside the bundles (from the esbuild metafile). */
function bundledPackages(metafiles) {
  const names = new Map();
  for (const metafile of metafiles) {
    for (const input of Object.keys(metafile.inputs)) {
      // pnpm nests packages (node_modules/.pnpm/<id>/node_modules/<name>/...): take the innermost one.
      const match = /node_modules\/((?:@[^/]+\/)?[^/.][^/]*)\/(?!.*node_modules\/)/.exec(input.replaceAll("\\", "/"));
      if (match) names.set(match[1], (names.get(match[1]) ?? 0) + metafile.inputs[input].bytes);
    }
  }
  return [...names.entries()].sort((a, b) => b[1] - a[1]);
}

function externalImports(metafiles) {
  const found = new Set();
  for (const metafile of metafiles) {
    for (const output of Object.values(metafile.outputs)) {
      for (const item of output.imports) if (item.external) found.add(item.path);
    }
  }
  return [...found].sort();
}

async function buildBundle() {
  rmSync(outputRoot, { recursive: true, force: true });
  const version = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")).version;
  const server = await bundle("server", SERVER_ENTRIES, join(libexec, "apps/server/dist"));
  const mcp = await bundle("mcp", MCP_ENTRIES, join(libexec, "apps/mcp/dist"));

  // Size reference only: the same bundles minified into a scratch folder that is deleted right away.
  const scratch = mkdtempSync(join(tmpdir(), "wi-spike-min-"));
  let minifiedBytes = 0;
  let gzipBytes = 0;
  try {
    await bundle("server", SERVER_ENTRIES, join(scratch, "server"), { minify: true });
    await bundle("mcp", MCP_ENTRIES, join(scratch, "mcp"), { minify: true });
    for (const file of listFiles(scratch)) {
      const data = readFileSync(file);
      minifiedBytes += data.length;
      gzipBytes += gzipSync(data).length;
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  // libexec keeps the repository layout because APP_VERSION, agent resources and the doctor read relative paths.
  writeFileSync(
    join(libexec, "package.json"),
    `${JSON.stringify({ name: "work-intelligence-libexec", version, private: true, type: "module" }, null, 2)}\n`,
  );
  for (const file of AGENT_RESOURCES) {
    mkdirSync(dirname(join(libexec, file)), { recursive: true });
    cpSync(join(repositoryRoot, file), join(libexec, file));
  }
  const webSource = join(repositoryRoot, "apps/web/dist");
  if (!existsSync(join(webSource, "index.html"))) throw new Error("apps/web/dist is missing; this spike never builds it.");
  cpSync(webSource, join(libexec, "apps/web/dist"), { recursive: true });

  mkdirSync(join(outputRoot, "bin"), { recursive: true });
  writeFileSync(join(outputRoot, "bin/work-intelligence.mjs"), BIN_SOURCE, { mode: 0o755 });
  writeFileSync(
    join(outputRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "work-intelligence",
        version,
        description: "Spike build of Work Intelligence without a checkout (not published).",
        license: "MIT",
        private: true,
        type: "module",
        bin: { "work-intelligence": "bin/work-intelligence.mjs" },
        engines: { node: ">=22.13.0" },
        files: ["bin", "libexec"],
      },
      null,
      2,
    )}\n`,
  );

  const jsFiles = listFiles(libexec).filter((file) => file.endsWith(".js") && file.includes(`${sep}dist${sep}`));
  const bundleJs = jsFiles.filter((file) => !file.includes(`${sep}web${sep}`));
  const sizes = {
    bundleFiles: bundleJs.length,
    bundleBytes: bundleJs.reduce((total, file) => total + statSync(file).size, 0),
    bundleMinifiedBytes: minifiedBytes,
    bundleMinifiedGzipBytes: gzipBytes,
    webDistBytes: directorySize(join(libexec, "apps/web/dist")),
    agentResourceBytes: AGENT_RESOURCES.reduce((total, file) => total + statSync(join(libexec, file)).size, 0),
    packageDirectoryBytes: directorySize(outputRoot),
    perFile: Object.fromEntries(bundleJs.map((file) => [relative(libexec, file).replaceAll("\\", "/"), statSync(file).size])),
  };
  return {
    version,
    sizes,
    packages: bundledPackages([server.metafile, mcp.metafile]),
    externals: externalImports([server.metafile, mcp.metafile]),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------------------------------------------

function isListening(portNumber) {
  return new Promise((resolvePromise) => {
    const socket = createServer();
    socket.once("error", () => resolvePromise(true));
    socket.listen(portNumber, "127.0.0.1", () => socket.close(() => resolvePromise(false)));
  });
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitForHealth(portNumber, child, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return undefined;
    try {
      const response = await globalThis.fetch(`http://127.0.0.1:${portNumber}/api/health`);
      if (response.ok) return await response.json();
    } catch {
      // Not listening yet.
    }
    await sleep(250);
  }
  return undefined;
}

function killTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (isWindows) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGTERM");
}

function waitForExit(child, timeoutMs = 5000) {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null) return resolvePromise(true);
    const timer = setTimeout(() => resolvePromise(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise(true);
    });
  });
}

/** On Windows npm, npx and .cmd shims are batch files, which only run through a shell. */
function needsShell(command) {
  return isWindows && /\.(cmd|bat)$|^(npm|npx)$/i.test(command);
}

function shellLine(command, commandArgs) {
  return [command, ...commandArgs].map((part) => (/[\s&|<>^]/.test(part) ? `"${part}"` : part)).join(" ");
}

/** Runs a command to completion with a timeout; returns status, stdout and stderr. */
function runSync(command, commandArgs, options = {}) {
  const shell = needsShell(command);
  const result = spawnSync(shell ? shellLine(command, commandArgs) : command, shell ? [] : commandArgs, {
    encoding: "utf8",
    timeout: 120000,
    shell,
    windowsHide: true,
    ...options,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message,
  };
}

function firstLines(text, count = 6) {
  return text.trim().split(/\r?\n/).slice(0, count).join(" | ");
}

async function checkWebAndHealth(portNumber, label, results) {
  const health = await globalThis.fetch(`http://127.0.0.1:${portNumber}/api/health`).then((response) => response.json());
  // The static handler only falls back to index.html for requests that accept HTML, like a browser does.
  const root = await globalThis.fetch(`http://127.0.0.1:${portNumber}/`, { headers: { accept: "text/html" } });
  const html = await root.text();
  const assetMatch = /(?:src|href)="(\/assets\/[^"]+\.js)"/.exec(html);
  let assetStatus = "no asset referenced";
  if (assetMatch) {
    const asset = await globalThis.fetch(`http://127.0.0.1:${portNumber}${assetMatch[1]}`);
    assetStatus = `${asset.status} ${asset.headers.get("content-type")} ${(await asset.arrayBuffer()).byteLength} bytes`;
  }
  const ok = root.status === 200 && html.includes('<div id="app"') && assetStatus.startsWith("200");
  results.push({
    step: `${label}: health + index.html + JS asset`,
    ok: ok && Boolean(health),
    detail: `health=${JSON.stringify(health)} index=${root.status} (${html.length} chars) asset=${assetStatus}`,
  });
}

async function startAndCheck(label, command, commandArgs, environment, results, spawnOptions = {}) {
  const shell = needsShell(command);
  const child = spawn(shell ? shellLine(command, commandArgs) : command, shell ? [] : commandArgs, {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell,
    ...spawnOptions,
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  try {
    const health = await waitForHealth(port, child);
    if (!health) {
      results.push({ step: `${label}: server start`, ok: false, detail: firstLines(output, 10) || "no output" });
      return;
    }
    await checkWebAndHealth(port, label, results);
  } catch (error) {
    results.push({ step: `${label}: checks`, ok: false, detail: String(error?.stack ?? error) });
  } finally {
    killTree(child);
    const stopped = await waitForExit(child);
    for (let attempt = 0; attempt < 20 && (await isListening(port)); attempt += 1) await sleep(250);
    results.push({
      step: `${label}: server stopped`,
      ok: stopped && !(await isListening(port)),
      detail: `port ${port} listening=${await isListening(port)}`,
    });
  }
}

/** One MCP stdio session over newline-delimited JSON-RPC: initialize, tools/list, a read-only tool, a resource read. */
async function mcpSession(nodeArgs, environment, projectRoot) {
  const child = spawn(process.execPath, nodeArgs, { env: environment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const pending = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        const message = JSON.parse(line);
        pending.get(message.id)?.(message);
      }
      index = buffer.indexOf("\n");
    }
  });
  let nextId = 1;
  const request = (method, params) =>
    new Promise((resolvePromise, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`${method} timed out. stderr: ${stderr.slice(0, 500)}`)), 20000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolvePromise(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  try {
    const init = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "standalone-spike", version: "0" },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const tools = await request("tools/list", {});
    const status = await request("tools/call", {
      name: "work_read",
      arguments: { operation: "work_get_project_status", arguments: { projectRoot } },
    });
    const resource = await request("resources/read", { uri: "work-intelligence://agent/work-intelligence/SKILL.md" });
    const statusText = status.result?.content?.[0]?.text ?? "";
    let projectStatus;
    try {
      const parsed = JSON.parse(statusText);
      projectStatus = parsed.project?.status ?? parsed.status;
    } catch {
      projectStatus = undefined;
    }
    return {
      projectStatus,
      ok: Boolean(init.result?.serverInfo) && !status.result?.isError,
      detail:
        `server=${JSON.stringify(init.result?.serverInfo)} tools=${tools.result?.tools?.map((tool) => tool.name).join(",")} ` +
        `status=${statusText.slice(0, 160)} skillResourceChars=${resource.result?.contents?.[0]?.text?.length ?? "ERR " + JSON.stringify(resource.error)}`,
      stderr: firstLines(stderr, 3),
    };
  } finally {
    child.stdin.end();
    killTree(child);
    await waitForExit(child);
  }
}

async function verify(built) {
  const results = [];
  const temp = mkdtempSync(join(tmpdir(), "work-intelligence-spike-"));
  const home = join(temp, "home");
  const configDirectory = join(temp, "config");
  const tempFiles = join(temp, "tmp");
  const projectFolder = join(temp, "synthetic-project");
  for (const directory of [home, configDirectory, tempFiles, projectFolder, join(home, ".codex"), join(home, ".claude")]) {
    mkdirSync(directory, { recursive: true });
  }
  const databasePath = join(temp, "data", "work-intelligence.sqlite");
  mkdirSync(dirname(databasePath), { recursive: true });
  if (resolve(databasePath).startsWith(join(repositoryRoot, "data"))) throw new Error("Refusing to use the repo data/.");

  // Everything a child could write to (home, config, os temp, npm cache) is redirected into the temp directory.
  const baseEnvironment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    TEMP: tempFiles,
    TMP: tempFiles,
    TMPDIR: tempFiles,
    WORK_INTELLIGENCE_DB: databasePath,
    WORK_INTELLIGENCE_CONFIG_DIR: configDirectory,
    WORK_INTELLIGENCE_PORT: String(port),
    npm_config_cache: join(temp, "npm-cache"),
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
  };
  delete baseEnvironment.WORK_INTELLIGENCE_HOME;
  delete baseEnvironment.WORK_INTELLIGENCE_WEB_DIST;
  const bin = join(outputRoot, "bin/work-intelligence.mjs");

  if (await isListening(port)) throw new Error(`Port ${port} is already in use; pick another with --port.`);

  // 1. start from the unpacked directory
  await startAndCheck("1 node bin start", process.execPath, [bin, "start"], baseEnvironment, results);

  // 1b. the default (no WORK_INTELLIGENCE_DB) goes to the config directory, not the package or the repository
  {
    const environment = { ...baseEnvironment };
    delete environment.WORK_INTELLIGENCE_DB;
    await startAndCheck("1b default database location", process.execPath, [bin, "start"], environment, results);
    const expected = join(configDirectory, "data", "work-intelligence.sqlite");
    results.push({ step: "1b default database created under config dir", ok: existsSync(expected), detail: expected });
  }

  // 2. MCP over stdio against the synthetic database
  try {
    const mcp = await mcpSession([bin, "mcp"], baseEnvironment, projectFolder);
    results.push({ step: "2 MCP stdio initialize + work_get_project_status + resources/read", ok: mcp.ok, detail: mcp.detail });
  } catch (error) {
    results.push({ step: "2 MCP stdio", ok: false, detail: String(error?.stack ?? error) });
  }

  // 2b. track writes to the synthetic database only
  {
    const track = runSync(process.execPath, [bin, "track", projectFolder, "--name", "spike-project", "--yes"], {
      env: baseEnvironment,
      cwd: temp,
    });
    results.push({ step: "2b track <folder> --yes", ok: track.status === 0, detail: firstLines(track.stdout + track.stderr, 4) });
    const mcp = await mcpSession([bin, "mcp"], baseEnvironment, projectFolder).catch((error) => ({ ok: false, detail: String(error) }));
    results.push({
      step: "2c MCP sees the tracked project",
      ok: Boolean(mcp.ok && mcp.projectStatus === "tracked"),
      detail: `project status=${mcp.projectStatus}`,
    });
  }

  // 2d. database CLI
  {
    const backups = runSync(process.execPath, [bin, "db", "backups"], { env: baseEnvironment, cwd: temp });
    results.push({ step: "2d db backups (database CLI)", ok: backups.status === 0, detail: firstLines(backups.stdout + backups.stderr, 3) });
  }

  // 2e. doctor: expected to complain about missing repository files; recorded as information
  {
    const check = runSync(process.execPath, [bin, "check"], { env: baseEnvironment, cwd: temp });
    results.push({
      step: "2e check (doctor) [informational]",
      ok: check.status === 0,
      detail: `exit=${check.status} ${firstLines(check.stdout + check.stderr, 14)}`,
    });
  }

  // 2f. setup-agents preview only (stdin is not a TTY, so it never writes); HOME is the temp home
  {
    const setup = runSync(process.execPath, [bin, "setup-agents"], { env: baseEnvironment, cwd: temp, input: "" });
    results.push({
      step: "2f setup-agents preview (non-interactive, writes nothing) [informational]",
      ok: setup.status === 0,
      detail: `exit=${setup.status} ${firstLines(setup.stdout + setup.stderr, 4)}`,
    });

    // The CLI only applies a plan after an interactive "yes", so apply it through a throwaway harness that imports the
    // same agent-setup module, pointing home at the temp home and the repository root at the package's libexec.
    const harness = join(temp, "apply-agent-setup.mjs");
    await build({
      stdin: {
        contents: `import { createAgentSetupPlan, applyAgentSetupPlan } from ${JSON.stringify(join(repositoryRoot, "apps/server/src/agent-setup.ts"))};
const plan = createAgentSetupPlan({ homeDirectory: ${JSON.stringify(home)}, repositoryRoot: ${JSON.stringify(libexec)}, codexHomeDirectory: ${JSON.stringify(join(home, ".codex"))}, claudeConfigDirectory: ${JSON.stringify(join(home, ".claude"))} });
console.log(JSON.stringify({ conflicts: plan.conflicts, mutations: plan.mutations.length }));
const result = applyAgentSetupPlan(plan);
console.log(JSON.stringify({ applied: result.applied, error: result.error }));`,
        resolveDir: repositoryRoot,
        loader: "ts",
      },
      outfile: harness,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      logLevel: "silent",
      plugins: [workspaceSources],
      banner: { js: 'import { createRequire as __createRequire } from "node:module";const require = __createRequire(import.meta.url);' },
    });
    const applied = runSync(process.execPath, [harness], { env: baseEnvironment, cwd: temp });
    const claudeJson = existsSync(join(home, ".claude.json")) ? readFileSync(join(home, ".claude.json"), "utf8") : "";
    const codexToml = existsSync(join(home, ".codex", "config.toml")) ? readFileSync(join(home, ".codex", "config.toml"), "utf8") : "";
    const registered = /libexec(?:\\\\|\\|\/)+apps(?:\\\\|\\|\/)+mcp(?:\\\\|\\|\/)+dist(?:\\\\|\\|\/)+index\.js/.test(
      claudeJson + codexToml,
    );
    results.push({
      step: "2g setup:agents applied to the temp HOME registers a path inside the package",
      ok: applied.status === 0 && registered,
      detail: `${firstLines(applied.stdout + applied.stderr, 3)} | claude.json mcp command=${JSON.stringify(JSON.parse(claudeJson || "{}").mcpServers?.["work-intelligence"] ?? null)}`,
    });
  }

  // 3. npm pack, install into a temp prefix, run the installed bin, then npx the tarball
  const packDirectory = join(temp, "pack");
  mkdirSync(packDirectory, { recursive: true });
  const pack = runSync("npm", ["pack", "--json", "--pack-destination", packDirectory], { env: baseEnvironment, cwd: outputRoot });
  let tarball;
  try {
    const info = JSON.parse(pack.stdout)[0];
    tarball = join(packDirectory, info.filename);
    results.push({
      step: "3a npm pack",
      ok: pack.status === 0 && existsSync(tarball),
      detail: `tarball=${info.filename} size=${kib(info.size)} unpacked=${kib(info.unpackedSize)} files=${info.entryCount}`,
    });
    built.sizes.tarballBytes = info.size;
    built.sizes.unpackedBytes = info.unpackedSize;
  } catch {
    results.push({ step: "3a npm pack", ok: false, detail: firstLines(pack.stdout + pack.stderr + (pack.error ?? ""), 8) });
  }

  if (tarball) {
    const prefix = join(temp, "install-prefix");
    mkdirSync(prefix, { recursive: true });
    const install = runSync("npm", ["install", "--prefix", prefix, tarball], { env: baseEnvironment, cwd: temp });
    results.push({ step: "3b npm i --prefix <temp> <tarball>", ok: install.status === 0, detail: firstLines(install.stdout + install.stderr, 6) });
    const shim = join(prefix, "node_modules", ".bin", isWindows ? "work-intelligence.cmd" : "work-intelligence");
    if (install.status === 0 && existsSync(shim)) {
      await startAndCheck("3c installed bin start", shim, ["start"], baseEnvironment, results);
      const installedPackage = join(prefix, "node_modules", "work-intelligence");
      results.push({
        step: "3c installed package size on disk",
        ok: true,
        detail: `${kib(directorySize(installedPackage))}; node_modules entries under the package: ${existsSync(join(installedPackage, "node_modules"))}`,
      });
    }
    // npx with the tarball (cache redirected to the temp directory). A relative ./file.tgz and a file: URL are
    // the documented forms; a bare absolute Windows path is recorded too because it did not work in the spike.
    const npxCache = join(temp, "npx-cache");
    await startAndCheck("3d npx ./tarball start", "npx", ["--yes", "--cache", npxCache, `./${relative(packDirectory, tarball)}`, "start"], baseEnvironment, results, { cwd: packDirectory });
    await startAndCheck("3e npx file:URL start", "npx", ["--yes", "--cache", npxCache, `file:${tarball.replaceAll("\\", "/")}`, "start"], baseEnvironment, results, { cwd: temp });
  }

  results.push({ step: "end: spike port is free", ok: !(await isListening(port)), detail: `port ${port}` });
  writeFileSync(join(temp, "results.json"), `${JSON.stringify({ built, results }, null, 2)}\n`);
  return { results, temp };
}

// ---------------------------------------------------------------------------------------------------------------

const built = await buildBundle();
console.log(`Built ${relative(repositoryRoot, outputRoot)} (version ${built.version})`);
console.log(`  bundles:   ${built.sizes.bundleFiles} files, ${kib(built.sizes.bundleBytes)} unminified`);
console.log(`  minified:  ${kib(built.sizes.bundleMinifiedBytes)} (gzip ${kib(built.sizes.bundleMinifiedGzipBytes)})`);
console.log(`  web dist:  ${kib(built.sizes.webDistBytes)}; agent resources ${kib(built.sizes.agentResourceBytes)}`);
console.log(`  package directory total: ${kib(built.sizes.packageDirectoryBytes)}`);
console.log(`  bundled npm packages: ${built.packages.map(([name, bytes]) => `${name} (${kib(bytes)})`).join(", ")}`);
console.log(`  external imports left in the bundles: ${built.externals.join(", ")}`);

if (skipVerify) process.exit(0);

let temp;
let failed = 0;
try {
  const outcome = await verify(built);
  temp = outcome.temp;
  for (const result of outcome.results) {
    if (!result.ok) failed += 1;
    console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.step}\n        ${result.detail}`);
  }
  if (built.sizes.tarballBytes) console.log(`tarball ${kib(built.sizes.tarballBytes)}, unpacked ${kib(built.sizes.unpackedBytes)}`);
  console.log(`Temp directory: ${temp}${keepTemp ? " (kept)" : ""}`);
} finally {
  if (temp && !keepTemp) rmSync(temp, { recursive: true, force: true });
}
process.exitCode = failed > 0 ? 1 : 0;
