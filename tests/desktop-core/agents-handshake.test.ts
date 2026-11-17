import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { planMcpSpawn, probeMcpHandshake } from "../../packages/desktop-core/src/agents/index.js";

const MCP_ENTRY = resolve(__dirname, "../../apps/mcp/dist/index.js");
const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "wi-handshake-"));
  directories.push(directory);
  return directory;
}

/** Runs `code` as a Node script, the stand-in for an MCP server that misbehaves in one specific way. */
function fakeServer(code: string): { command: string; args: string[] } {
  return { command: process.execPath, args: ["-e", code] };
}

const INITIALIZE_REPLY = `
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-11-25", serverInfo: { name: "fake", version: "9" }, capabilities: {} } }) + "\\n");
  }
`;

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("probeMcpHandshake against the built Work Intelligence MCP server", () => {
  function realServer(directory: string, databasePath: string) {
    expect(existsSync(MCP_ENTRY), "run `pnpm --filter @work-intelligence/mcp build` first").toBe(true);
    return {
      command: process.execPath,
      args: [MCP_ENTRY],
      env: { WORK_INTELLIGENCE_DB: databasePath, WORK_INTELLIGENCE_CONFIG_DIR: join(directory, "config") },
      timeoutMs: 20_000,
    };
  }

  it("lists the tools and reports a stable contract fingerprint", async () => {
    const directory = temporaryDirectory();
    const request = realServer(directory, join(directory, "data.sqlite"));
    const first = await probeMcpHandshake(request);
    const second = await probeMcpHandshake(request);

    expect(first).toMatchObject({ ok: true, serverInfo: { name: "work-intelligence" } });
    if (!first.ok || !second.ok) return;
    expect(first.toolNames.length).toBeGreaterThan(0);
    expect(first.toolNames).toContain("work_read");
    expect(first.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(first.contractFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(second.contractFingerprint).toBe(first.contractFingerprint);
    expect(first.elapsedMs).toBeGreaterThan(0);
  });

  it("neither opens nor changes the user's database and writes no runtime state", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "data.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec(
      "PRAGMA user_version = 7; CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('synthetic');",
    );
    database.close();
    const before = readFileSync(databasePath);
    const modifiedBefore = statSync(databasePath).mtimeMs;
    const filesBefore = readdirSync(directory).sort();

    const result = await probeMcpHandshake(realServer(directory, databasePath));

    expect(result.ok).toBe(true);
    expect(createHash("sha256").update(readFileSync(databasePath)).digest("hex")).toBe(
      createHash("sha256").update(before).digest("hex"),
    );
    expect(statSync(databasePath).mtimeMs).toBe(modifiedBefore);
    expect(readdirSync(directory).sort()).toEqual(filesBefore);
    const reopened = new DatabaseSync(databasePath, { readOnly: true });
    expect(reopened.prepare("PRAGMA user_version").get()).toEqual({ user_version: 7 });
    reopened.close();
  });

  it("creates no database when none exists", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "missing", "data.sqlite");

    expect((await probeMcpHandshake(realServer(directory, databasePath))).ok).toBe(true);
    expect(existsSync(join(directory, "missing"))).toBe(false);
    expect(existsSync(join(directory, "config"))).toBe(false);
  });
});

describe("probeMcpHandshake failure modes", () => {
  it("answers HANDSHAKE_TIMEOUT for a server that never answers, and kills it", async () => {
    const directory = temporaryDirectory();
    const pidFile = join(directory, "pid");
    const server = fakeServer(
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
    );

    const result = await probeMcpHandshake({ ...server, timeoutMs: 400 });

    expect(result).toMatchObject({ ok: false, code: "HANDSHAKE_TIMEOUT" });
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("answers HANDSHAKE_EXITED with the stderr tail when the server exits first", async () => {
    const server = fakeServer(`console.error("boom: missing dependency"); process.exit(3);`);

    const result = await probeMcpHandshake({ ...server, timeoutMs: 5_000 });

    expect(result).toMatchObject({ ok: false, code: "HANDSHAKE_EXITED" });
    if (result.ok) return;
    expect(result.message).toContain("exit code 3");
    expect(result.stderrTail).toContain("boom: missing dependency");
  });

  it("answers HANDSHAKE_PROTOCOL_ERROR for garbage on stdout", async () => {
    const server = fakeServer(`process.stdout.write("Welcome to my server\\n"); setInterval(() => {}, 1000);`);

    expect(await probeMcpHandshake({ ...server, timeoutMs: 5_000 })).toMatchObject({
      ok: false,
      code: "HANDSHAKE_PROTOCOL_ERROR",
    });
  });

  it("answers HANDSHAKE_PROTOCOL_ERROR for an initialize without serverInfo", async () => {
    const server = fakeServer(`
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }) + "\\n");
});`);

    expect(await probeMcpHandshake({ ...server, timeoutMs: 5_000 })).toMatchObject({
      ok: false,
      code: "HANDSHAKE_PROTOCOL_ERROR",
    });
  });

  it("answers HANDSHAKE_PROTOCOL_ERROR when the server answers initialize with an error", async () => {
    const server = fakeServer(`
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "no" } }) + "\\n");
});`);

    expect(await probeMcpHandshake({ ...server, timeoutMs: 5_000 })).toMatchObject({
      ok: false,
      code: "HANDSHAKE_PROTOCOL_ERROR",
    });
  });

  it("answers HANDSHAKE_SPAWN_FAILED for a command that does not exist", async () => {
    const result = await probeMcpHandshake({
      command: join(temporaryDirectory(), "no-such-server"),
      args: [],
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({ ok: false, code: "HANDSHAKE_SPAWN_FAILED" });
  });

  it("follows tools/list pages and sees every tool", async () => {
    const server = fakeServer(`${INITIALIZE_REPLY}
  if (message.method === "tools/list") {
    const second = message.params && message.params.cursor === "p2";
    const tools = second ? [{ name: "b", inputSchema: {} }] : [{ name: "a", inputSchema: {} }];
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: second ? { tools } : { tools, nextCursor: "p2" } }) + "\\n");
  }
});`);

    const result = await probeMcpHandshake({ ...server, timeoutMs: 5_000 });

    expect(result).toMatchObject({ ok: true, toolNames: ["a", "b"], serverInfo: { name: "fake", version: "9" } });
  });

  /** Runs a fake server that records its pid, answers initialize, and then runs `afterInitialize`. */
  async function probeMisbehavingServer(afterInitialize: string): Promise<{ result: unknown; pid: number }> {
    const pidFile = join(temporaryDirectory(), "pid");
    const server = fakeServer(`require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
${INITIALIZE_REPLY}
  if (message.method === "tools/list") {
    ${afterInitialize}
  }
});
setInterval(() => {}, 1000);`);
    const result = await probeMcpHandshake({ ...server, timeoutMs: 10_000 });
    return { result, pid: Number(readFileSync(pidFile, "utf8")) };
  }

  it("answers HANDSHAKE_PROTOCOL_ERROR for a tools/list result without named tools, and kills the server", async () => {
    const { result, pid } = await probeMisbehavingServer(
      `process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ description: "no name" }] } }) + "\\n");`,
    );

    expect(result).toMatchObject({ ok: false, code: "HANDSHAKE_PROTOCOL_ERROR" });
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("answers HANDSHAKE_PROTOCOL_ERROR when tools/list keeps returning pages, and kills the server", async () => {
    const { result, pid } = await probeMisbehavingServer(
      `process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "t" + message.id }], nextCursor: "again" } }) + "\\n");`,
    );

    expect(result).toMatchObject({
      ok: false,
      code: "HANDSHAKE_PROTOCOL_ERROR",
      message: expect.stringContaining("pages"),
    });
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it.each([
    ["an array", "[1]"],
    ["a number", "42"],
    ["null", "null"],
  ])(
    "answers HANDSHAKE_PROTOCOL_ERROR when stdout carries a JSON value that is not a message (%s)",
    async (_label, value) => {
      const { result, pid } = await probeMisbehavingServer(`process.stdout.write(${JSON.stringify(value)} + "\\n");`);

      expect(result).toMatchObject({ ok: false, code: "HANDSHAKE_PROTOCOL_ERROR" });
      expect(() => process.kill(pid, 0)).toThrow();
    },
  );

  it("answers HANDSHAKE_PROTOCOL_ERROR for a line that never ends, and kills the server", async () => {
    const { result, pid } = await probeMisbehavingServer(`process.stdout.write("x".repeat(5 * 1024 * 1024));`);

    expect(result).toMatchObject({
      ok: false,
      code: "HANDSHAKE_PROTOCOL_ERROR",
      message: expect.stringContaining("long line"),
    });
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("never throws for a working directory that does not exist", async () => {
    const result = await probeMcpHandshake({
      command: process.execPath,
      args: ["-e", ""],
      cwd: join(temporaryDirectory(), "gone"),
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(false);
  });

  it("passes cwd and env to the server", async () => {
    const directory = temporaryDirectory();
    mkdirSync(join(directory, "work"));
    writeFileSync(join(directory, "probe.cjs"), "");
    const server = fakeServer(`${INITIALIZE_REPLY}
  if (message.method === "tools/list") {
    const name = process.cwd().split(/[\\\\/]/).pop() + ":" + process.env.WI_PROBE;
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name, inputSchema: {} }] } }) + "\\n");
  }
});`);

    const result = await probeMcpHandshake({
      ...server,
      cwd: join(directory, "work"),
      env: { WI_PROBE: "yes" },
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({ ok: true, toolNames: ["work:yes"] });
  });
});

describe("planMcpSpawn", () => {
  const environment = { SystemRoot: "C:\\Windows" };

  it("starts an ordinary command directly from its argv array", () => {
    expect(planMcpSpawn("/usr/bin/node", ["a b", "c"], "linux")).toEqual({
      file: "/usr/bin/node",
      args: ["a b", "c"],
      windowsVerbatimArguments: false,
    });
    expect(planMcpSpawn("C:\\Program Files\\nodejs\\node.exe", ["x"], "win32", environment)).toEqual({
      file: "C:\\Program Files\\nodejs\\node.exe",
      args: ["x"],
      windowsVerbatimArguments: false,
    });
  });

  it("runs a Windows .cmd shim through System32 cmd.exe with each element quoted", () => {
    const plan = planMcpSpawn(
      "C:\\Users\\a b\\.work-intelligence\\bin\\work-intelligence-launcher.cmd",
      ["mcp", "C:\\data dir\\x"],
      "win32",
      environment,
    );

    expect(plan).toEqual({
      file: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        '""C:\\Users\\a b\\.work-intelligence\\bin\\work-intelligence-launcher.cmd" "mcp" "C:\\data dir\\x""',
      ],
      windowsVerbatimArguments: true,
    });
  });

  it("treats .BAT in any case as a batch file and ignores ComSpec", () => {
    const plan = planMcpSpawn("C:\\tools\\run.BAT", [], "win32", {
      SystemRoot: "D:\\Win",
      ComSpec: "C:\\evil\\cmd.exe",
    });

    expect(plan.file).toBe("D:\\Win\\System32\\cmd.exe");
  });

  it.each(['a"b', "100%", "a\nb"])(
    "refuses a batch argument that cmd.exe cannot pass safely (%j)",
    async (argument) => {
      expect(() => planMcpSpawn("C:\\x.cmd", [argument], "win32", environment)).toThrow();
      const result = await probeMcpHandshake(
        { command: "C:\\x.cmd", args: [argument], timeoutMs: 1_000 },
        {
          platform: "win32",
          environment,
          spawn: () => {
            throw new Error("must not spawn");
          },
        },
      );
      expect(result).toMatchObject({ ok: false, code: "HANDSHAKE_SPAWN_FAILED" });
    },
  );

  it("leaves a .cmd name alone on POSIX", () => {
    expect(planMcpSpawn("/opt/x.cmd", ["a"], "darwin").windowsVerbatimArguments).toBe(false);
  });
});

describe("probeMcpHandshake on Windows (injected spawn)", () => {
  const environment = { SystemRoot: "C:\\Windows" };

  /** A child that never answers; `exited` makes it look as if it already ended. */
  function silentChild(options: { exited?: boolean } = {}): ChildProcess {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    child.pid = 4321;
    child.exitCode = options.exited ? 1 : null;
    child.signalCode = null;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      child.killed = true;
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      return true;
    };
    return child as unknown as ChildProcess;
  }

  /** Runs a probe that times out; `taskkillExit` is what the injected taskkill exits with (undefined: it fails to start). */
  async function timeOut(options: { exited?: boolean; taskkillExit?: number }) {
    const child = silentChild({ exited: options.exited });
    const spawned: Array<{ file: string; args: readonly string[] }> = [];
    await probeMcpHandshake(
      { command: "C:\\runtime\\bin\\work-intelligence-launcher.cmd", args: ["mcp"], timeoutMs: 30 },
      {
        platform: "win32",
        environment,
        spawn: (file, args) => {
          spawned.push({ file, args });
          if (spawned.length === 1) {
            if (options.exited) queueMicrotask(() => child.emit("close", 1, null));
            return child;
          }
          const killer = new EventEmitter();
          queueMicrotask(() => {
            if (options.taskkillExit === undefined) killer.emit("error", new Error("spawn taskkill ENOENT"));
            else killer.emit("exit", options.taskkillExit);
            // The launcher tree is gone once taskkill succeeded.
            if (options.taskkillExit === 0) child.emit("close", 1, null);
          });
          return killer as unknown as ChildProcess;
        },
      },
    );
    return { child: child as unknown as { killed?: boolean }, spawned };
  }

  it("kills the whole tree with System32 taskkill /T /F, not only the cmd.exe wrapper", async () => {
    const { child, spawned } = await timeOut({ taskkillExit: 0 });

    expect(spawned[1]).toEqual({
      file: "C:\\Windows\\System32\\taskkill.exe",
      args: ["/PID", "4321", "/T", "/F"],
    });
    expect(child.killed).toBeUndefined();
  });

  it.each([
    ["taskkill exits non-zero", { taskkillExit: 128 }],
    ["taskkill cannot start", {}],
  ])("falls back to killing the child when %s", async (_name, options) => {
    const { child } = await timeOut(options);

    expect(child.killed).toBe(true);
  });

  it("does not run taskkill for a child that already exited (its pid may be reused)", async () => {
    const { child, spawned } = await timeOut({ exited: true });

    expect(spawned).toHaveLength(1);
    expect(child.killed).toBeUndefined();
  });
});

describe("probeMcpHandshake when the server closes its stdin early (injected spawn)", () => {
  it("ignores the stdin error, still reads the answers and ends the tree", async () => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    child.pid = 4321;
    child.exitCode = null;
    child.signalCode = null;
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = new PassThrough();
    child.kill = () => {
      child.killed = true;
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      return true;
    };
    const reply = (id: number, result: unknown): void => {
      stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
    };
    stdin.on("data", (chunk: Buffer) => {
      const message = JSON.parse(chunk.toString("utf8").split("\n")[0] as string) as { id?: number; method: string };
      // Writing to a pipe whose reader is gone reports EPIPE on the stream, never as a thrown exception.
      stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      if (message.method === "initialize") {
        reply(message.id as number, { protocolVersion: "2025-11-25", serverInfo: { name: "fake", version: "1" } });
      } else if (message.method === "tools/list") reply(message.id as number, { tools: [{ name: "only" }] });
    });
    const spawned: string[] = [];

    const result = await probeMcpHandshake(
      { command: "C:\\runtime\\server.exe", args: [], timeoutMs: 5_000 },
      {
        platform: "win32",
        environment: { SystemRoot: "C:\\Windows" },
        spawn: (file) => {
          spawned.push(file);
          if (spawned.length === 1) return child as unknown as ChildProcess;
          const killer = new EventEmitter();
          queueMicrotask(() => {
            killer.emit("exit", 0);
            child.emit("close", 1, null);
          });
          return killer as unknown as ChildProcess;
        },
      },
    );

    expect(result).toMatchObject({ ok: true, toolNames: ["only"] });
    expect(spawned[1]).toBe("C:\\Windows\\System32\\taskkill.exe");
  });
});

describe("probeMcpHandshake stderr masking", () => {
  it("masks the config directory and the given runtime root, not only the home directory", async () => {
    const directory = temporaryDirectory();
    const config = join(directory, "config-dir-secret");
    const runtime = join(directory, "runtime-root-secret");
    const server = fakeServer(
      `console.error("config " + process.env.WORK_INTELLIGENCE_CONFIG_DIR + "/x"); console.error("runtime " + ${JSON.stringify(runtime)}); process.exit(3);`,
    );

    const result = await probeMcpHandshake({
      ...server,
      env: { WORK_INTELLIGENCE_CONFIG_DIR: config },
      maskedPaths: [runtime],
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stderrTail.join("\n")).not.toContain("secret");
    expect(result.stderrTail).toHaveLength(2);
  });
});
