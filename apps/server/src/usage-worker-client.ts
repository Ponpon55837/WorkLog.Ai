import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  UsageScanAbortedError,
  UsageScanTimeoutError,
  type UsageProjectInput,
} from "@work-intelligence/shared/agent-usage";
import {
  USAGE_SCAN_TIMEOUT_MS,
  type UsageOperations,
  type UsageScanContext,
  type UsageScanInput,
  type UsageScanOutcome,
  type UsageSourcesResult,
} from "./usage-scan.js";

type UsageWorkerOperation =
  { type: "sources"; projects: UsageProjectInput[] } | { type: "scan"; input: UsageScanInput; deadlineMs?: number };

export interface UsageWorkerRequest {
  id: number;
  operation: UsageWorkerOperation;
}

export type UsageWorkerReply =
  { id: number; ok: true; value: unknown } | { id: number; ok: false; error: { name: string; message: string } };

interface UsageWorkerClientOptions {
  /** Longest a request may take before its process is killed; defaults to {@link USAGE_SCAN_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Old-generation heap of the process in MiB. */
  heapMb?: number;
}

const USAGE_WORKER_HEAP_MB = 1024;
const USAGE_WORKER_SEMI_SPACE_MB = 2;

function workerEntryPath(): string {
  const extension = fileURLToPath(import.meta.url).endsWith(".ts") ? "ts" : "js";
  return fileURLToPath(new URL(`./usage-worker.${extension}`, import.meta.url));
}

/** Starts the process on the same Node binary as the API; in a TypeScript checkout it runs through tsx, like the API. */
function startWorkerProcess(context: UsageScanContext, heapMb: number): ChildProcess {
  const entry = workerEntryPath();
  const tsx = entry.endsWith(".ts")
    ? ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href]
    : [];
  return fork(entry, [JSON.stringify(context)], {
    execPath: process.execPath,
    execArgv: [...tsx, `--max-old-space-size=${heapMb}`, `--max-semi-space-size=${USAGE_WORKER_SEMI_SPACE_MB}`],
    serialization: "advanced",
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    windowsHide: true,
  });
}

function restoredError(error: { name: string }): Error {
  if (error.name === "UsageScanAbortedError") return new UsageScanAbortedError();
  if (error.name === "UsageScanTimeoutError") return new UsageScanTimeoutError();
  return new Error("The usage scan failed.");
}

/**
 * Runs each usage request in its own child process, so reading many large logs never blocks the API's event loop, and
 * an abort, a timeout or a newer scan ends the work by killing the process. One scan runs at a time: a new scan cancels
 * the running one.
 */
export class UsageWorkerClient implements UsageOperations {
  private nextId = 1;
  private runningScan: AbortController | undefined;

  public constructor(
    private readonly context: UsageScanContext,
    private readonly options: UsageWorkerClientOptions = {},
  ) {}

  public sources(projects: UsageProjectInput[], signal?: AbortSignal): Promise<UsageSourcesResult> {
    return this.run({ type: "sources", projects }, signal);
  }

  public scan(input: UsageScanInput, signal?: AbortSignal): Promise<UsageScanOutcome> {
    this.runningScan?.abort();
    const controller = new AbortController();
    this.runningScan = controller;
    const relay = (): void => controller.abort();
    signal?.addEventListener("abort", relay, { once: true });
    if (signal?.aborted) relay();
    const timeoutMs = this.options.timeoutMs ?? USAGE_SCAN_TIMEOUT_MS;
    return this.run<UsageScanOutcome>(
      { type: "scan", input, deadlineMs: Date.now() + timeoutMs },
      controller.signal,
    ).finally(() => {
      signal?.removeEventListener("abort", relay);
      if (this.runningScan === controller) this.runningScan = undefined;
    });
  }

  private run<T>(operation: UsageWorkerOperation, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new UsageScanAbortedError());
    const timeoutMs = this.options.timeoutMs ?? USAGE_SCAN_TIMEOUT_MS;
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const child = startWorkerProcess(this.context, this.options.heapMb ?? USAGE_WORKER_HEAP_MB);
      let settled = false;
      let watchdog: NodeJS.Timeout | undefined;
      const settle = (finish: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        signal?.removeEventListener("abort", onAbort);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        finish();
      };
      function onAbort(): void {
        settle(() => reject(new UsageScanAbortedError()));
      }
      watchdog = setTimeout(() => settle(() => reject(new UsageScanTimeoutError())), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      child.on("message", (message: UsageWorkerReply) => {
        if (message.id !== id) return;
        settle(() => (message.ok ? resolve(message.value as T) : reject(restoredError(message.error))));
      });
      child.on("error", () => settle(() => reject(new Error("The usage worker could not start."))));
      child.once("close", () => settle(() => reject(new Error("The usage worker exited unexpectedly."))));
      try {
        child.send({ id, operation } satisfies UsageWorkerRequest);
      } catch {
        settle(() => reject(new Error("The usage worker could not be reached.")));
      }
    });
  }
}
