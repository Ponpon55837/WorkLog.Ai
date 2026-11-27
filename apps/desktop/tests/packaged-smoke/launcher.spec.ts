import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { windowsCommandShell } from "@work-intelligence/shared/windows-system-tool";
import {
  appEnvironment,
  createSandbox,
  packagedExecutable,
  portIsFree,
  quitCommand,
  readLog,
  removeSandbox,
  resolvedPath,
  startApp,
  stopApp,
  waitForManaged,
  type PackagedSandbox,
  type RunningApp,
} from "./helpers.js";

const SESSION_TIMEOUT_MS = 60_000;
const repositoryRoot = join(import.meta.dirname, "..", "..", "..", "..");
const pluginLauncher = join(repositoryRoot, "plugins", "work-intelligence", "scripts", "launch.mjs");

let sandbox: PackagedSandbox | undefined;
let app: RunningApp | undefined;

test.afterEach(async () => {
  if (sandbox) await stopApp(sandbox, app);
  app = undefined;
  if (sandbox) await removeSandbox(sandbox);
  sandbox = undefined;
});

interface Integration {
  readonly version: number;
  readonly launcherPath: string;
  readonly runtimeRoot: string;
  readonly appExecutable: string;
  readonly appVersion: string;
  readonly writtenAt: string;
}

interface McpMessage {
  jsonrpc?: string;
  id?: number;
  result?: { serverInfo?: { name?: string }; tools?: Array<{ name: string }> };
}

interface McpResult {
  readonly responses: ReadonlyMap<number, McpMessage>;
  readonly strayStdout: readonly string[];
  readonly code: number | null;
  readonly stderr: string;
}

function recordFile(current: PackagedSandbox): string {
  return join(current.home, ".work-intelligence", "desktop-integration.json");
}

/** A `.cmd` cannot be spawned directly on Windows: it goes through System32's cmd.exe, as an Agent host does. */
function startCommand(command: string, args: readonly string[]): { file: string; args: string[]; verbatim: boolean } {
  if (process.platform !== "win32" || !command.endsWith(".cmd"))
    return { file: command, args: [...args], verbatim: false };
  return { file: windowsCommandShell(), args: ["/d", "/s", "/c", `""${command}" ${args.join(" ")}"`], verbatim: true };
}

/** Runs `initialize` and `tools/list` over stdio, then closes stdin the way an Agent ends its session. */
function mcpSession(current: PackagedSandbox, command: string, args: readonly string[]): Promise<McpResult> {
  const start = startCommand(command, args);
  const child: ChildProcess = spawn(start.file, start.args, {
    env: appEnvironment(current),
    cwd: current.root,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments: start.verbatim,
  });
  const requests = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "launcher-smoke", version: "0" } },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ];
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
    if (stdout.includes('"id":2')) child.stdin?.end();
  });
  child.stderr?.on("data", (chunk: string) => (stderr += chunk));
  child.stdin?.on("error", () => undefined);
  child.stdin?.write(`${requests.map((request) => JSON.stringify(request)).join("\n")}\n`);
  return new Promise((resolveSession, rejectSession) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectSession(new Error(`the MCP session did not finish in ${SESSION_TIMEOUT_MS} ms; stderr:\n${stderr}`));
    }, SESSION_TIMEOUT_MS);
    child.once("error", rejectSession);
    child.once("close", (code) => {
      clearTimeout(timer);
      const responses = new Map<number, McpMessage>();
      const strayStdout: string[] = [];
      for (const line of stdout.split("\n").filter(Boolean)) {
        try {
          const message = JSON.parse(line) as McpMessage;
          if (message.jsonrpc === "2.0" && typeof message.id === "number") responses.set(message.id, message);
          else strayStdout.push(line);
        } catch {
          strayStdout.push(line);
        }
      }
      resolveSession({ responses, strayStdout, code, stderr });
    });
  });
}

function expectCompleteSession(session: McpResult): void {
  expect(session.strayStdout, `stderr:\n${session.stderr}`).toEqual([]);
  expect(session.responses.get(1)?.result?.serverInfo?.name).toBe("work-intelligence");
  const tools = (session.responses.get(2)?.result?.tools ?? []).map((tool) => tool.name);
  expect(tools).toEqual(expect.arrayContaining(["work_read", "work_write_idempotent"]));
}

test("after the App has quit, the fixed launcher still completes MCP initialize and tools/list", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  app = startApp(sandbox);
  const backend = await waitForManaged(sandbox);

  // The record the App leaves for Agents: paths and a version only, naming this installation.
  const text = readFileSync(recordFile(sandbox), "utf8");
  const record = JSON.parse(text) as Integration;
  const shim = process.platform === "win32" ? "work-intelligence-launcher.cmd" : "work-intelligence-launcher";
  expect(Object.keys(record)).toEqual([
    "version",
    "launcherPath",
    "runtimeRoot",
    "appExecutable",
    "appVersion",
    "writtenAt",
  ]);
  expect(record.version).toBe(1);
  // The App stores real paths (macOS `/var` -> `/private/var`, Windows long names and letter case).
  const runtimeRoot = resolvedPath(join(sandbox.userData, "runtime"));
  expect(record.runtimeRoot).toBe(runtimeRoot);
  expect(record.launcherPath).toBe(join(runtimeRoot, "bin", shim));
  expect(record.appExecutable).toBe(resolvedPath(packagedExecutable()));
  expect(text).not.toContain(sandbox.databasePath);

  expect((await quitCommand(sandbox)).code).toBe(0);
  await app.exited;
  expect(await portIsFree(backend.port)).toBe(true);

  // Nothing of the App runs now; the shim alone starts the runtime it left behind.
  expectCompleteSession(await mcpSession(sandbox, record.launcherPath, ["mcp"]));
  const throughPlugin = await mcpSession(sandbox, process.execPath, [pluginLauncher, "mcp"]);
  expectCompleteSession(throughPlugin);
  expect(throughPlugin.code).toBe(0);
});

test("a warm start does not rewrite the integration record", async () => {
  sandbox = await createSandbox({ withDatabase: true });
  app = startApp(sandbox);
  await waitForManaged(sandbox);
  const first = readFileSync(recordFile(sandbox), "utf8");
  await quitCommand(sandbox);
  await app.exited;

  const logLength = readLog(sandbox).length;
  app = startApp(sandbox);
  await waitForManaged(sandbox, logLength);
  // `writtenAt` is the time of the write: identical text means nothing was written.
  expect(readFileSync(recordFile(sandbox), "utf8")).toBe(first);
});
