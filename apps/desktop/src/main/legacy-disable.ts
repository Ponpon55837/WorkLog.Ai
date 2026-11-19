import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { DESKTOP_INTEGRITY_CHECK_FAILED_DETAIL } from "@work-intelligence/schema";
import {
  countLegacyRunners,
  createLegacyCommandRunner,
  describeLegacyDisableSteps,
  detectLegacyBusy,
  executeLegacyDisable,
  legacyDisableFileSystem,
  legacyProcessIsAlive,
  legacyRunnerPath,
  planLegacyDisable,
  previewToCandidate,
  setupMessages,
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

/** @internal test-only */
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
  /** The preview warned about an import or backup (then only 「仍要停用」 confirms). */
  busy: boolean;
  /** Whether the old backend is (or may be) running: the task says so, or on Windows a runner of this checkout is alive. */
  readonly running: boolean;
  readonly hardStop: boolean;
}

/** What the read-only check of the App's database after the stop found. */
type DatabaseCheck = "passed" | "damaged" | "unverified";

export function createLegacyDisable(options: LegacyDisableOptions): LegacyDisableController {
  const { state, legacy, coordinator, supervisor, backend, log } = options;
  let pending: Pending | null = null;
  // Set once a disable worked, so 「立即啟動」 belongs to that disable and nothing else.
  let startOffered = false;

  const dependencies: LegacyDisableDependencies = {
    runCommand: createLegacyCommandRunner(COMMAND_TIMEOUT_MS),
    detect: () => legacy.refresh(),
    // The App's own backend on that port proves the old one is not listening there (one listener per port).
    isPortFree: async (port) => supervisor.running?.port === port || (await probeLoopbackPort(port)).free,
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

  /**
   * Read-only integrity check of the App's database. Only a failed `quick_check` counts as damage (recorded, and the
   * repair window shows the database as the candidate to act on); a database that could not be read this time (locked,
   * timed out, the child failed) is "unverified", which is not reported as damage.
   */
  async function checkAppDatabase(): Promise<DatabaseCheck> {
    const database = state.databasePath();
    if (!database) return "passed";
    const result = await supervisor.preview(database, { quickCheck: true }).catch(() => null);
    if (result === null) {
      log("[shell] legacy disable: the database check could not run");
      return "unverified";
    }
    const candidate = previewToCandidate(result);
    if (candidate.status === "ok") {
      log("[shell] legacy disable: the database check passed");
      return "passed";
    }
    const damaged =
      result.outcome === "checked" &&
      result.preflight.status === "unreadable" &&
      result.preflight.detail === DESKTOP_INTEGRITY_CHECK_FAILED_DETAIL;
    if (!damaged) {
      log(`[shell] legacy disable: the database check could not finish (${candidate.status})`);
      return "unverified";
    }
    log("[shell] legacy disable: the database check after the old service stopped did not pass");
    state.recentErrors.record("DB_INTEGRITY_CHECK_FAILED", new Date());
    const id = state.candidates.add(database);
    state.candidates.setPreview(id, candidate);
    state.touch();
    options.openRepairWindow();
    return "damaged";
  }

  /** Windows: a runner of this checkout alive right now, whatever the task says (null: the list could not be read). */
  async function runnersAlive(plan: LegacyDisablePlan): Promise<boolean | null> {
    if (plan.platform !== "win32") return false;
    const count = await countLegacyRunners(legacyRunnerPath(plan.platform, plan.repositoryRoot), dependencies);
    return count === null ? null : count > 0;
  }

  async function isBusy(plan: LegacyDisablePlan): Promise<boolean> {
    const busy = await detectLegacyBusy({
      ...(plan.databasePath ? { databasePath: plan.databasePath } : {}),
      ...(plan.backupDirectory ? { backupDirectory: plan.backupDirectory } : {}),
    });
    return busy.importRunning || busy.backupRunning;
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
    // Interrupted or failed inside the coordinator: assume the stop may have run, so the database still gets checked.
    return { outcome: "failed", step: "operation", detail: result.status, removed: false, stopAttempted: true };
  }

  return {
    preview: async () => {
      const detection = await legacy.refresh();
      const plan = planLegacyDisable(detection, { environment: options.environment });
      if (!plan) {
        pending = null;
        return { ok: false, reason: "unavailable" };
      }
      const busy = await isBusy(plan);
      // A runner that is alive while the task reads as stopped is still ended at once: warn about that too. When the
      // list cannot be read, warn rather than promise a graceful stop.
      const alive = await runnersAlive(plan);
      const running = plan.wasRunning || alive !== false;
      pending = { id: randomUUID(), plan, busy, running, hardStop: plan.hardStop && running };
      return {
        ok: true,
        preview: {
          previewId: pending.id,
          running: pending.running,
          hardStop: pending.hardStop,
          busy: pending.busy,
          sameDatabase: sameDatabase(plan),
          steps: describeLegacyDisableSteps(plan, setupMessages(state.locale).legacyDisableStepText),
        },
      };
    },

    confirm: async (previewId, continueWhileBusy) => {
      const current = pending;
      if (!current || current.id !== previewId || (current.busy && !continueWhileBusy)) {
        return { ok: false, reason: "invalid" };
      }
      // An import or backup that started after the preview: show the warning first, nothing is done yet.
      if (!current.busy && (await isBusy(current.plan))) {
        current.busy = true;
        return { ok: false, reason: "now-busy" };
      }
      if (!(await options.confirmDialog(current.hardStop))) {
        return { ok: false, reason: "cancelled" };
      }
      pending = null;
      const outcome = await run(current.plan, current.id);
      await legacy.refresh();
      if (outcome === "busy") return { ok: false, reason: "busy" };
      log(`[shell] legacy disable: ${outcome.outcome}${outcome.outcome === "failed" ? ` at ${outcome.step}` : ""}`);
      // The old backend may have been ended in the middle of a write to this database: check it before the App opens it,
      // also when a later step failed. Not after `changed` (nothing ran) or `still-running` (it is still writing).
      const stopped = outcome.outcome === "disabled" || (outcome.outcome === "failed" && outcome.stopAttempted);
      const check: DatabaseCheck = stopped && sameDatabase(current.plan) ? await checkAppDatabase() : "passed";
      if (outcome.outcome !== "disabled") {
        return {
          ok: false,
          reason: outcome.outcome,
          ...(outcome.outcome === "failed" ? { removed: outcome.removed } : {}),
        };
      }
      if (check === "damaged") return { ok: false, reason: "database-check-failed" };
      // Not verified this time: the disable worked, but 「立即啟動」 is offered only after a passed check.
      startOffered = check === "passed" && canStart();
      return { ok: true, offerStart: startOffered, ...(check === "unverified" ? { databaseUnverified: true } : {}) };
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
        // `launchctl print` / `systemctl is-enabled` after the stop: the old service is no longer loaded or enabled.
        const verify = args[0] === "print" || args.includes("is-enabled");
        return { stdout: listing ? Buffer.from("[]", "utf8").toString("base64") : "", code: verify ? 113 : 0 };
      },
    },
    confirmDialog: async (hardStop) => {
      record({ dialog: "legacy-disable", hardStop });
      return true;
    },
  };
}
