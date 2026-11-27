import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { delimiter, join } from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { clearTimeout, setTimeout } from "node:timers";
import {
  windowsCommandShell,
  windowsPowerShell,
  windowsSystemTool,
} from "../../packages/shared/dist/windows-system-tool.js";

const WINDOWS = process.platform === "win32";

export function sleep(milliseconds) {
  return new Promise((done) => setTimeout(done, milliseconds));
}

export function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

export async function portIsFree(port) {
  return new Promise((done) => {
    const probe = createServer();
    probe.once("error", () => done(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
  });
}

export function excerpt(text, lines = 6) {
  return text.trim().split(/\r?\n/).slice(0, lines).join(" | ");
}

export function directoriesWithoutNode(pathValue) {
  return pathValue
    .split(delimiter)
    .filter(Boolean)
    .filter((directory) => !["node", "node.exe", "nodejs"].some((name) => existsSync(join(directory, name))));
}

export function findNodeOnPath(pathValue) {
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const name of ["node", "node.exe"]) if (existsSync(join(directory, name))) return join(directory, name);
  }
  return undefined;
}

/** The proxy is unreachable on purpose, so a hidden network need shows up as a failure. */
export function noNodeEnvironment(root, port) {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (/^(WORK_INTELLIGENCE_|NODE_|ELECTRON_|INIT_CWD$|npm_|(https?|all|no)_proxy$)/i.test(name))
      delete environment[name];
    if (name.toLowerCase() === "path") delete environment[name];
  }
  const home = join(root, "home");
  const scratch = join(root, "tmp");
  for (const directory of [home, scratch, join(home, ".codex"), join(home, ".claude")]) {
    mkdirSync(directory, { recursive: true });
  }
  const safePath = directoriesWithoutNode(process.env.PATH ?? process.env.Path ?? "").join(delimiter);
  const unreachable = "http://127.0.0.1:9";
  return {
    ...environment,
    [WINDOWS ? "Path" : "PATH"]: safePath,
    NODE_OPTIONS: "",
    HTTP_PROXY: unreachable,
    HTTPS_PROXY: unreachable,
    ALL_PROXY: unreachable,
    NO_PROXY: "",
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    WORK_INTELLIGENCE_CONFIG_DIR: join(root, "config"),
    WORK_INTELLIGENCE_PORT: String(port),
    TMPDIR: scratch,
    TEMP: scratch,
    TMP: scratch,
  };
}

/** How to start the shim: a .cmd cannot be spawned directly on Windows, so it goes through cmd.exe as an Agent's host does. */
function shimCommand(shim, args) {
  if (!WINDOWS) return { command: shim, args, options: {} };
  return {
    command: windowsCommandShell(),
    args: ["/d", "/s", "/c", `""${shim}" ${args.join(" ")}"`],
    options: { windowsVerbatimArguments: true },
  };
}

export class Launched {
  stdout = "";
  stderr = "";

  constructor(command, args, { env, cwd, stdin = "pipe", verbatim = false }) {
    this.startedAt = performance.now();
    this.child = spawn(command, args, {
      env,
      cwd,
      stdio: [stdin, "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
    });
    this.child.stdout.on("data", (chunk) => (this.stdout += chunk));
    this.child.stderr.on("data", (chunk) => (this.stderr += chunk));
    this.exited = new Promise((done) => this.child.once("close", (code, signal) => done({ code, signal })));
    this.child.once("error", (error) => (this.stderr += `spawn error: ${error.message}\n`));
  }

  get output() {
    return `${this.stdout}${this.stderr}`;
  }

  get running() {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  /** Stops the process and everything it started; Windows needs taskkill because the shim is a cmd.exe parent. */
  async stop() {
    if (!this.running) return;
    if (WINDOWS) {
      spawnSync(windowsSystemTool("taskkill.exe"), ["/pid", String(this.child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      this.child.kill("SIGTERM");
    }
    await Promise.race([this.exited, sleep(10_000)]);
    if (this.running) this.child.kill("SIGKILL");
    await Promise.race([this.exited, sleep(5_000)]);
  }
}

export function startShim(shim, args, { env, cwd, stdin }) {
  const { command, args: commandArgs, options } = shimCommand(shim, args);
  return new Launched(command, commandArgs, { env, cwd, stdin, verbatim: options.windowsVerbatimArguments });
}

export async function runShim(shim, args, { env, cwd, input = "", timeoutMs = 60_000 }) {
  const launched = startShim(shim, args, { env, cwd });
  launched.child.stdin.on("error", () => {});
  launched.child.stdin.end(input);
  const timer = setTimeout(() => void launched.stop(), timeoutMs);
  const { code } = await launched.exited;
  clearTimeout(timer);
  return {
    code,
    stdout: launched.stdout,
    stderr: launched.stderr,
    milliseconds: performance.now() - launched.startedAt,
  };
}

export async function waitForHealth(port, launched, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!launched.running) throw new Error(`server exited early: ${excerpt(launched.output)}`);
    try {
      const response = await globalThis.fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return await response.json();
    } catch {
      // Not listening yet.
    }
    await sleep(25);
  }
  throw new Error(`no healthy /api/health within ${timeoutMs / 1000} s: ${excerpt(launched.output)}`);
}

export class McpSession {
  nonProtocolLines = [];
  #pending = new Map();
  #buffer = "";
  #nextId = 1;

  constructor(launched) {
    this.launched = launched;
    launched.child.stdout.on("data", (chunk) => this.#onData(String(chunk)));
    launched.child.stdin.on("error", () => {});
  }

  #onData(text) {
    this.#buffer += text;
    for (let index = this.#buffer.indexOf("\n"); index >= 0; index = this.#buffer.indexOf("\n")) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.nonProtocolLines.push(line);
        continue;
      }
      if (message?.jsonrpc !== "2.0") this.nonProtocolLines.push(line);
      this.#pending.get(message.id)?.(message);
    }
  }

  request(method, params, timeoutMs = 30_000) {
    return new Promise((done, fail) => {
      const id = this.#nextId++;
      const timer = setTimeout(
        () => fail(new Error(`${method} timed out: ${excerpt(this.launched.stderr, 3)}`)),
        timeoutMs,
      );
      this.#pending.set(id, (message) => {
        clearTimeout(timer);
        done(message);
      });
      this.launched.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method) {
    this.launched.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  async initialize() {
    const response = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "runtime-spike-smoke", version: "0" },
    });
    this.notify("notifications/initialized");
    return response;
  }
}

/** One PowerShell script: no profile, no prompt, no stdin, and no CLIXML progress records in the output. */
function powershellArguments(script) {
  const encoded = Buffer.from(`$ProgressPreference='SilentlyContinue';${script}`, "utf16le").toString("base64");
  return ["-NoProfile", "-NonInteractive", "-InputFormat", "None", "-EncodedCommand", encoded];
}

/** The PID of the runtime itself: the shim `exec`s it on POSIX, but on Windows cmd.exe stays as its parent. */
export function runtimePid(launched, executableName) {
  if (!WINDOWS) return launched.child.pid;
  const script = `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${launched.child.pid} AND Name='${executableName}'").ProcessId`;
  const result = spawnSync(windowsPowerShell(), powershellArguments(script), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return Number(result.stdout.trim().split(/\s+/)[0]) || undefined;
}

function powershellNumber(expression) {
  const result = spawnSync(windowsPowerShell(), powershellArguments(expression), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return Number(result.stdout.trim());
}

export function residentBytes(pid) {
  if (process.platform === "linux") {
    const kilobytes = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1];
    return Number(kilobytes) * 1024;
  }
  if (process.platform === "darwin") {
    return Number(spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim()) * 1024;
  }
  return powershellNumber(`(Get-Process -Id ${pid}).WorkingSet64`);
}

export function cpuSeconds(pid) {
  if (process.platform === "linux") {
    // Fields 14 and 15 of /proc/<pid>/stat, after the parenthesised name, in clock ticks (100 per second on Linux).
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8")
      .replace(/^.*\) /, "")
      .split(" ");
    return (Number(fields[11]) + Number(fields[12])) / 100;
  }
  if (process.platform === "darwin") {
    const text = spawnSync("ps", ["-o", "cputime=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
    return text.split(":").reduce((total, part) => total * 60 + Number(part), 0);
  }
  return powershellNumber(`(Get-Process -Id ${pid}).TotalProcessorTime.TotalSeconds`);
}
