import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LATEST_SCHEMA_VERSION, type WorkIntelligenceStore } from "@work-intelligence/storage";
import { restoredError, type SerializedWorkerError } from "./worker-errors.js";

type ReadOperationName = "getReport" | "getGraph" | "getHotspots";
type StoreInput<K extends ReadOperationName> = Parameters<WorkIntelligenceStore[K]>[0];
type StoreOutput<K extends ReadOperationName> = ReturnType<WorkIntelligenceStore[K]>;

/** The only reads the worker accepts. Everything else stays on the API thread. */
export type ReadWorkerOperation =
  | { type: "getReport"; input: StoreInput<"getReport"> }
  | { type: "getGraph"; input: StoreInput<"getGraph"> }
  | { type: "getHotspots"; input: StoreInput<"getHotspots"> };

export interface ReadWorkerRequest {
  id: number;
  operation: ReadWorkerOperation;
}

export interface ReadWorkerCloseRequest {
  close: true;
  id: number;
}

export type ReadWorkerReply =
  { id: number; ok: true; value: unknown } | { id: number; ok: false; error: SerializedWorkerError };

/** Heavy read-only store operations, served from a worker (production) or the API thread (`:memory:`). */
export interface HeavyReadOperations {
  getReport(input: StoreInput<"getReport">): Promise<StoreOutput<"getReport">>;
  getGraph(input: StoreInput<"getGraph">): Promise<StoreOutput<"getGraph">>;
  getHotspots(input: StoreInput<"getHotspots">): Promise<StoreOutput<"getHotspots">>;
  close(): Promise<void>;
}

export interface ReadWorkerClientOptions {
  idleTimeoutMs?: number;
}

interface PendingRequest {
  lifetime: WorkerLifetime;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

interface WorkerLifetime {
  worker: Worker;
  exited: Promise<void>;
  retiring: boolean;
  failure?: unknown;
  closePromise?: Promise<void>;
}

const DEFAULT_IDLE_TIMEOUT_MS = 15_000;

function workerEntryUrl(): URL {
  const extension = fileURLToPath(import.meta.url).endsWith(".ts") ? "ts" : "js";
  return new URL(`./read-worker.${extension}`, import.meta.url);
}

function workerOptions(databasePath: string, expectedSchemaVersion: number): ConstructorParameters<typeof Worker>[1] {
  const isTypeScript = workerEntryUrl().pathname.endsWith(".ts");
  return {
    workerData: { databasePath, expectedSchemaVersion },
    ...(isTypeScript
      ? { execArgv: ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href] }
      : {}),
  };
}

/** Runs the same whitelisted reads on the caller's store; used when no separate connection is possible. */
export function createInlineReadOperations(store: WorkIntelligenceStore): HeavyReadOperations {
  return {
    async getReport(input) {
      return store.getReport(input);
    },
    async getGraph(input) {
      return store.getGraph(input);
    },
    async getHotspots(input) {
      return store.getHotspots(input);
    },
    async close() {},
  };
}

/** One lazily started read-only worker; it holds its own connection and exits after an idle period. */
export class ReadWorkerClient implements HeavyReadOperations {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly active = new Set<Promise<unknown>>();
  private lifetime?: WorkerLifetime;
  private closePromise?: Promise<void>;
  private idleTimer?: NodeJS.Timeout;
  private nextId = 1;
  private accepting = true;

  public constructor(
    private readonly databasePath: string,
    private readonly expectedSchemaVersion = LATEST_SCHEMA_VERSION,
    private readonly options: ReadWorkerClientOptions = {},
  ) {
    if (options.idleTimeoutMs !== undefined && (!Number.isFinite(options.idleTimeoutMs) || options.idleTimeoutMs < 0)) {
      throw new RangeError("The read worker idle timeout must be a non-negative number.");
    }
  }

  public getReport(input: StoreInput<"getReport">): Promise<StoreOutput<"getReport">> {
    return this.run({ type: "getReport", input });
  }

  public getGraph(input: StoreInput<"getGraph">): Promise<StoreOutput<"getGraph">> {
    return this.run({ type: "getGraph", input });
  }

  public getHotspots(input: StoreInput<"getHotspots">): Promise<StoreOutput<"getHotspots">> {
    return this.run({ type: "getHotspots", input });
  }

  public close(): Promise<void> {
    if (!this.closePromise) {
      this.accepting = false;
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
      this.lifetime?.worker.ref();
      this.closePromise = this.drainAndClose();
    }
    return this.closePromise;
  }

  private run<T>(operation: ReadWorkerOperation): Promise<T> {
    if (!this.accepting) {
      return Promise.reject(new Error("The read worker is closing."));
    }
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const promise = this.send<T>(operation);
    this.active.add(promise);
    void promise
      .finally(() => {
        this.active.delete(promise);
        this.scheduleIdleClose();
      })
      .catch(() => undefined);
    return promise;
  }

  private async send<T>(operation: ReadWorkerOperation): Promise<T> {
    const lifetime = await this.startWorker();
    if (lifetime.failure !== undefined) throw lifetime.failure;
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { lifetime, resolve: (value) => resolve(value as T), reject });
      try {
        lifetime.worker.postMessage({ id, operation } satisfies ReadWorkerRequest);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private async startWorker(): Promise<WorkerLifetime> {
    const previousLifetime = this.lifetime;
    if (previousLifetime?.retiring) {
      await previousLifetime.exited.catch(() => undefined);
      if (this.lifetime === previousLifetime) this.lifetime = undefined;
    }
    if (this.lifetime) return this.lifetime;

    const worker = new Worker(workerEntryUrl(), workerOptions(this.databasePath, this.expectedSchemaVersion));
    worker.unref();
    let resolveExit!: () => void;
    let rejectExit!: (error: unknown) => void;
    const exited = new Promise<void>((resolve, reject) => {
      resolveExit = resolve;
      rejectExit = reject;
    });
    void exited.catch(() => undefined);
    const lifetime: WorkerLifetime = { worker, exited, retiring: false };
    this.lifetime = lifetime;

    worker.on("message", (message: ReadWorkerReply) => {
      const request = this.pending.get(message.id);
      if (!request || request.lifetime !== lifetime) return;
      this.pending.delete(message.id);
      if (message.ok) request.resolve(message.value);
      else request.reject(restoredError(message.error));
    });
    worker.once("error", (error) => {
      if (this.lifetime === lifetime) this.lifetime = undefined;
      lifetime.failure = error;
      this.rejectPending(error, lifetime);
      rejectExit(error);
    });
    worker.once("exit", (code) => {
      if (this.lifetime === lifetime) this.lifetime = undefined;
      if (code === 0 && lifetime.retiring && !this.hasPendingRequests(lifetime)) {
        resolveExit();
        return;
      }
      const error = new Error(`The read worker exited unexpectedly with code ${code}.`);
      lifetime.failure = error;
      this.rejectPending(error, lifetime);
      if (code === 0 && lifetime.retiring) resolveExit();
      else rejectExit(error);
    });
    return lifetime;
  }

  private async drainAndClose(): Promise<void> {
    await Promise.allSettled([...this.active]);
    const lifetime = this.lifetime;
    if (!lifetime) return;
    await this.closeLifetime(lifetime);
  }

  private scheduleIdleClose(): void {
    if (!this.accepting || this.active.size > 0 || !this.lifetime || this.lifetime.retiring) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.closeIdleWorker();
    }, this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
    this.idleTimer.unref();
  }

  private async closeIdleWorker(): Promise<void> {
    const lifetime = this.lifetime;
    if (!this.accepting || this.active.size > 0 || !lifetime || lifetime.retiring) return;
    try {
      await this.closeLifetime(lifetime);
    } catch {
      // A failed idle close must not turn a completed API read into an unhandled rejection.
    }
  }

  private async closeLifetime(lifetime: WorkerLifetime): Promise<void> {
    if (!lifetime.closePromise) {
      lifetime.retiring = true;
      lifetime.worker.ref();
      lifetime.closePromise = this.sendCloseRequest(lifetime);
    }
    await lifetime.closePromise;
    await lifetime.exited;
    if (this.lifetime === lifetime) this.lifetime = undefined;
  }

  private async sendCloseRequest(lifetime: WorkerLifetime): Promise<void> {
    const id = this.nextId++;
    const acknowledgement = new Promise<void>((resolve, reject) => {
      this.pending.set(id, { lifetime, resolve: () => resolve(), reject });
      try {
        lifetime.worker.postMessage({ id, close: true } satisfies ReadWorkerCloseRequest);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
    const [ackResult, exitResult] = await Promise.allSettled([acknowledgement, lifetime.exited]);
    if (ackResult.status === "rejected") throw ackResult.reason;
    if (exitResult.status === "rejected") throw exitResult.reason;
  }

  private hasPendingRequests(lifetime: WorkerLifetime): boolean {
    return [...this.pending.values()].some((request) => request.lifetime === lifetime);
  }

  private rejectPending(error: unknown, lifetime: WorkerLifetime): void {
    for (const [id, request] of this.pending) {
      if (request.lifetime !== lifetime) continue;
      this.pending.delete(id);
      request.reject(error);
    }
  }
}
