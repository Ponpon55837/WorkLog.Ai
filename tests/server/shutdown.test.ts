import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkIntelligenceStore } from "../../packages/storage/src/index.js";
import { createApiHandler } from "../../apps/server/src/server.js";
import { registerGracefulShutdown, type ShutdownSignalSource } from "../../apps/server/src/shutdown.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function readSseUntil(reader: ReadableStreamDefaultReader<Uint8Array>, marker: string): Promise<void> {
  const decoder = new TextDecoder();
  let output = "";
  while (!output.includes(marker)) {
    const { done, value } = await reader.read();
    if (done) {
      throw new Error("The SSE stream closed before the connected marker arrived.");
    }
    output += decoder.decode(value, { stream: true });
  }
}

describe("graceful API shutdown", () => {
  it.each(["SIGINT", "SIGTERM"] as const)("drains active writes and closes SSE on %s", async (signal) => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-shutdown-test-"));
    roots.push(root);
    const databasePath = join(root, "work-intelligence.sqlite");
    const store = new WorkIntelligenceStore(databasePath);
    const project = store.addProject("Shutdown test project", root);
    store.updateProject(project.id, { status: "tracked" });
    const apiHandler = createApiHandler(store);
    const server = createServer(apiHandler);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("The shutdown test server did not expose a TCP address.");
    }
    const signalSource = new EventEmitter();
    const stopBackgroundWork = vi.fn();
    const closeEventStreams = vi.fn(() => apiHandler.closeEventStreams());
    let databaseClosed = false;
    const closeDatabase = vi.fn(() => {
      store.close();
      databaseClosed = true;
    });
    const onDatabaseCloseError = vi.fn();
    const shutdown = registerGracefulShutdown(
      {
        server,
        stopBackgroundWork,
        closeEventStreams,
        closeDatabase,
        onDatabaseCloseError,
      },
      signalSource as ShutdownSignalSource,
    );
    const serverClosed = new Promise<void>((resolve) => server.once("close", resolve));

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let request: ReturnType<typeof httpRequest> | undefined;
    let responsePromise: Promise<{ status: number; body: string }> | undefined;

    try {
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const streamResponse = await fetch(`${baseUrl}/api/events`);
      reader = streamResponse.body?.getReader();
      if (!reader) {
        throw new Error("The SSE response did not expose a readable stream.");
      }
      await readSseUntil(reader, ": connected");

      const payload = JSON.stringify({
        projectRoot: root,
        idempotencyKey: `shutdown-${signal}`,
        title: "Write completed during shutdown",
        summary: "The in-flight request should commit before SQLite closes.",
        workSummary: {
          outcomes: ["A complete record was written."],
          scope: [],
          decisions: [],
          verification: [],
          nextSteps: [],
        },
        changedFiles: ["src/complete.ts"],
        verification: { status: "passed" },
      });
      responsePromise = new Promise((resolve, reject) => {
        request = httpRequest(
          {
            host: "127.0.0.1",
            port: address.port,
            path: "/api/work/finalize",
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": String(Buffer.byteLength(payload)),
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.once("end", () => {
              resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
            });
          },
        );
        request.once("error", reject);
      });

      const splitAt = Math.floor(payload.length / 2);
      await new Promise<void>((resolve, reject) => {
        request?.write(payload.slice(0, splitAt), (error) => (error ? reject(error) : resolve()));
      });
      await new Promise((resolve) => setTimeout(resolve, 40));

      const streamEnd = reader.read();
      signalSource.emit(signal);
      signalSource.emit(signal === "SIGINT" ? "SIGTERM" : "SIGINT");
      expect(stopBackgroundWork).toHaveBeenCalledTimes(1);
      expect(closeEventStreams).toHaveBeenCalledTimes(1);
      expect(closeDatabase).not.toHaveBeenCalled();
      expect((await streamEnd).done).toBe(true);

      request?.end(payload.slice(splitAt));
      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({
        outcome: "finalized",
        session: { title: "Write completed during shutdown" },
      });

      await serverClosed;
      expect(closeDatabase).toHaveBeenCalledTimes(1);
      expect(databaseClosed).toBe(true);
      expect(onDatabaseCloseError).not.toHaveBeenCalled();
      expect(existsSync(`${databasePath}-wal`)).toBe(false);

      const database = new DatabaseSync(databasePath);
      try {
        const session = database
          .prepare("SELECT title, changed_files_json FROM sessions WHERE idempotency_key = ?")
          .get(`shutdown-${signal}`) as { title?: string; changed_files_json?: string } | undefined;
        expect(session).toEqual({
          title: "Write completed during shutdown",
          changed_files_json: '["src/complete.ts"]',
        });
        expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } finally {
        database.close();
      }
    } finally {
      if (request && !request.writableEnded && !request.destroyed) {
        request.destroy();
      }
      if (!closeEventStreams.mock.calls.length) {
        shutdown();
      }
      if (reader) {
        await reader.cancel().catch(() => undefined);
      }
      if (!databaseClosed) {
        await serverClosed;
      }
    }
  });
});
