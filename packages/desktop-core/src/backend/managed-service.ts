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

export type ManagedStartKind = Extract<
  OperationKind,
  "takeover" | "restart" | "change-port" | "change-db" | "restore" | "maintenance"
>;

export interface ManagedStartRequest {
  readonly operationId: string;
  readonly kind: ManagedStartKind;
  readonly previousOwner: ServiceOwnerState;
  readonly backend: Omit<BackendStartRequest, "beforeStart">;
  readonly selectedDb?: DatabaseIdentityRecord | null;
  readonly details?: Readonly<Record<string, JournalJson>>;
  readonly stopRunning?: boolean;
  readonly whileStopped?: (context: OperationStepContext) => Promise<JournalJson | void>;
}

export interface ManagedStartResult {
  readonly operation: OperationRunResult;
  readonly backend?: BackendInfo;
  readonly errorCode?: BackendErrorCode;
}

export type ManagedStartHold = (point: { readonly kind: ManagedStartKind }) => Promise<void>;

export type ManagedStopResult =
  | { readonly status: "stopped"; readonly report: BackendStopReport }
  | { readonly status: "busy"; readonly current: BusyOperationInfo };

const BACKEND_ERROR_CODE_SET: ReadonlySet<string> = new Set(BACKEND_ERROR_CODES);

function errorCodeOf(message: string): BackendErrorCode | undefined {
  const prefix = message.split(":", 1)[0] ?? "";
  return BACKEND_ERROR_CODE_SET.has(prefix) ? (prefix as BackendErrorCode) : undefined;
}

export class ManagedBackendService {
  private readonly coordinator: OperationCoordinator;
  private readonly supervisor: BackendSupervisor;
  private readonly hold: ManagedStartHold | undefined;

  constructor(coordinator: OperationCoordinator, supervisor: BackendSupervisor, hold?: ManagedStartHold) {
    this.coordinator = coordinator;
    this.supervisor = supervisor;
    this.hold = hold;
  }

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
