import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import {
  filesLeftByTransaction,
  agentSetupJournalPath,
  applyAgentSetupTransaction,
  createAgentSetupPlan,
  describeAgentSetupMutations,
  findCheckoutRegistrations,
  inspectAgentHooks,
  inspectAgentRegistrations,
  readAgentSetupJournal,
  recoverAgentSetupJournal,
  undoAgentSetupOperation,
  type AgentSetupPlan,
  type AgentSetupPlanOptions,
  type AgentSetupTransactionResult,
  type CheckoutRegistration,
} from "@work-intelligence/agent-setup";
import {
  classifyAgentStatus,
  launcherShimPath,
  maskHome,
  probeMcpHandshake,
  SETUP_AGENT_IDS,
  type AgentCardView,
  type AgentRegistrationOwner,
  type AgentsActionResult,
  type AgentSelfTestOutcome,
  type AgentsPreview,
  type AgentsResult,
  type AgentsState,
  type OperationCoordinator,
  type SetupAgentId,
} from "@work-intelligence/desktop-core";
import { runAgentOperation } from "./agent-operation.js";
import type { DesktopPaths } from "./config.js";
import type { Logger } from "./log.js";
import type { ShellState } from "./state.js";

/**
 * The Agent page (DT-04 in the App). It reads the Agents' configuration, shows the change the App would make as a diff,
 * and writes only what the user confirmed: the plan applied is the very plan the diff was made from, and agent-setup
 * re-fingerprints every file before writing it, so a file changed in between is never overwritten. Every apply is a
 * journaled transaction the user can undo. Nothing here starts an Agent; the self-test runs the App's own launcher.
 */
export interface AgentsPage {
  snapshot(): AgentsState;
  preview(adopt: boolean): Promise<AgentsActionResult>;
  /** "移除 Agent 設定": previews the removal of what setup wrote; `apply` then runs it the way it runs an install. */
  previewRemove(): Promise<AgentsActionResult>;
  apply(previewId: string): Promise<AgentsActionResult>;
  discard(): AgentsActionResult;
  undo(): Promise<AgentsActionResult>;
  selfTest(): Promise<AgentsActionResult>;
  /**
   * The way out of a checkout on another database: hands the database that Agent's checkout uses to the App's own
   * database change (preview, then the user confirms). Main reads the path; the page only names the Agent.
   */
  useCheckoutDatabase(agent: SetupAgentId): Promise<AgentsActionResult>;
  /** Finishes an apply or undo a crash left half done; called once at start-up. */
  recover(): void;
}

export interface AgentsPageOptions {
  readonly state: ShellState;
  /** Every apply runs as an `apply-agent` operation, so a crash in the middle is found and told at the next start. */
  readonly coordinator: OperationCoordinator;
  readonly paths: Pick<DesktopPaths, "runtimeRoot">;
  /** The canonical `work-intelligence` SKILL.md the App ships. */
  readonly skillSourcePath: string;
  readonly log: Logger;
  /** Opens the App's database change for this file (read-only preview first; nothing switches before the user confirms). */
  readonly offerDatabase: (path: string) => Promise<void>;
}

const SELF_TEST_TIMEOUT_MS = 15_000;

/**
 * The one entry point that writes an Agent plan, install or removal: the journaled transaction. The preview's plan is
 * applied as it is; agent-setup re-fingerprints every file before writing it. Operation bookkeeping wraps this call.
 */
export function commitAgentPlan(plan: AgentSetupPlan, journalPath: string): AgentSetupTransactionResult {
  return applyAgentSetupTransaction(plan, { journalPath });
}

function ownerOf(source: string | undefined): AgentRegistrationOwner {
  if (!source) return "none";
  return (
    (["desktop-managed", "manual", "plugin", "mcpb", "unknown"] as const).find((entry) => entry === source) ?? "unknown"
  );
}

export function createAgentsPage(options: AgentsPageOptions): AgentsPage {
  const { state, log } = options;
  const platform = process.platform;
  const home = homedir();
  const shimPath = launcherShimPath(options.paths.runtimeRoot, platform);
  const journalPath = agentSetupJournalPath(home);
  let pending: { readonly id: string; readonly plan: AgentSetupPlan; readonly view: AgentsPreview } | null = null;
  let result: AgentsResult | null = null;
  let selfTest: AgentsState["selfTest"] = { outcome: "not-run" };
  let busy = false;

  const show = (text: string): string => maskHome(text, home, platform);
  const launcherReady = (): boolean => existsSync(shimPath) && existsSync(options.skillSourcePath);

  function checkoutRegistrations(): CheckoutRegistration[] {
    try {
      const appDatabase = state.databasePath();
      return findCheckoutRegistrations(
        { homeDirectory: home, repositoryRoot: home, platform },
        appDatabase ? { appDatabase } : {},
      );
    } catch {
      return [];
    }
  }

  function planOptions(adopt: boolean, registrations: readonly CheckoutRegistration[]): AgentSetupPlanOptions {
    const databasePath = state.databasePath();
    const roots = [
      ...new Set(
        registrations
          .filter((entry) => !entry.owned && entry.recognised && entry.repositoryRoot)
          .map((entry) => entry.repositoryRoot as string),
      ),
    ];
    return {
      homeDirectory: home,
      // With a launcher target the checkout only serves to recognise hand-written entries that run it.
      repositoryRoot: roots[0] ?? home,
      target: { kind: "launcher", shimPath, skillSourcePath: options.skillSourcePath },
      platform,
      // Only entries on the App's own database are taken over: one Agent must not end up writing to two databases.
      // Without an App database nothing is adopted (there is nothing to compare with).
      ...(adopt && databasePath ? { adopt: { repositoryRoots: roots, databasePath } } : {}),
    };
  }

  /** The checkout database an Agent's hand-written entries use when it is not the App's: MCP's first, else a hook's. */
  function otherDatabaseOf(entries: readonly CheckoutRegistration[]): CheckoutRegistration | undefined {
    const other = entries.filter((entry) => entry.sameAsAppDatabase === false && entry.effectiveDatabase);
    return other.find((entry) => entry.kind === "mcp") ?? other[0];
  }

  function cards(): AgentCardView[] {
    const inspection = (() => {
      try {
        return inspectAgentRegistrations({ homeDirectory: home, repositoryRoot: home, platform });
      } catch {
        return { registrations: [], duplicates: [], unreadable: [] };
      }
    })();
    const checkout = checkoutRegistrations();
    const hookStates = (() => {
      try {
        return inspectAgentHooks({ homeDirectory: home, repositoryRoot: home, platform, shimPath });
      } catch {
        return undefined;
      }
    })();
    return SETUP_AGENT_IDS.map((id: SetupAgentId): AgentCardView => {
      const mcp = inspection.registrations.find((entry) => entry.agent === id && entry.kind === "mcp");
      const hook = inspection.registrations.find((entry) => entry.agent === id && entry.kind === "hook");
      const hookInstallation = hookStates?.[id];
      const handWritten = checkout.filter((entry) => entry.agent === id && !entry.owned);
      const firstRoot = handWritten.find((entry) => entry.repositoryRoot)?.repositoryRoot;
      const notRecognised = handWritten.find((entry) => !entry.recognised);
      const other = otherDatabaseOf(handWritten);
      const status = classifyAgentStatus({
        source: mcp?.source ?? "unknown",
        configWritten: mcp !== undefined,
        configMatches: mcp?.source === "desktop-managed",
        conflict: inspection.duplicates.some((entry) => entry.agent === id),
        hookTrust: "not-applicable",
        runtime: launcherReady() ? "compatible" : "unknown",
        selfTest: selfTest.outcome,
      });
      return {
        id,
        state: status.state,
        nextStep: status.nextStep,
        mcp: ownerOf(mcp?.source),
        hooks: ownerOf(hook?.source),
        ...(hookInstallation ? { hookState: hookInstallation.state, hookSource: hookInstallation.source } : {}),
        ...(firstRoot ? { checkoutDisplay: show(firstRoot) } : {}),
        checkoutMissing: handWritten.some((entry) => entry.repositoryRoot !== undefined && !entry.rootExists),
        adoptable:
          state.databasePath() !== null && handWritten.length > 0 && notRecognised === undefined && other === undefined,
        ...(notRecognised?.reason ? { notAdoptableReason: notRecognised.reason } : {}),
        ...(other?.effectiveDatabase
          ? {
              otherDatabase: {
                display: show(other.effectiveDatabase),
                fromCheckoutDefault: other.kind === "hook" && other.databaseFromCheckoutDefault === true,
              },
            }
          : {}),
      };
    });
  }

  /** The preview the page shows for a plan: the diff of every file, with `~` for the home folder. */
  function previewOf(plan: AgentSetupPlan, mode: AgentsPreview["mode"], adopt: boolean): AgentsPreview {
    return {
      id: randomUUID(),
      mode,
      adopt,
      files: describeAgentSetupMutations(plan).map((file) => ({
        display: show(file.path),
        label: file.label,
        change: file.change,
        tooLarge: file.tooLarge,
        hunks: file.hunks.map((hunk) => ({
          oldStart: hunk.oldStart,
          newStart: hunk.newStart,
          lines: hunk.lines.map((line) => ({ type: line.type, text: show(line.text) })),
        })),
      })),
      actions: plan.actions.map(show),
      conflicts: plan.conflicts.map(show),
    };
  }

  function undoAvailable(): boolean {
    const read = readAgentSetupJournal(journalPath);
    return read.status === "found" && read.journal.state === "committed";
  }

  function snapshot(): AgentsState {
    return {
      locale: state.locale,
      launcherReady: launcherReady(),
      cards: cards(),
      selfTest,
      preview: pending?.view ?? null,
      undoAvailable: (() => {
        try {
          return undoAvailable();
        } catch {
          return false;
        }
      })(),
      result,
      busy,
    };
  }

  async function exclusive(task: () => Promise<AgentsActionResult> | AgentsActionResult): Promise<AgentsActionResult> {
    if (busy) return { ok: false, reason: "busy" };
    busy = true;
    try {
      return await task();
    } catch (error) {
      log(`[shell] agent setup failed: ${error instanceof Error ? error.name : "unknown error"}`);
      return { ok: false, reason: "failed", state: snapshot() };
    } finally {
      busy = false;
    }
  }

  return {
    snapshot,
    recover: () => {
      try {
        const recovery = recoverAgentSetupJournal(journalPath, { homeDirectory: home });
        if (recovery.status !== "none" && recovery.status !== "already-final") {
          log(`[shell] agent setup journal recovery: ${recovery.status}`);
        }
      } catch (error) {
        log(`[shell] agent setup journal recovery failed: ${error instanceof Error ? error.name : "unknown error"}`);
      }
    },
    preview: (adopt) =>
      exclusive(() => {
        if (!launcherReady())
          return { ok: false, reason: "failed", errorCode: "LAUNCHER_NOT_READY", state: snapshot() };
        const plan = createAgentSetupPlan(planOptions(adopt, checkoutRegistrations()), "install");
        const view = previewOf(plan, "install", adopt);
        pending = { id: view.id, plan, view };
        result = null;
        log(`[shell] agent setup preview adopt=${adopt} files=${view.files.length} conflicts=${view.conflicts.length}`);
        return { ok: true, state: snapshot() };
      }),
    previewRemove: () =>
      exclusive(() => {
        // Removal needs no launcher: it only takes out what the setup manifest says setup wrote.
        const plan = createAgentSetupPlan({ homeDirectory: home, repositoryRoot: home, platform }, "uninstall");
        const view = previewOf(plan, "uninstall", false);
        pending = { id: view.id, plan, view };
        result = null;
        log(`[shell] agent setup remove preview files=${view.files.length} conflicts=${view.conflicts.length}`);
        return { ok: true, state: snapshot() };
      }),
    apply: (previewId) =>
      exclusive(async () => {
        if (!pending || pending.id !== previewId) return { ok: false, reason: "invalid", state: snapshot() };
        if (pending.plan.conflicts.length > 0) return { ok: false, reason: "invalid", state: snapshot() };
        const { plan, view } = pending;
        const run = await runAgentOperation(options.coordinator, state.owner, () => commitAgentPlan(plan, journalPath));
        // Another operation (a start, a port change) holds the lock: nothing was written, and the preview stays usable.
        if (run.status === "busy") return { ok: false, reason: "busy", state: snapshot() };
        pending = null;
        if (run.status === "failed") {
          log("[shell] agent setup apply failed inside the operation");
          result = { kind: "failed", code: "APPLY_FAILED" };
          return { ok: false, reason: "failed", errorCode: "APPLY_FAILED", state: snapshot() };
        }
        const applied = run.value;
        log(
          `[shell] agent setup ${view.mode === "uninstall" ? "remove" : "apply"} ${applied.outcome}${applied.code ? ` ${applied.code}` : ""}`,
        );
        if (applied.outcome === "committed") {
          result =
            view.mode === "uninstall"
              ? { kind: "removed", changed: plan.mutations.length }
              : { kind: "applied", changed: plan.mutations.length };
          selfTest = { outcome: "not-run" };
          return { ok: true, state: snapshot() };
        }
        const code = applied.code ?? applied.outcome;
        // Some of what was written could not be put back: name those files, and never say it was all rolled back.
        const left = applied.outcome === "needs-manual-repair" ? filesLeftByTransaction(applied) : [];
        result = {
          kind: "failed",
          code,
          ...(left.length > 0 ? { manualRepairDisplay: left.map(show).join(", ") } : {}),
        };
        return { ok: false, reason: "failed", errorCode: code, state: snapshot() };
      }),
    discard: () => {
      pending = null;
      return { ok: true, state: snapshot() };
    },
    undo: () =>
      exclusive(() => {
        pending = null;
        const undone = undoAgentSetupOperation(journalPath, { homeDirectory: home });
        log(`[shell] agent setup undo ${undone.status}${undone.code ? ` ${undone.code}` : ""}`);
        if (undone.status === "undone") result = { kind: "undone" };
        else if (undone.status === "nothing-to-undo") result = { kind: "nothing-to-undo" };
        else {
          result = {
            kind: "failed",
            code: undone.code ?? undone.status,
            ...(undone.manualRepairPath ? { manualRepairDisplay: show(undone.manualRepairPath) } : {}),
          };
          return { ok: false, reason: "failed", errorCode: undone.code ?? undone.status, state: snapshot() };
        }
        return { ok: true, state: snapshot() };
      }),
    useCheckoutDatabase: (agent) =>
      exclusive(async () => {
        const entries = checkoutRegistrations().filter((entry) => entry.agent === agent && !entry.owned);
        const database = otherDatabaseOf(entries)?.effectiveDatabase;
        if (!database) return { ok: false, reason: "invalid", state: snapshot() };
        log("[shell] agent page: offering the checkout's database to the database change");
        await options.offerDatabase(database);
        return { ok: true, state: snapshot() };
      }),
    selfTest: () =>
      exclusive(async () => {
        if (!existsSync(shimPath)) {
          selfTest = { outcome: "failed", code: "LAUNCHER_NOT_READY" };
          return { ok: false, reason: "failed", errorCode: "LAUNCHER_NOT_READY", state: snapshot() };
        }
        const probe = await probeMcpHandshake({
          command: shimPath,
          args: ["mcp"],
          cwd: home,
          maskedPaths: [options.paths.runtimeRoot],
          timeoutMs: SELF_TEST_TIMEOUT_MS,
        });
        const outcome: AgentSelfTestOutcome = probe.ok ? "ok" : "failed";
        selfTest = { outcome, elapsedMs: probe.elapsedMs, ...(probe.ok ? {} : { code: probe.code }) };
        log(`[shell] agent self-test ${probe.ok ? "ok" : probe.code} (${probe.elapsedMs} ms)`);
        return probe.ok
          ? { ok: true, state: snapshot() }
          : { ok: false, reason: "failed", errorCode: probe.code, state: snapshot() };
      }),
  };
}
