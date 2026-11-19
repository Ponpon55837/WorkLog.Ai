import {
  validatePortChange,
  type BackendActivityReport,
  type OperationCoordinator,
  type PortChangeResult,
  type PortHandoffStore,
  type RepairPortSection,
  type RestartOutcome,
} from "@work-intelligence/desktop-core";
import type { PortHandoff } from "@work-intelligence/schema";
import { portFailureCode } from "@work-intelligence/shared/port-failure";
import { checkActivity } from "./activity-gate.js";
import type { BackendController } from "./backend.js";
import type { Logger } from "./log.js";
import type { ShellState } from "./state.js";

/**
 * 「變更連接埠」 (DT-14). The change starts only in the App: from the repair window's port section or the tray. The Web
 * page may ask the App to open that section (`offer`), and then its whitelisted preferences wait in memory, single use,
 * to be carried to the new address. Nothing about the snapshot is written to disk or to a log.
 *
 * Order: validate, refuse when something runs (an operation or a long job of the backend), probe the target (only a
 * hint, and nothing is stopped for an occupied one), confirm natively, then one managed start on the new port that
 * commits the settings only once the backend is verified. A failed start brings the old port back.
 */
export interface ChangePortController {
  change(input: unknown): Promise<PortChangeResult>;
  /** The Dashboard asked for the port settings: keep its preferences (sanitized) and show the section. */
  offer(request: { readonly preferences?: unknown; readonly route?: string }): void;
  /** The tray item: show the section. */
  openSection(): void;
  /** What the repair page's port section shows. */
  section(): RepairPortSection;
}

/** @internal test-only */
export interface ChangePortOptions {
  readonly state: ShellState;
  readonly coordinator: Pick<OperationCoordinator, "current">;
  readonly supervisor: {
    readonly running: { readonly port: number } | undefined;
    queryActivity(): Promise<BackendActivityReport>;
  };
  readonly backend: Pick<BackendController, "startOnPort" | "start" | "presenter" | "recovery">;
  /** Binds and releases the port; `free: false` carries the errno of the refusal. */
  readonly probePort: (
    port: number,
  ) => Promise<{ readonly free: true } | { readonly free: false; readonly code: string }>;
  /** The native confirmation; Cancel is the default button. */
  /** `pendingImport`: a staged import preview exists and the restart will discard it; the dialog says so before the click. */
  readonly confirmDialog: (from: number, to: number, pendingImport: boolean) => Promise<boolean>;
  readonly handoff: PortHandoffStore;
  /** Opens the Dashboard at the running backend's port, with the handoff fragment when one is given. */
  readonly openDashboard: (handoff?: PortHandoff) => void;
  readonly showSection: () => void;
  readonly log: Logger;
}

export function createChangePort(options: ChangePortOptions): ChangePortController {
  const { state, coordinator, supervisor, backend, log } = options;
  /** The section was asked for and no state has carried that to a page yet. */
  let focusPending = false;

  /** A refusal because something runs, or what the restart would throw away when nothing does (see `checkActivity`). */
  async function busyReason(): Promise<
    { readonly refusal: Extract<PortChangeResult, { ok: false }> } | { readonly pendingImport: boolean }
  > {
    const gate = await checkActivity({ operationRunning: () => coordinator.current() !== null, supervisor });
    return "refusal" in gate ? { refusal: { ok: false, reason: "busy", busy: gate.refusal } } : gate;
  }

  function failureOf(code: string, rolledBack: boolean): PortChangeResult {
    const reason =
      code === "PORT_OCCUPIED_BY_OTHER" ? "occupied" : code === "PORT_NOT_PERMITTED" ? "not-permitted" : "failed";
    return { ok: false, reason, errorCode: code, rolledBack };
  }

  /** The start on the new port failed: the old port comes back (settings were never changed). */
  async function rollBack(code: string, from: number): Promise<PortChangeResult> {
    // A refusal before anything was stopped (the old login service, a network share) leaves the old backend serving: there
    // is nothing to bring back, and a second start would be refused the same way and mark a healthy backend NEEDS_REPAIR.
    if (supervisor.running?.port === from) {
      log(`[shell] port change refused (${code}); the old port is still serving`);
      return failureOf(code, true);
    }
    log(`[shell] port change failed (${code}); restarting on the old port`);
    const restored: RestartOutcome = await backend
      .start("restart")
      .catch(() => ({ ok: false as const, code: "REPAIR_REQUIRED" }));
    if (restored.ok) {
      backend.presenter().clear();
      return failureOf(code, true);
    }
    // Not even the old port starts: the repair state shows it, and its port section stays usable.
    if (!restored.busy) backend.recovery.handleFailure(restored.code);
    return failureOf(code, false);
  }

  async function change(input: unknown): Promise<PortChangeResult> {
    const { settings } = state;
    if (!settings) return { ok: false, reason: "failed" };
    const from = settings.desired.port;
    const checked = validatePortChange(input, from);
    if (checked.kind === "invalid") return { ok: false, reason: "invalid", problem: checked.problem };
    if (checked.kind === "same") return { ok: true, changed: false, port: checked.port };
    const to = checked.port;
    const early = await busyReason();
    if ("refusal" in early) return early.refusal;
    // Only a hint (the real bind stays the authority), but an occupied target stops nothing.
    const probe = await options.probePort(to);
    if (!probe.free) {
      return { ok: false, reason: portFailureCode(probe.code) === "PORT_NOT_PERMITTED" ? "not-permitted" : "occupied" };
    }
    if (!(await options.confirmDialog(from, to, early.pendingImport))) return { ok: false, reason: "cancelled" };
    // Something may have started while the dialog was open.
    const late = await busyReason();
    if ("refusal" in late) return late.refusal;
    const outcome = await backend.startOnPort({ port: to, from });
    if (!outcome.ok) {
      if (outcome.busy) return { ok: false, reason: "busy", busy: "operation" };
      return rollBack(outcome.code, from);
    }
    log("[shell] port changed");
    backend.presenter().clear();
    const taken = options.handoff.take();
    options.openDashboard(taken);
    state.touch();
    // The restart stops the old backend, whose shutdown removes the staged file; only a preview that was there counts.
    return late.pendingImport
      ? { ok: true, changed: true, port: to, discardedImportPreview: true }
      : { ok: true, changed: true, port: to };
  }

  return {
    change,
    offer: (request) => {
      options.handoff.put(request.preferences, request.route);
      focusPending = true;
      options.showSection();
    },
    openSection: () => {
      focusPending = true;
      options.showSection();
    },
    section: () => {
      // Consumed by the state that reports it: the page scrolls once, and a later load of the page does not.
      const focus = focusPending;
      focusPending = false;
      return {
        port: state.settings?.desired.port ?? null,
        activePort: supervisor.running?.port ?? null,
        focus,
        handoffHeld: options.handoff.holds(),
      };
    },
  };
}
