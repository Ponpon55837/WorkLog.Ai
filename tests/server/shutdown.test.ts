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
  // Real sockets and a disk database: Windows CI runners can exceed the default 5-second timeout.
  it.each(["SIGINT", "SIGTERM"] as const)(
    "drains active writes and closes SSE on %s",
    { timeout: 20_000 },
    async (signal) => {
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
      let releaseBackgroundWork!: () => void;
      const backgroundWorkGate = new Promise<void>((resolve) => {
        releaseBackgroundWork = resolve;
      });
      let backgroundWorkCloseStarted!: () => void;
      const backgroundWorkStarted = new Promise<void>((resolve) => {
        backgroundWorkCloseStarted = resolve;
      });
      const closeBackgroundWork = vi.fn(() => {
        backgroundWorkCloseStarted();
        return backgroundWorkGate;
      });
      let databaseClosed = false;
      let databaseCloseCompleted!: () => void;
      const databaseCloseComplete = new Promise<void>((resolve) => {
        databaseCloseCompleted = resolve;
      });
      const closeDatabase = vi.fn(() => {
        store.close();
        databaseClosed = true;
        databaseCloseCompleted();
      });
      const onBackgroundWorkCloseError = vi.fn();
      const onDatabaseCloseError = vi.fn();
      const shutdown = registerGracefulShutdown(
        {
          server,
          stopBackgroundWork,
          closeEventStreams,
          closeBackgroundWork,
          closeDatabase,
          onBackgroundWorkCloseError,
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
        await backgroundWorkStarted;
        expect(closeBackgroundWork).toHaveBeenCalledTimes(1);
        expect(closeDatabase).not.toHaveBeenCalled();
        releaseBackgroundWork();
        await databaseCloseComplete;
        await shutdown();
        expect(closeDatabase).toHaveBeenCalledTimes(1);
        expect(databaseClosed).toBe(true);
        expect(onBackgroundWorkCloseError).not.toHaveBeenCalled();
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
        releaseBackgroundWork();
        if (!databaseClosed) {
          await serverClosed;
          await databaseCloseComplete;
        }
      }
    },
  );
});

describe("awaitable graceful shutdown", () => {
  it("resolves after the database closed and runs the steps once for repeated callers", async () => {
    const order: string[] = [];
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const shutdown = registerGracefulShutdown(
      {
        server,
        stopBackgroundWork: () => order.push("stop"),
        closeEventStreams: () => order.push("streams"),
        closeBackgroundWork: async () => {
          order.push("background");
        },
        closeDatabase: () => order.push("database"),
        onBackgroundWorkCloseError: () => undefined,
        onDatabaseCloseError: () => undefined,
      },
      new EventEmitter() as ShutdownSignalSource,
    );

    await Promise.all([shutdown(), shutdown()]);
    await shutdown();

    expect(order).toEqual(["stop", "streams", "background", "database"]);
  });
});

describe("shutdown steps that throw", () => {
  async function register(overrides: Partial<Parameters<typeof registerGracefulShutdown>[0]> = {}) {
    const order: string[] = [];
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const signals = new EventEmitter();
    const stepErrors: string[] = [];
    const shutdown = registerGracefulShutdown(
      {
        server,
        stopBackgroundWork: () => order.push("stop"),
        closeEventStreams: () => order.push("streams"),
        closeBackgroundWork: async () => {
          order.push("background");
        },
        closeDatabase: () => order.push("database"),
        onBackgroundWorkCloseError: () => undefined,
        onDatabaseCloseError: () => undefined,
        onStepError: (step) => stepErrors.push(step),
        ...overrides,
      },
      signals as ShutdownSignalSource,
    );
    return { order, server, signals, shutdown, stepErrors };
  }

  it("still closes the server and the database when stopBackgroundWork throws", async () => {
    const { order, server, shutdown, stepErrors } = await register({
      stopBackgroundWork: () => {
        throw new Error("timer broke");
      },
    });

    await expect(shutdown()).resolves.toBeUndefined();

    expect(stepErrors).toEqual(["stopBackgroundWork"]);
    expect(order).toEqual(["streams", "background", "database"]);
    expect(server.listening).toBe(false);
  });

  it("still closes the server and the database when closeEventStreams throws", async () => {
    const { order, server, shutdown, stepErrors } = await register({
      closeEventStreams: () => {
        throw new Error("stream broke");
      },
    });

    await expect(shutdown()).resolves.toBeUndefined();

    expect(stepErrors).toEqual(["closeEventStreams"]);
    expect(order).toEqual(["stop", "background", "database"]);
    expect(server.listening).toBe(false);
  });

  it("continues when both throw and when server.close itself throws, and resolves every caller", async () => {
    const throwing = (): never => {
      throw new Error("broke");
    };
    const { order, server, shutdown, stepErrors } = await register({
      stopBackgroundWork: throwing,
      closeEventStreams: throwing,
    });
    server.close = throwing;

    await Promise.all([shutdown(), shutdown()]);

    expect(stepErrors).toEqual(["stopBackgroundWork", "closeEventStreams", "closeServer"]);
    expect(order).toEqual(["background", "database"]);
  });

  it("produces no unhandled rejection from a signal even when every step throws", async () => {
    const throwing = (): never => {
      throw new Error("broke");
    };
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const { order, signals } = await register({ stopBackgroundWork: throwing, closeEventStreams: throwing });

    signals.emit("SIGTERM");
    await vi.waitFor(() => expect(order).toContain("database"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.off("unhandledRejection", unhandled);

    expect(unhandled).not.toHaveBeenCalled();
  });
});
