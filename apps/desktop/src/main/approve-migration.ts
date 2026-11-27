import {
  allowMigrationFor,
  previewToCandidate,
  shellMessages,
  storagePolicy,
  type BackendSupervisor,
  type DbProbeStatus,
  type RepairActionResult,
  type RepairBusyReason,
} from "@work-intelligence/desktop-core";
import { busyReasonOf, checkActivity } from "./activity-gate.js";
import type { BackendController } from "./backend.js";
import type { Logger } from "./log.js";
import type { RepairInfo } from "./repair-info.js";
import type { RepairSuccess } from "./repair-success.js";
import type { StorageRiskService } from "./storage-risk.js";
import type { ShellState } from "./state.js";

interface ApproveMigrationOptions {
  readonly state: Pick<ShellState, "databasePath" | "locale">;
  readonly supervisor: Pick<BackendSupervisor, "preview" | "queryActivity" | "running">;
  readonly storage: Pick<StorageRiskService, "classify" | "last">;
  readonly backend: Pick<BackendController, "start" | "recovery" | "presenter">;
  readonly success: Pick<RepairSuccess, "opens" | "finish">;
  readonly info: Pick<RepairInfo, "snapshot">;
  readonly operationRunning: () => boolean;
  readonly busyReason: () => RepairBusyReason;
  readonly log: Logger;
}

const STATUS_CODES: Readonly<Partial<Record<DbProbeStatus, string>>> = {
  missing: "DB_MISSING",
  offline: "DB_OFFLINE",
  denied: "DB_PERMISSION",
  "unsupported-schema": "SCHEMA_TOO_NEW",
};

export function createApproveMigration(options: ApproveMigrationOptions): () => Promise<RepairActionResult> {
  const { state, supervisor, storage, backend, success, info, log } = options;
  return async () => {
    const databasePath = state.databasePath();
    if (databasePath === null || supervisor.running !== undefined) return { ok: false, reason: "invalid" };
    const risk = (storage.last(databasePath) ?? (await storage.classify(databasePath))).risk;
    if (storagePolicy(risk).migrationBlocked) {
      log("[shell] schema update refused: the database's storage does not allow it");
      return { ok: false, reason: "invalid", message: shellMessages(state.locale).repairOwnMigrationCopyNote };
    }
    const preview = previewToCandidate(await supervisor.preview(databasePath));
    if (preview.status !== "ok" || !preview.identity) {
      return {
        ok: false,
        reason: "failed",
        errorCode: preview.errorCode ?? STATUS_CODES[preview.status] ?? "REPAIR_REQUIRED",
      };
    }
    const gate = await checkActivity({ operationRunning: options.operationRunning, supervisor });
    if ("refusal" in gate) {
      return { ok: false, reason: "busy", busyReason: busyReasonOf(gate.refusal, options.busyReason()) };
    }
    // A pending automatic retry must not start the database without the update while this start runs.
    backend.recovery.cancel();
    const opensAtStart = success.opens();
    const outcome = await backend.start("change-db", {
      databasePath,
      expectedIdentity: preview.identity,
      allowSchemaMigration: allowMigrationFor(preview.needsMigration, risk),
    });
    if (!outcome.ok) {
      if (outcome.busy) return { ok: false, reason: "busy", busyReason: options.busyReason() };
      success.finish(outcome, opensAtStart);
      backend.presenter().present(outcome.code);
      return { ok: false, reason: "failed", errorCode: outcome.code };
    }
    log(
      preview.needsMigration
        ? "[shell] the database was updated after the user approved it"
        : "[shell] the database needed no update",
    );
    success.finish(outcome, opensAtStart);
    return { ok: true, state: await info.snapshot() };
  };
}
