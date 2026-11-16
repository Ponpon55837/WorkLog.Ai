import type { BackendStopReport } from "../backend/backend-supervisor.js";

export type StopAttempt =
  { readonly status: "stopped"; readonly report: BackendStopReport } | { readonly status: "busy" };

export interface QuitFlowDeps {
  /** The native confirmation; true to go on. Not called when the quit was not asked for by the user. */
  confirm(): Promise<boolean>;
  /** Asks the coordinator to cancel the running operation, if it can be cancelled. */
  cancelOperation(): Promise<void>;
  /** Stops through the managed service; `busy` while an operation holds the lock. */
  tryManagedStop(): Promise<StopAttempt>;
  /** Stops the child this App spawned, whatever else is going on. */
  forceStop(): Promise<BackendStopReport>;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  /** The backend could not be proven stopped: tell the user (a dialog, or only the log in background mode). */
  warnIncompleteStop(report: BackendStopReport | undefined): Promise<void>;
  /** How long to wait for a running operation to end before stopping the child directly. Default 10 s. */
  readonly waitLimitMs?: number;
  readonly pollMs?: number;
}

export type QuitResult = "exit" | "cancelled" | "ignored";

const DEFAULT_WAIT_LIMIT_MS = 10_000;
const DEFAULT_POLL_MS = 100;

/**
 * The quit path shared by the tray, `before-quit` and signals. Re-entry is refused; the user's confirmation comes first;
 * then a running operation is cancelled and waited for (bounded); and in every case the child this App started is stopped
 * and the report checked before the process may exit, so an exit never leaves an orphan backend unnoticed.
 */
export class QuitFlow {
  private readonly deps: QuitFlowDeps;
  private active = false;

  constructor(deps: QuitFlowDeps) {
    this.deps = deps;
  }

  async request(options: { readonly confirmFirst: boolean }): Promise<QuitResult> {
    if (this.active) return "ignored";
    this.active = true;
    try {
      if (options.confirmFirst && !(await this.deps.confirm())) {
        this.active = false;
        return "cancelled";
      }
      const report = await this.stop();
      if (!report || !report.exited || !report.portReleased) {
        this.deps.log(
          `[shell] backend not proven stopped: exited=${report?.exited ?? "unknown"} portReleased=${report?.portReleased ?? "unknown"}`,
        );
        await this.deps.warnIncompleteStop(report).catch(() => undefined);
      }
      return "exit";
    } catch (error) {
      this.deps.log(`[shell] quit failed: ${error instanceof Error ? error.message : "unknown error"}`);
      this.active = false;
      return "cancelled";
    }
  }

  private async stop(): Promise<BackendStopReport | undefined> {
    const limit = this.deps.waitLimitMs ?? DEFAULT_WAIT_LIMIT_MS;
    const poll = this.deps.pollMs ?? DEFAULT_POLL_MS;
    let waited = 0;
    let cancelled = false;
    for (;;) {
      const attempt = await this.deps.tryManagedStop();
      if (attempt.status === "stopped") {
        this.deps.log(
          `[shell] stop: graceful=${attempt.report.graceful} forced=${attempt.report.forced} exited=${attempt.report.exited} portReleased=${attempt.report.portReleased}`,
        );
        return attempt.report;
      }
      if (!cancelled) {
        cancelled = true;
        await this.deps.cancelOperation().catch(() => undefined);
      }
      if (waited >= limit) break;
      await this.deps.sleep(poll);
      waited += poll;
    }
    this.deps.log("[shell] an operation still runs after the wait: stopping the backend directly");
    return this.deps.forceStop().catch((error: unknown) => {
      this.deps.log(`[shell] direct stop failed: ${error instanceof Error ? error.message : "unknown error"}`);
      return undefined;
    });
  }
}
