import { BackendFailure, BACKEND_ERROR_CODES, type BackendErrorCode } from "./errors.js";
import type { BackendInfo, BackendStartRequest, BackendStopReport, BackendSupervisor } from "./backend-supervisor.js";
import type { DatabaseIdentityRecord } from "../db-source/identity-schema.js";
import type {
  BusyOperationInfo,
  OperationCoordinator,
  OperationRunResult,
  OperationStep,
  OperationStepContext,
} from "../operations/coordinator.js";
import type { JournalJson, OperationKind } from "../operations/journal-record.js";
import type { ServiceOwnerState } from "../operations/service-owner-state.js";

/** Operation kinds that end with the desktop owning a running backend. */
export type ManagedStartKind = Extract<
  OperationKind,
  "takeover" | "restart" | "change-port" | "change-db" | "restore" | "maintenance"
>;

export interface ManagedStartRequest {
  /** Resubmitting the same id returns the same result; a different id while one runs is `busy`. */
  readonly operationId: string;
  readonly kind: ManagedStartKind;
  /** The owner state the shell persisted before this operation. */
  readonly previousOwner: ServiceOwnerState;
  readonly backend: Omit<BackendStartRequest, "beforeStart">;
  readonly selectedDb?: DatabaseIdentityRecord | null;
  /** Descriptive facts the journal keeps (a port change: `{ from, to }`); never a path or a secret. */
  readonly details?: Readonly<Record<string, JournalJson>>;
  /** Stop the running backend first (restart, change of port or database). Default false: a running one is kept. */
  readonly stopRunning?: boolean;
  /**
   * A step that runs once the backend is stopped and before the new one starts (a restore replaces the database here). It
   * is the point of no return of the operation, so it is never cancelled. When it throws, the operation fails and the
   * owner is NEEDS_REPAIR; the caller restarts the backend it stopped.
   */
  readonly whileStopped?: (context: OperationStepContext) => Promise<JournalJson | void>;
}

export interface ManagedStartResult {
  readonly operation: OperationRunResult;
  /** The verified backend, when the operation completed. */
  readonly backend?: BackendInfo;
  /** The backend error code, when the operation failed with one. */
  readonly errorCode?: BackendErrorCode;
}

/**
 * A seam for the smoke tests: awaited at the start of the commit step, after the child is verified and before the
 * operation is closed. A test build passes one that never returns for a port or database change, so the test can end the
 * App at exactly that point. A production build passes none.
 */
export type ManagedStartHold = (point: { readonly kind: ManagedStartKind }) => Promise<void>;

export type ManagedStopResult =
  | { readonly status: "stopped"; readonly report: BackendStopReport }
  | { readonly status: "busy"; readonly current: BusyOperationInfo };

const BACKEND_ERROR_CODE_SET: ReadonlySet<string> = new Set(BACKEND_ERROR_CODES);

/** The code at the start of a failed operation's message (`CODE: detail`), when it is one of ours. */
function errorCodeOf(message: string): BackendErrorCode | undefined {
  const prefix = message.split(":", 1)[0] ?? "";
  return BACKEND_ERROR_CODE_SET.has(prefix) ? (prefix as BackendErrorCode) : undefined;
}

/**
 * Connects the {@link BackendSupervisor} to the {@link OperationCoordinator}: a start is an operation whose steps move the
 * ServiceOwner state PREPARING -> STARTING -> MANAGED, so a failure at any step ends in NEEDS_REPAIR with the child already
 * stopped, and a resubmitted id never spawns a second child.
 *
 * Journal contents are descriptive only: pid, port, versions and error codes. The run id and any path stay in memory.
 * `stop()` is deliberately not an operation: quitting the App does not hand ownership anywhere, so the persisted owner
 * stays MANAGED with no live child, and the next start (or startup recovery against real state) reconciles that.
 */
export class ManagedBackendService {
  private readonly coordinator: OperationCoordinator;
  private readonly supervisor: BackendSupervisor;
  private readonly hold: ManagedStartHold | undefined;

  constructor(coordinator: OperationCoordinator, supervisor: BackendSupervisor, hold?: ManagedStartHold) {
    this.coordinator = coordinator;
    this.supervisor = supervisor;
    this.hold = hold;
  }

  /** Runs (or joins) the start operation described by `request`. */
  async start(request: ManagedStartRequest): Promise<ManagedStartResult> {
    const operation = await this.coordinator.run(
      {
        operationId: request.operationId,
        kind: request.kind,
        previousOwner: request.previousOwner,
        ...(request.selectedDb === undefined ? {} : { selectedDb: request.selectedDb }),
        ...(request.details === undefined ? {} : { details: request.details }),
      },
      this.startSteps(request),
    );
    if (operation.status === "completed") {
      const backend = this.supervisor.running;
      return { operation, ...(backend ? { backend } : {}) };
    }
    const errorCode = operation.status === "failed" ? errorCodeOf(operation.error) : undefined;
    return { operation, ...(errorCode ? { errorCode } : {}) };
  }

  /** Stops the backend (App quit); refused with `busy` while a start operation holds the lock. */
  async stop(): Promise<ManagedStopResult> {
    const current = this.coordinator.current();
    if (current) return { status: "busy", current };
    return { status: "stopped", report: await this.supervisor.stop() };
  }

  private startSteps(request: ManagedStartRequest): OperationStep[] {
    return [
      {
        name: "prepare",
        phase: "PREPARING",
        cancellable: true,
        run: async () => {
          if (!request.stopRunning) return { stoppedPrevious: false };
          const report = await this.supervisor.stop();
          if (!report.exited || !report.portReleased) {
            throw new BackendFailure("PORT_NOT_RELEASED", "the previous backend could not be proven stopped");
          }
          return { stoppedPrevious: report.wasRunning };
        },
      },
      ...(request.whileStopped
        ? [
            {
              name: "while-stopped",
              cancellable: false,
              run: request.whileStopped,
            } satisfies OperationStep,
          ]
        : []),
      {
        name: "start-backend",
        phase: "STARTING",
        // A child may be migrating the database: this step is never interrupted by a cancel.
        cancellable: false,
        run: async (context) => {
          const result = await this.supervisor.start({
            ...request.backend,
            beforeStart: async (summary) => {
              if (summary.willMigrate) await context.markMigrationStarted();
            },
          });
          if (result.status === "failed") throw new BackendFailure(result.code, result.detail);
          const { info } = result;
          return {
            outcome: result.status,
            pid: info.pid,
            port: info.port,
            appVersion: info.appVersion,
            schemaVersion: info.schemaVersion,
          };
        },
      },
      {
        name: "commit",
        phase: "MANAGED",
        cancellable: false,
        run: async () => {
          await this.hold?.({ kind: request.kind });
          const info = this.supervisor.running;
          if (!info) throw new BackendFailure("CHILD_EXITED", "the backend is not running at commit time");
          return { port: info.port, pid: info.pid };
        },
      },
    ];
  }
}
