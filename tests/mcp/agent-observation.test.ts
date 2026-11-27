import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_OBSERVATIONS_FILE,
  AgentObservationRecorder,
  readAgentObservations,
} from "../../apps/mcp/src/agent-observation.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createWorkIntelligenceMcpServer } from "../../apps/mcp/src/server.js";
import { mcpContractFingerprint, SELFTEST_CLIENT_NAME } from "../../packages/shared/src/mcp-contract-fingerprint.js";

const MCP_ENTRY = resolve(__dirname, "../../apps/mcp/dist/index.js");
const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "wi-observation-"));
  directories.push(directory);
  return directory;
}

async function hostSession(
  directory: string,
  clientName: string,
  options: {
    onError?: (error: unknown) => void;
    listTools?: boolean;
    lease?: () => { scopeId: string; directoryWritable: boolean; failure?: "directory_unavailable" | "write_failed" };
  } = {},
): Promise<{ tools: Awaited<ReturnType<Client["listTools"]>>["tools"] }> {
  const server = createWorkIntelligenceMcpServer(null, "1.2.3", 1, { code: "TEST", message: "no database" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const recorder = new AgentObservationRecorder({
    directory,
    serverVersion: "1.2.3",
    onError: options.onError,
    ...(options.lease ? { lease: options.lease } : {}),
  });
  recorder.attach(server, serverTransport);
  const client = new Client({ name: clientName, version: "9.9" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const tools = options.listTools === false ? [] : (await client.listTools()).tools;
  // The write runs just after the response is sent; wait for it to finish instead of for a guessed time.
  await recorder.settled();
  await client.close();
  return { tools };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("AgentObservationRecorder", () => {
  it("records the host, versions and the fingerprint of the tools it received", async () => {
    const directory = temporaryDirectory();

    const { tools } = await hostSession(directory, "claude-code");

    const stored = JSON.parse(readFileSync(join(directory, AGENT_OBSERVATIONS_FILE), "utf8"));
    expect(stored.version).toBe(1);
    expect(stored.observations["claude-code"]).toEqual({
      clientName: "claude-code",
      clientVersion: "9.9",
      protocolVersion: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      contractFingerprint: mcpContractFingerprint(tools),
      serverVersion: "1.2.3",
      observedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(Object.keys(stored.observations["claude-code"]).sort()).toEqual([
      "clientName",
      "clientVersion",
      "contractFingerprint",
      "observedAt",
      "protocolVersion",
      "serverVersion",
    ]);
  });

  it("records this process's lease scope and failure next to the observation, without any path", async () => {
    const directory = temporaryDirectory();
    const lease = { scopeId: "c3".repeat(12), directoryWritable: false, failure: "directory_unavailable" } as const;

    await hostSession(directory, "codex-mcp-client", { lease: () => lease });

    const stored = JSON.parse(readFileSync(join(directory, AGENT_OBSERVATIONS_FILE), "utf8"));
    expect(stored.version).toBe(1);
    expect(stored.observations["codex-mcp-client"].lease).toEqual(lease);
    expect(readFileSync(join(directory, AGENT_OBSERVATIONS_FILE), "utf8")).not.toContain(directory);
  });

  it("keeps one entry per client and merges a second host into the same file", async () => {
    const directory = temporaryDirectory();

    await hostSession(directory, "claude-code");
    await hostSession(directory, "codex-mcp-client");
    await hostSession(directory, "claude-code");

    expect([...(await readAgentObservations(directory)).keys()].sort()).toEqual(["claude-code", "codex-mcp-client"]);
  });

  it("does not record the desktop self-test client", async () => {
    const directory = temporaryDirectory();

    await hostSession(directory, SELFTEST_CLIENT_NAME);

    expect(existsSync(join(directory, AGENT_OBSERVATIONS_FILE))).toBe(false);
  });

  it("records nothing before the host has listed tools", async () => {
    const directory = temporaryDirectory();

    await hostSession(directory, "claude-code", { listTools: false });

    expect(existsSync(join(directory, AGENT_OBSERVATIONS_FILE))).toBe(false);
  });

  it("writes once per process even when the host lists tools again", async () => {
    const directory = temporaryDirectory();
    let writes = 0;
    const server = createWorkIntelligenceMcpServer(null, "1.2.3", 1, { code: "TEST", message: "no database" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const recorder = new AgentObservationRecorder({
      directory,
      serverVersion: "1.2.3",
      now: () => new Date(++writes * 1000),
    });
    recorder.attach(server, serverTransport);
    const client = new Client({ name: "codex-mcp-client", version: "1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await client.listTools();
    await client.listTools();
    await recorder.settled();
    await client.close();

    expect(writes).toBe(1);
  });

  it("fails open when the directory cannot be written and reports to onError only", async () => {
    const directory = temporaryDirectory();
    const blocker = join(directory, "not-a-directory");
    writeFileSync(blocker, "a file where the config directory should be");
    const errors: unknown[] = [];

    const { tools } = await hostSession(join(blocker, "config"), "claude-code", {
      onError: (error) => errors.push(error),
    });

    expect(tools.length).toBeGreaterThan(0);
    expect(errors).toHaveLength(1);
  });

  it("treats a corrupt file as empty and replaces it", async () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, AGENT_OBSERVATIONS_FILE), "{ not json");

    await hostSession(directory, "claude-code");

    expect([...(await readAgentObservations(directory)).keys()]).toEqual(["claude-code"]);
  });

  it("never throws into the transport when inspecting a message fails", async () => {
    const errors: unknown[] = [];
    const server = {
      server: {
        getClientVersion: () => {
          throw new Error("no client");
        },
      },
    } as unknown as McpServer;
    const transport = { send: async () => undefined } as unknown as Transport;
    new AgentObservationRecorder({
      directory: temporaryDirectory(),
      serverVersion: "1",
      onError: (e) => errors.push(e),
    }).attach(server, transport);

    await transport.send({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25" } });
    await expect(transport.send({ jsonrpc: "2.0", id: 2, result: { tools: [] } })).resolves.toBeUndefined();

    expect(errors).toHaveLength(1);
  });

  it("removes its temporary file when the rename fails", async () => {
    const directory = temporaryDirectory();
    mkdirSync(join(directory, AGENT_OBSERVATIONS_FILE));
    const errors: unknown[] = [];

    await hostSession(directory, "claude-code", { onError: (error) => errors.push(error) });

    expect(errors).toHaveLength(1);
    expect(readdirSync(directory)).toEqual([AGENT_OBSERVATIONS_FILE]);
  });

  it("bounds the stored client names and cannot be polluted through a prototype key", async () => {
    const directory = temporaryDirectory();

    await hostSession(directory, "__proto__");
    await hostSession(directory, "x".repeat(500));

    const observations = await readAgentObservations(directory);
    expect([...observations.keys()].every((name) => name.length <= 100)).toBe(true);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });
});

describe("the built MCP process", () => {
  async function runSession(
    clientName: string,
    environment: Record<string, string>,
  ): Promise<{ stdout: string[]; stderr: string }> {
    expect(existsSync(MCP_ENTRY), "run `pnpm --filter @work-intelligence/mcp build` first").toBe(true);
    const child = spawn(process.execPath, [MCP_ENTRY], { env: { ...process.env, ...environment }, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const send = (message: object): void =>
      void child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    send({
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: clientName, version: "1" } },
    });
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/list", params: {} });
    for (let waited = 0; !stdout.includes('"id":2') && waited < 15_000; waited += 25) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    // The write is pending work, so the process ends only after it finished or failed: no fixed delay is needed.
    child.stdin.end();
    await new Promise((resolveExit) => child.once("close", resolveExit));
    return { stdout: stdout.split("\n").filter(Boolean), stderr };
  }

  it("observes a host, keeps stdout protocol-only and stores nothing but the observation", async () => {
    const directory = temporaryDirectory();
    const config = join(directory, "config");

    const { stdout } = await runSession("claude-code", {
      WORK_INTELLIGENCE_DB: join(directory, "data", "work-intelligence.sqlite"),
      WORK_INTELLIGENCE_CONFIG_DIR: config,
    });

    expect(stdout.every((line) => JSON.parse(line).jsonrpc === "2.0")).toBe(true);
    const observation = (await readAgentObservations(config)).get("claude-code");
    expect(observation).toMatchObject({ clientName: "claude-code", clientVersion: "1" });
    const listed = JSON.parse(stdout.find((line) => line.includes('"id":2')) ?? "{}").result.tools;
    expect(observation?.contractFingerprint).toBe(mcpContractFingerprint(listed));
  });

  it("says on stderr that it runs in self-test mode, without a database, and keeps stdout protocol-only", async () => {
    const directory = temporaryDirectory();

    const { stdout, stderr } = await runSession("claude-code", {
      WORK_INTELLIGENCE_MCP_SELFTEST: "1",
      WORK_INTELLIGENCE_DB: join(directory, "data", "work-intelligence.sqlite"),
      WORK_INTELLIGENCE_CONFIG_DIR: join(directory, "config"),
    });

    expect(stderr).toContain("self-test mode");
    expect(stdout.every((line) => JSON.parse(line).jsonrpc === "2.0")).toBe(true);
    expect(existsSync(join(directory, "data"))).toBe(false);
  });

  it("keeps the MCP session working when the observation cannot be written", async () => {
    const directory = temporaryDirectory();
    const blocker = join(directory, "blocker");
    writeFileSync(blocker, "file");

    const { stdout, stderr } = await runSession("claude-code", {
      WORK_INTELLIGENCE_DB: join(directory, "data", "work-intelligence.sqlite"),
      WORK_INTELLIGENCE_CONFIG_DIR: join(blocker, "config"),
    });

    expect(stdout.some((line) => line.includes('"id":2'))).toBe(true);
    expect(stdout.every((line) => JSON.parse(line).jsonrpc === "2.0")).toBe(true);
    expect(stderr).toContain("無法記錄 Agent 連線觀察");
  });
});
