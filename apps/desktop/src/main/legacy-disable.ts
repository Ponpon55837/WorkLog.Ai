import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import {
  createLegacyCommandRunner,
  describeLegacyDisableSteps,
  detectLegacyBusy,
  executeLegacyDisable,
  legacyDisableFileSystem,
  legacyProcessIsAlive,
  planLegacyDisable,
  previewToCandidate,
  type BackendSupervisor,
  type LegacyDisableDependencies,
  type LegacyDisableOutcome,
  type LegacyDisablePlan,
  type LegacyDisableConfirmResult,
  type LegacyDisablePreviewResult,
  type LegacyDisableStartResult,
  type OperationCoordinator,
} from "@work-intelligence/desktop-core";
import { pathsReferToSameFile } from "@work-intelligence/shared/file-identity";
import { probeLoopbackPort } from "@work-intelligence/shared/loopback-port";
import type { BackendController } from "./backend.js";
import type { LegacyGuard } from "./legacy.js";
import type { Logger } from "./log.js";
import type { ShellState } from "./state.js";

/** The disable runs real OS commands that may take a while (systemd stop timeout, schtasks): give each its own budget. */
const COMMAND_TIMEOUT_MS = 30_000;

/**
 * 「停用舊的登入服務」: a read-only preview, then a confirmed disable of exactly the definition the preview showed (see
 * `executeLegacyDisable`). Afterwards the App's own database gets a read-only `quick_check` before anything opens it,
 * and the App offers 「立即啟動」 only in an interactive launch with settings and no backend running; it never starts by
 * itself.
 */
export interface LegacyDisableController {
  preview(): Promise<LegacyDisablePreviewResult>;
  confirm(previewId: string, continueWhileBusy: boolean): Promise<LegacyDisableConfirmResult>;
  startNow(): Promise<LegacyDisableStartResult>;
}

export interface LegacyDisableOptions {
  readonly state: ShellState;
  readonly legacy: LegacyGuard;
  readonly coordinator: OperationCoordinator;
  readonly supervisor: BackendSupervisor;
  readonly backend: BackendController;
  readonly openRepairWindow: () => void;
  readonly log: Logger;
  readonly environment: NodeJS.ProcessEnv;
  /** The native confirmation; Cancel is the default button. Resolves true only for 「停用」. */
  readonly confirmDialog: (hardStop: boolean) => Promise<boolean>;
  /** Test seam: replaces the OS side of the disable (a test build records the commands instead of running them). */
  readonly dependencies?: Partial<LegacyDisableDependencies>;
}

interface Pending {
  readonly id: string;
  readonly plan: LegacyDisablePlan;
  readonly busy: boolean;
}

export function createLegacyDisable(options: LegacyDisableOptions): LegacyDisableController {
  const { state, legacy, coordinator, supervisor, backend, log } = options;
  let pending: Pending | null = null;
  // Set once a disable worked, so 「立即啟動」 belongs to that disable and nothing else.
  let startOffered = false;

  const dependencies: LegacyDisableDependencies = {
    runCommand: createLegacyCommandRunner(COMMAND_TIMEOUT_MS),
    detect: () => legacy.refresh(),
    isPortFree: async (port) => (await probeLoopbackPort(port)).free,
    isProcessAlive: legacyProcessIsAlive,
    ...legacyDisableFileSystem,
    sleep: (milliseconds) => delay(milliseconds),
    now: () => Date.now(),
    environment: options.environment,
    ...options.dependencies,
  };

  const canStart = (): boolean =>
    state.settings !== null &&
    !state.needsSetup &&
    state.launchMode === "interactive" &&
    supervisor.running === undefined &&
    coordinator.current() === null;

  /** Whether the App's own database is the one the old service used (same file, not just the same text). */
  function sameDatabase(plan: LegacyDisablePlan): boolean {
    const database = state.databasePath();
    return database !== null && plan.databasePath !== undefined && pathsReferToSameFile(database, plan.databasePath);
  }

  /** Read-only integrity check of the App's database; on failure the repair window shows it as the candidate to act on. */
  async function checkAppDatabase(): Promise<boolean> {
    const database = state.databasePath();
    if (!database) return true;
    const result = await supervisor.preview(database, { quickCheck: true });
    const candidate = previewToCandidate(result);
    if (candidate.status === "ok") {
      log("[shell] legacy disable: the database check passed");
      return true;
    }
    log("[shell] legacy disable: the database check after the old service stopped did not pass");
    state.recentErrors.record("DB_INTEGRITY_CHECK_FAILED", new Date());
    const id = state.candidates.add(database);
    state.candidates.setPreview(id, candidate);
    state.touch();
    options.openRepairWindow();
    return false;
  }

  async function run(plan: LegacyDisablePlan, operationId: string): Promise<LegacyDisableOutcome | "busy"> {
    const result = await coordinator.run(
      {
        operationId,
        kind: "legacy-disable",
        previousOwner: state.owner,
        oldServiceDefinition: {
          platform: plan.platform,
          definitionPath: plan.definitionPath,
          repositoryRoot: plan.repositoryRoot,
          definitionDigest: plan.definitionDigest,
        },
        oldRunningState: plan.wasRunning,
      },
      [
        {
          name: "disable",
          // OS commands and an unlink: never interrupted halfway.
          cancellable: false,
          run: async () => ({ ...(await executeLegacyDisable(plan, dependencies)) }),
        },
      ],
    );
    if (result.status === "busy") return "busy";
    if (result.status === "completed") return result.result as unknown as LegacyDisableOutcome;
    return { outcome: "failed", step: "operation", detail: result.status, removed: false };
  }

  return {
    preview: async () => {
      const detection = await legacy.refresh();
      const plan = planLegacyDisable(detection, { environment: options.environment });
      if (!plan) {
        pending = null;
        return { ok: false, reason: "unavailable" };
      }
      const busy = await detectLegacyBusy({
        ...(plan.databasePath ? { databasePath: plan.databasePath } : {}),
        ...(plan.backupDirectory ? { backupDirectory: plan.backupDirectory } : {}),
      });
      pending = { id: randomUUID(), plan, busy: busy.importRunning || busy.backupRunning };
      return {
        ok: true,
        preview: {
          previewId: pending.id,
          running: plan.wasRunning,
          hardStop: plan.hardStop && plan.wasRunning,
          busy: pending.busy,
          sameDatabase: sameDatabase(plan),
          steps: describeLegacyDisableSteps(plan),
        },
      };
    },

    confirm: async (previewId, continueWhileBusy) => {
      const current = pending;
      if (!current || current.id !== previewId || (current.busy && !continueWhileBusy)) {
        return { ok: false, reason: "invalid" };
      }
      if (!(await options.confirmDialog(current.plan.hardStop && current.plan.wasRunning))) {
        return { ok: false, reason: "cancelled" };
      }
      pending = null;
      const outcome = await run(current.plan, current.id);
      await legacy.refresh();
      if (outcome === "busy") return { ok: false, reason: "busy" };
      log(`[shell] legacy disable: ${outcome.outcome}${outcome.outcome === "failed" ? ` at ${outcome.step}` : ""}`);
      if (outcome.outcome !== "disabled") {
        return {
          ok: false,
          reason: outcome.outcome,
          ...(outcome.outcome === "failed" ? { removed: outcome.removed } : {}),
        };
      }
      // The old backend may have been writing to this database when it stopped: check it before the App opens it.
      const checked = sameDatabase(current.plan) ? await checkAppDatabase() : true;
      if (!checked) return { ok: false, reason: "database-check-failed" };
      startOffered = canStart();
      return { ok: true, offerStart: startOffered };
    },

    startNow: async () => {
      if (!startOffered || !canStart()) return { ok: false, reason: "invalid" };
      startOffered = false;
      const outcome = await backend.start("restart");
      if (outcome.ok) {
        backend.presenter().clear();
        return { ok: true };
      }
      if (outcome.busy) return { ok: false, reason: "busy" };
      backend.recovery.handleFailure(outcome.code);
      return { ok: false, reason: "failed", errorCode: outcome.code };
    },
  };
}

/**
 * A test build's stand-in for the OS (with the synthetic detection file, see `legacyServiceFileOverride`): every
 * command is appended to `<file>.commands.jsonl` instead of run, the native confirmation answers 「停用」 and is
 * recorded there too, and the Windows process list is empty. Port, file checks and the unlink are real.
 */
export function syntheticLegacyDisable(
  legacyFile: string,
): Pick<LegacyDisableOptions, "dependencies" | "confirmDialog"> {
  const record = (entry: unknown): void => appendFileSync(`${legacyFile}.commands.jsonl`, `${JSON.stringify(entry)}\n`);
  return {
    dependencies: {
      runCommand: async (command, args) => {
        record({ command, args });
        const listing = /powershell/i.test(command);
        return { stdout: listing ? Buffer.from("[]", "utf8").toString("base64") : "", code: 0 };
      },
    },
    confirmDialog: async (hardStop) => {
      record({ dialog: "legacy-disable", hardStop });
      return true;
    },
  };
}
