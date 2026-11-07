import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBuildIdReader,
  MCP_LAUNCHER_ENVIRONMENT,
  McpSupervisor,
  stopServerProcess,
} from "../../apps/mcp/src/launcher.js";
import {
  createLauncherUpdateCheck,
  readLauncherIdentity,
  SUPERVISED_ENVIRONMENT,
  supervisedRestartStatus,
} from "../../apps/mcp/src/supervision.js";

type Message = Record<string, unknown> & { id?: unknown; method?: unknown; result?: Record<string, unknown> };

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const temporaryDirectories: string[] = [];
const supervisors: McpSupervisor[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(process.env.WORK_INTELLIGENCE_TEST_TMP?.trim() || tmpdir(), "wi-launcher-"));
  temporaryDirectories.push(directory);
  return directory;
}

/**
 * A synthetic MCP server: answers initialize, tools/list, resources/list, `whoami` (its build, pid and the
 * initialize it received), `slow` (answers after a delay), `hang` (never answers) and `crash` (exits without
 * answering). With `slowLists`, tools/list and resources/list answer after 1.5 s.
 */
function fakeServer(
  build: string,
  tools: string[],
  options: { brokenStartup?: boolean; slowLists?: boolean } = {},
): string {
  return [
    options.brokenStartup ? 'throw new Error("broken build");' : "",
    `const BUILD = ${JSON.stringify(build)};`,
    `const TOOLS = ${JSON.stringify(tools)};`,
    `const LIST_DELAY = ${options.slowLists ? 1_500 : 0};`,
    "let initialize; let initialized = false; let pending = '';",
    "const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('end', () => process.exit(0));",
    "process.stdin.on('data', (chunk) => {",
    "  pending += chunk;",
    "  let index;",
    "  while ((index = pending.indexOf('\\n')) >= 0) {",
    "    const message = JSON.parse(pending.slice(0, index)); pending = pending.slice(index + 1);",
    "    if (message.method === 'initialize') { initialize = message.params;",
    "      send({ id: message.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'fake', version: BUILD }, capabilities: { tools: { listChanged: true } } } }); }",
    "    else if (message.method === 'notifications/initialized') initialized = true;",
    "    else if (message.method === 'tools/list') { const id = message.id; setTimeout(() => send({ id, result: { tools: TOOLS.map((name) => ({ name })) } }), LIST_DELAY); }",
    "    else if (message.method === 'resources/list') { const id = message.id; setTimeout(() => send({ id, result: { resources: [] } }), LIST_DELAY); }",
    "    else if (message.method === 'hang') { /* never answers */ }",
    "    else if (message.method === 'whoami') send({ id: message.id, result: { build: BUILD, pid: process.pid, initialize, initialized } });",
    "    else if (message.method === 'slow') setTimeout(() => send({ id: message.id, result: { build: BUILD } }), 400);",
    "    else if (message.method === 'crash') process.exit(7);",
    "    else if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: 'unknown' } });",
    "  }",
    "});",
  ].join("\n");
}

function harness(
  initialBuild = "A",
  tools = ["work_read"],
  timeouts: { startupTimeoutMs?: number; drainTimeoutMs?: number } = {},
) {
  const root = temporaryDirectory();
  const entryPath = join(root, "apps/mcp/dist/index.js");
  mkdirSync(join(root, "apps/mcp/dist"), { recursive: true });
  writeFileSync(entryPath, fakeServer(initialBuild, tools));
  let buildId: string | undefined = initialBuild;
  const input = new PassThrough();
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  const messages: Message[] = [];
  const waiters: { predicate: (message: Message) => boolean; resolve: (message: Message) => void }[] = [];
  let buffer = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, index)) as Message;
      buffer = buffer.slice(index + 1);
      messages.push(message);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(message)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
    }
  });
  const supervisor = new McpSupervisor({
    entryPath,
    readBuildId: () => buildId,
    input,
    output,
    errorOutput,
    pollIntervalMs: 50,
    startupTimeoutMs: timeouts.startupTimeoutMs ?? 3_000,
    stopTimeoutMs: 1_000,
    ...(timeouts.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: timeouts.drainTimeoutMs }),
  });
  supervisors.push(supervisor);
  const waitFor = (predicate: (message: Message) => boolean): Promise<Message> => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => waiters.push({ predicate, resolve }));
  };
  return {
    supervisor,
    messages,
    send: (message: Record<string, unknown>) => input.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`),
    response: (id: unknown) => waitFor((message) => message.id === id),
    waitFor,
    /** Writes a new build to disk the way `pnpm build` does, then exposes its id. */
    publish: (
      build: string | undefined,
      nextTools = tools,
      options: { brokenStartup?: boolean; slowLists?: boolean } = {},
    ) => {
      writeFileSync(entryPath, fakeServer(build ?? "?", nextTools, options));
      buildId = build;
    },
    initialize: async () => {
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "codex" } } })}\n`,
      );
      await waitFor((message) => message.id === 1);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    },
  };
}

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.close()));
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("McpSupervisor", () => {
  it("relays requests and switches to a new build on the same connection with a replayed initialize", async () => {
    const test = harness("A", ["work_read"]);
    await test.supervisor.start();
    await test.initialize();
    test.send({ id: 2, method: "whoami" });
    const before = (await test.response(2)).result!;
    expect(before).toMatchObject({ build: "A", initialized: true });

    test.publish("B", ["work_read", "work_write"]);
    test.send({ id: 3, method: "whoami" });
    const after = (await test.response(3)).result!;

    expect(after).toMatchObject({ build: "B", initialize: { clientInfo: { name: "codex" } }, initialized: true });
    expect(after.pid).not.toBe(before.pid);
    expect(test.supervisor.runningBuildId()).toBe("B");
    // The replayed initialize is answered privately; the Agent sees exactly one initialize response.
    expect(test.messages.filter((message) => (message.result as { serverInfo?: unknown })?.serverInfo)).toHaveLength(1);
    await test.waitFor((message) => message.method === "notifications/tools/list_changed");
  });

  it("does not announce a tools change when the new build advertises the same tools", async () => {
    const test = harness("A", ["work_read"]);
    await test.supervisor.start();
    await test.initialize();
    test.publish("B", ["work_read"]);
    test.send({ id: 2, method: "whoami" });
    expect((await test.response(2)).result).toMatchObject({ build: "B" });
    expect(test.messages.some((message) => message.method === "notifications/tools/list_changed")).toBe(false);
  });

  it("switches while idle, without waiting for the next request", async () => {
    const test = harness("A");
    await test.supervisor.start();
    await test.initialize();
    test.publish("B");
    await expect.poll(() => test.supervisor.runningBuildId(), { timeout: 5_000 }).toBe("B");
  });

  it("finishes requests in flight on the old build before switching, and loses none", async () => {
    const test = harness("A");
    await test.supervisor.start();
    await test.initialize();
    test.send({ id: 2, method: "slow" });
    test.publish("B");
    test.send({ id: 3, method: "whoami" });
    test.send({ id: 4, method: "whoami" });

    const [slow, first, second] = await Promise.all([test.response(2), test.response(3), test.response(4)]);
    expect(slow.result).toMatchObject({ build: "A" });
    expect(first.result).toMatchObject({ build: "B" });
    expect(second.result).toMatchObject({ build: "B" });
    const order = test.messages.map((message) => message.id).filter((id) => id === 2 || id === 3);
    expect(order).toEqual([2, 3]);
  });

  it("keeps the old build when the new one cannot start, reports it once, and serves the next request", async () => {
    const test = harness("A");
    await test.supervisor.start();
    await test.initialize();
    test.publish("C", ["work_read"], { brokenStartup: true });
    test.send({ id: 2, method: "whoami" });
    const failed = await test.response(2);
    expect(failed.error).toMatchObject({ code: -32603, message: expect.stringContaining("無法啟動") });

    test.send({ id: 3, method: "whoami" });
    expect((await test.response(3)).result).toMatchObject({ build: "A" });
    expect(test.supervisor.runningBuildId()).toBe("A");

    // A later, working build is still picked up.
    test.publish("D");
    test.send({ id: 4, method: "whoami" });
    expect((await test.response(4)).result).toMatchObject({ build: "D", initialized: true });
  });

  it("answers requests lost in a crash with an error and restarts the server with the replayed handshake", async () => {
    const test = harness("A");
    await test.supervisor.start();
    await test.initialize();
    test.send({ id: 2, method: "crash" });
    expect((await test.response(2)).error).toMatchObject({ code: -32603 });

    test.send({ id: 3, method: "whoami" });
    expect((await test.response(3)).result).toMatchObject({ build: "A", initialized: true });
  });

  it("drops the launcher's own responses that arrive after their wait timed out", async () => {
    const test = harness("A", ["work_read"], { startupTimeoutMs: 1_000 });
    await test.supervisor.start();
    await test.initialize();
    test.publish("B", ["work_read", "work_write"], { slowLists: true });
    test.send({ id: 2, method: "whoami" });
    expect((await test.response(2)).result).toMatchObject({ build: "B" });
    // The new server answers the launcher's tools/list and resources/list after the 1 s wait gave up.
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    expect(test.messages.filter((message) => typeof message.id === "string")).toEqual([]);
  });

  it("forgets a cancelled request, so it does not hold back the next build", async () => {
    // Without the cancellation, the swap would wait out the 2 s drain and the old build would answer.
    const test = harness("A", ["work_read"], { drainTimeoutMs: 2_000 });
    await test.supervisor.start();
    await test.initialize();
    test.send({ id: 2, method: "hang" });
    test.send({ method: "notifications/cancelled", params: { requestId: 2, reason: "user stopped" } });
    test.publish("B");
    test.send({ id: 3, method: "whoami" });
    expect((await test.response(3)).result).toMatchObject({ build: "B" });
  });

  it("waits for a stuck request only once, then serves later requests from the old build without delay", async () => {
    const test = harness("A", ["work_read"], { drainTimeoutMs: 2_000 });
    await test.supervisor.start();
    await test.initialize();
    test.send({ id: 2, method: "hang" });
    test.publish("B");
    test.send({ id: 3, method: "whoami" });
    expect((await test.response(3)).result).toMatchObject({ build: "A" });

    // Waiting for the drain again would take another 2 s; the old build answers right away instead.
    const started = Date.now();
    test.send({ id: 4, method: "whoami" });
    expect((await test.response(4)).result).toMatchObject({ build: "A" });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(test.supervisor.runningBuildId()).toBe("A");
  });

  it("queues requests that arrive before the first server is ready", async () => {
    const test = harness("A");
    const started = test.supervisor.start();
    test.send({ id: 1, method: "initialize", params: { clientInfo: { name: "claude" } } });
    await started;
    expect(await test.response(1)).toHaveProperty("result");
  });
});

describe("stopServerProcess", () => {
  it.each(["win32", "darwin"] as const)("stops a child that ignores stdin closing on %s", async (platform) => {
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
    await new Promise((resolve) => child.once("spawn", resolve));
    const signals: unknown[] = [];
    const kill = child.kill.bind(child);
    child.kill = (signal?: NodeJS.Signals | number) => {
      signals.push(signal);
      return kill(signal);
    };
    await stopServerProcess(child, exited, { platform, timeoutMs: 300 });
    await exited;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    // Windows is terminated with a plain kill() (TerminateProcess); elsewhere SIGTERM comes first.
    expect(signals[0]).toBe(platform === "win32" ? undefined : "SIGTERM");
  });
});

describe("createBuildIdReader", () => {
  function checkout(entry: string): { root: string; entryPath: string } {
    const root = temporaryDirectory();
    mkdirSync(join(root, "apps/mcp/dist"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "9.9.9" }));
    const entryPath = join(root, "apps/mcp/dist/index.js");
    writeFileSync(entryPath, entry);
    return { root, entryPath };
  }

  it("reads the embedded build hash as <version>:<hash> and follows a rebuild", () => {
    const { root, entryPath } = checkout(`const MCP_BUILD_DIST_HASH = "${HASH_A}";`);
    const read = createBuildIdReader(root, entryPath);
    expect(read()).toBe(`9.9.9:${HASH_A}`);
    writeFileSync(entryPath, `const MCP_BUILD_DIST_HASH = "${HASH_B}"; // rebuilt`);
    expect(read()).toBe(`9.9.9:${HASH_B}`);
  });

  it("returns nothing while a build is in progress or before the hash is embedded", () => {
    const { root, entryPath } = checkout('const MCP_BUILD_DIST_HASH = "__WORK_INTELLIGENCE_BUILD_HASH__";');
    const read = createBuildIdReader(root, entryPath);
    expect(read()).toBeUndefined();
    writeFileSync(entryPath, `const MCP_BUILD_DIST_HASH = "${HASH_A}";`);
    writeFileSync(join(root, ".work-intelligence-build-in-progress"), "{}");
    expect(read()).toBeUndefined();
    rmSync(join(root, ".work-intelligence-build-in-progress"));
    expect(read()).toBe(`9.9.9:${HASH_A}`);
  });

  it("handles Windows-style checkout paths", () => {
    const { root, entryPath } = checkout(`const MCP_BUILD_DIST_HASH = "${HASH_A}";`);
    const windowsLike = entryPath.replaceAll("/", "\\");
    // path.resolve on POSIX treats backslashes as name characters; the reader must fail closed, not throw.
    expect(() => createBuildIdReader(root, process.platform === "win32" ? entryPath : windowsLike)()).not.toThrow();
  });
});

describe("supervision", () => {
  it("reads the same environment variables the launcher sets", () => {
    expect(SUPERVISED_ENVIRONMENT).toEqual(MCP_LAUNCHER_ENVIRONMENT);
  });

  it("reads the launcher identity only when every variable is valid", () => {
    expect(readLauncherIdentity({})).toBeUndefined();
    expect(
      readLauncherIdentity({
        WORK_INTELLIGENCE_MCP_LAUNCHER_PATH: "C:\\Work Intelligence\\apps\\mcp\\dist\\launcher.js",
        WORK_INTELLIGENCE_MCP_LAUNCHER_HASH: HASH_A,
        WORK_INTELLIGENCE_MCP_LAUNCHER_VERSION: "1",
      }),
    ).toEqual({ path: "C:\\Work Intelligence\\apps\\mcp\\dist\\launcher.js", hash: HASH_A, version: 1 });
    expect(
      readLauncherIdentity({
        WORK_INTELLIGENCE_MCP_LAUNCHER_PATH: "/x/launcher.js",
        WORK_INTELLIGENCE_MCP_LAUNCHER_HASH: HASH_A,
        WORK_INTELLIGENCE_MCP_LAUNCHER_VERSION: "zero",
      }),
    ).toBeUndefined();
  });

  it("does not require reconnecting for a new server build, only for a launcher update", () => {
    const identity = { path: "/x/launcher.js", hash: HASH_A, version: 1 };
    const outdated = { restartRequired: true, updateAvailable: false, monitoringAvailable: true, message: "old" };
    expect(supervisedRestartStatus(outdated, identity, false)).toMatchObject({
      restartRequired: false,
      updateAvailable: false,
      launcher: { version: 1, restartRequired: false },
      message: expect.stringContaining("自動切換"),
    });
    expect(supervisedRestartStatus({ restartRequired: false, monitoringAvailable: true }, identity, false)).toEqual({
      restartRequired: false,
      updateAvailable: false,
      monitoringAvailable: true,
      launcher: { version: 1, restartRequired: false },
    });
    expect(
      supervisedRestartStatus({ restartRequired: false, monitoringAvailable: true }, identity, true),
    ).toMatchObject({ restartRequired: true, launcher: { version: 1, restartRequired: true } });
  });

  it("detects a changed launcher file but not a rewrite with the same content or a missing file", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "launcher.js");
    writeFileSync(path, "launcher v1");
    const check = createLauncherUpdateCheck({ path, hash: HASH_A, version: 1 });
    const real = createLauncherUpdateCheck({
      path,
      hash: createHash("sha256").update("launcher v1").digest("hex"),
      version: 1,
    });
    expect(check()).toBe(true);
    expect(real()).toBe(false);
    writeFileSync(path, "launcher v1");
    expect(real()).toBe(false);
    writeFileSync(path, "launcher v2");
    expect(real()).toBe(true);
    rmSync(path);
    expect(real()).toBe(false);
  });

  it("notices a same-size rewrite that keeps the timestamp, as on coarse Windows clocks", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "launcher.js");
    writeFileSync(path, "launcher v1");
    const { mtime } = statSync(path);
    const check = createLauncherUpdateCheck({
      path,
      hash: createHash("sha256").update("launcher v1").digest("hex"),
      version: 1,
    });
    expect(check()).toBe(false);
    writeFileSync(path, "launcher v9");
    utimesSync(path, mtime, mtime);
    expect(check()).toBe(true);
  });
});
