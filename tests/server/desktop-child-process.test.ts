import { existsSync, readdirSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkIntelligenceStore } from "@work-intelligence/storage";
import {
  createInstanceChallenge,
  INSTANCE_CHALLENGE_HEADER,
  INSTANCE_PROOF_HEADER,
  verifyInstanceProof,
} from "../../packages/shared/src/instance-proof.js";
import { probeLoopbackPort } from "../../packages/shared/src/loopback-port.js";
import { BarrierSandbox, freePort, REPOSITORY_ROOT, type Waiter } from "../helpers/old-writer-barrier.js";

// Real child processes running apps/server/src/desktop-child.ts over a real IPC channel, the way the desktop App's
// supervisor drives them. Synthetic databases, free ports, the isolated environment of BarrierSandbox.
const ENTRY = "tests/helpers/desktop-child-entry.ts";
const RUN_ID = "synthetic-run-id-0123456789abcdef-process";
const sandboxes: BarrierSandbox[] = [];
const servers: Server[] = [];

interface Identity {
  realPath: string;
  fileId: { device: string; inode: string } | null;
  lineageId: string | null;
}

function newSandbox(): BarrierSandbox {
  const sandbox = new BarrierSandbox();
  sandboxes.push(sandbox);
  return sandbox;
}

function spawnChild(sandbox: BarrierSandbox): Waiter {
  return sandbox.spawnIpc(join(REPOSITORY_ROOT, ENTRY));
}

async function preflight(child: Waiter, path: string): Promise<{ status: string; identity?: Identity }> {
  child.send({ type: "preflight", path });
  return child.waitFor<{ type: string; status: string; identity?: Identity }>("preflight-result");
}

async function startReady(sandbox: BarrierSandbox, child: Waiter, runId = RUN_ID) {
  new WorkIntelligenceStore(sandbox.databasePath).close();
  await child.waitFor("hello");
  const verified = await preflight(child, sandbox.databasePath);
  const port = await freePort();
  child.send({ type: "start", runId, port, database: { path: sandbox.databasePath, identity: verified.identity } });
  const ready = await child.waitFor<{ type: string } & Record<string, unknown>>("ready");
  return { port, ready, identity: verified.identity };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  await Promise.all(sandboxes.splice(0).map((sandbox) => sandbox.stopAll()));
});

describe("desktop child over IPC (real process)", () => {
  it("says hello with its pid and executable before anything else", async () => {
    const sandbox = newSandbox();
    const child = spawnChild(sandbox);

    const hello = await child.waitFor<{ type: string } & Record<string, unknown>>("hello");
    expect(hello).toEqual({ type: "hello", protocolVersion: 1, pid: child.child.pid, execPath: process.execPath });
  });

  it("preflights read-only, starts, proves its identity over HTTP and stops cleanly on shutdown", async () => {
    const sandbox = newSandbox();
    const child = spawnChild(sandbox);
    const { port, ready, identity } = await startReady(sandbox, child);

    expect(ready).toMatchObject({
      type: "ready",
      protocolVersion: 1,
      runId: RUN_ID,
      port,
      pid: child.child.pid,
      execPath: process.execPath,
    });
    expect((ready.databaseIdentity as Identity).realPath).toBe(realpathSync.native(sandbox.databasePath));
    expect((ready.databaseIdentity as Identity).fileId).toEqual(identity?.fileId);
    expect(await probeLoopbackPort(port)).toMatchObject({ free: false });

    const challenge = createInstanceChallenge();
    const proven = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { [INSTANCE_CHALLENGE_HEADER]: challenge },
    });
    expect(proven.status).toBe(200);
    expect(verifyInstanceProof(RUN_ID, challenge, proven.headers.get(INSTANCE_PROOF_HEADER))).toBe(true);
    expect(
      verifyInstanceProof("another-run-id-0123456789abcdef-x", challenge, proven.headers.get(INSTANCE_PROOF_HEADER)),
    ).toBe(false);
    const body = JSON.stringify(await proven.json());
    expect(body).not.toContain(RUN_ID);

    child.send({ type: "shutdown" });
    await child.waitFor("stopped");
    expect(await child.exited).toBe(0);
    expect(await probeLoopbackPort(port)).toEqual({ free: true });
  });

  it("answers health without a proof, and without the run id, when no valid challenge is sent", async () => {
    const sandbox = newSandbox();
    const child = spawnChild(sandbox);
    const { port } = await startReady(sandbox, child);

    for (const headers of [{} as Record<string, string>, { [INSTANCE_CHALLENGE_HEADER]: "not a valid challenge!" }]) {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { headers });
      expect(response.status).toBe(200);
      expect(response.headers.get(INSTANCE_PROOF_HEADER)).toBeNull();
      expect(JSON.stringify(await response.json())).not.toContain(RUN_ID);
    }
    const tooLong = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { [INSTANCE_CHALLENGE_HEADER]: "a".repeat(200) },
    });
    expect(tooLong.headers.get(INSTANCE_PROOF_HEADER)).toBeNull();
  });

  it("ends itself gracefully and frees the port when the parent disappears", async () => {
    const sandbox = newSandbox();
    const child = spawnChild(sandbox);
    const { port } = await startReady(sandbox, child);

    child.child.disconnect();

    expect(await child.exited).toBe(0);
    expect(await probeLoopbackPort(port)).toEqual({ free: true });
  });

  it.skipIf(process.platform === "win32")("shuts down gracefully on SIGTERM too", async () => {
    const sandbox = newSandbox();
    const child = spawnChild(sandbox);
    const { port } = await startReady(sandbox, child);

    child.child.kill("SIGTERM");

    expect(await child.exited).toBe(0);
    expect(await probeLoopbackPort(port)).toEqual({ free: true });
  });

  it("reports DB_MISSING and creates no file for a database that does not exist, ignoring the environment's default", async () => {
    const sandbox = newSandbox();
    const child = spawnChild(sandbox);
    await child.waitFor("hello");
    const missing = join(sandbox.root, "does-not-exist.sqlite");
    const answer = await preflight(child, missing);
    expect(answer.status).toBe("missing");

    const port = await freePort();
    child.send({
      type: "start",
      runId: RUN_ID,
      port,
      database: { path: missing, identity: { realPath: missing, fileId: null, lineageId: null } },
    });
    const failed = await child.waitFor<{ type: string; code: string }>("failed");

    expect(failed.code).toBe("DB_MISSING");
    expect(await child.exited).toBe(1);
    expect(existsSync(missing)).toBe(false);
    // WORK_INTELLIGENCE_DB in the child's environment points at the sandbox database; it must not be created either.
    expect(existsSync(sandbox.databasePath)).toBe(false);
    expect(readdirSync(sandbox.root).filter((name) => name.endsWith(".sqlite"))).toEqual([]);
    expect(await probeLoopbackPort(port)).toEqual({ free: true });
  });

  it("reports PORT_OCCUPIED_BY_OTHER before it opens the database when someone else holds the port", async () => {
    const sandbox = newSandbox();
    new WorkIntelligenceStore(sandbox.databasePath).close();
    const child = spawnChild(sandbox);
    await child.waitFor("hello");
    const verified = await preflight(child, sandbox.databasePath);
    const holder = createServer();
    servers.push(holder);
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    const address = holder.address();
    if (!address || typeof address === "string") throw new Error("no port");

    child.send({
      type: "start",
      runId: RUN_ID,
      port: address.port,
      database: { path: sandbox.databasePath, identity: verified.identity },
    });
    const failed = await child.waitFor<{ type: string; code: string; detail: string }>("failed");

    expect(failed).toMatchObject({ code: "PORT_OCCUPIED_BY_OTHER", detail: "listen failed (EADDRINUSE)" });
    expect(await child.exited).toBe(1);
    // startApi (which opens the store, and may migrate) was never reached: its own listen-error message is absent.
    expect(child.stderr()).not.toContain("已被占用");
    expect(child.stderr()).not.toContain("SQLite database:");
  });

  it("reports DB_IDENTITY_CHANGED when the file is not the one that was verified", async () => {
    const sandbox = newSandbox();
    new WorkIntelligenceStore(sandbox.databasePath).close();
    const child = spawnChild(sandbox);
    await child.waitFor("hello");
    const verified = await preflight(child, sandbox.databasePath);
    const swapped = { ...verified.identity, fileId: { device: "1", inode: "2" } };

    child.send({
      type: "start",
      runId: RUN_ID,
      port: await freePort(),
      database: { path: sandbox.databasePath, identity: swapped },
    });

    expect((await child.waitFor<{ type: string; code: string }>("failed")).code).toBe("DB_IDENTITY_CHANGED");
    expect(await child.exited).toBe(1);
  });

  it("accepts only one start and drops malformed messages without dying", async () => {
    const sandbox = newSandbox();
    const child = spawnChild(sandbox);
    new WorkIntelligenceStore(sandbox.databasePath).close();
    await child.waitFor("hello");
    child.send({ type: "format-the-disk" });
    child.send({ type: "start", runId: "short", port: 1 });
    const verified = await preflight(child, sandbox.databasePath);
    const port = await freePort();
    const message = {
      type: "start",
      runId: RUN_ID,
      port,
      database: { path: sandbox.databasePath, identity: verified.identity },
    };

    child.send(message);
    await child.waitFor("ready");
    const secondPort = await freePort();
    child.send({ ...message, port: secondPort });
    child.send({ type: "preflight", path: sandbox.databasePath });
    // The second start and the late preflight are dropped; the child is still serving and nothing listens on the second port.
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(health.status).toBe(200);
    expect(await probeLoopbackPort(secondPort)).toEqual({ free: true });

    child.send({ type: "shutdown" });
    await child.waitFor("stopped");
    expect(await child.exited).toBe(0);
    expect(child.stderr()).toContain("dropped a message");
    expect(child.stderr()).toContain("dropped a second start request");
  });

  it("stops without having started when asked to shut down first", async () => {
    const sandbox = newSandbox();
    const child = spawnChild(sandbox);
    await child.waitFor("hello");

    child.send({ type: "shutdown" });

    await child.waitFor("stopped");
    expect(await child.exited).toBe(0);
  });

  it("refuses to run without an IPC channel and says so", async () => {
    const sandbox = newSandbox();
    const entry = sandbox.spawnEntry(ENTRY);

    expect(await entry.exited).toBe(2);
    expect(entry.stderr()).toContain("桌面 App");
  });
});
