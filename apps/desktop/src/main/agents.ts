import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import {
  agentSetupJournalPath,
  applyAgentSetupTransaction,
  createAgentSetupPlan,
  describeAgentSetupMutations,
  findCheckoutRegistrations,
  inspectAgentRegistrations,
  readAgentSetupJournal,
  recoverAgentSetupJournal,
  undoAgentSetupOperation,
  type AgentSetupPlan,
  type AgentSetupPlanOptions,
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
  type SetupAgentId,
} from "@work-intelligence/desktop-core";
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
  apply(previewId: string): Promise<AgentsActionResult>;
  discard(): AgentsActionResult;
  undo(): Promise<AgentsActionResult>;
  selfTest(): Promise<AgentsActionResult>;
  /** Finishes an apply or undo a crash left half done; called once at start-up. */
  recover(): void;
}

export interface AgentsPageOptions {
  readonly state: ShellState;
  readonly paths: Pick<DesktopPaths, "runtimeRoot">;
  /** The canonical `work-intelligence` SKILL.md the App ships. */
  readonly skillSourcePath: string;
  readonly log: Logger;
}

const SELF_TEST_TIMEOUT_MS = 15_000;

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
      return findCheckoutRegistrations({ homeDirectory: home, repositoryRoot: home, platform });
    } catch {
      return [];
    }
  }

  function planOptions(adopt: boolean, registrations: readonly CheckoutRegistration[]): AgentSetupPlanOptions {
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
      ...(adopt ? { adopt: { repositoryRoots: roots } } : {}),
    };
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
    return SETUP_AGENT_IDS.map((id: SetupAgentId): AgentCardView => {
      const mcp = inspection.registrations.find((entry) => entry.agent === id && entry.kind === "mcp");
      const hook = inspection.registrations.find((entry) => entry.agent === id && entry.kind === "hook");
      const handWritten = checkout.filter((entry) => entry.agent === id && !entry.owned);
      const firstRoot = handWritten.find((entry) => entry.repositoryRoot)?.repositoryRoot;
      const notRecognised = handWritten.find((entry) => !entry.recognised);
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
        ...(firstRoot ? { checkoutDisplay: show(firstRoot) } : {}),
        checkoutMissing: handWritten.some((entry) => entry.repositoryRoot !== undefined && !entry.rootExists),
        adoptable: handWritten.length > 0 && notRecognised === undefined,
        ...(notRecognised?.reason ? { notAdoptableReason: notRecognised.reason } : {}),
      };
    });
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
        const id = randomUUID();
        const view: AgentsPreview = {
          id,
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
        pending = { id, plan, view };
        result = null;
        log(`[shell] agent setup preview adopt=${adopt} files=${view.files.length} conflicts=${view.conflicts.length}`);
        return { ok: true, state: snapshot() };
      }),
    apply: (previewId) =>
      exclusive(() => {
        if (!pending || pending.id !== previewId) return { ok: false, reason: "invalid", state: snapshot() };
        if (pending.plan.conflicts.length > 0) return { ok: false, reason: "invalid", state: snapshot() };
        const { plan } = pending;
        pending = null;
        const applied = applyAgentSetupTransaction(plan, { journalPath });
        log(`[shell] agent setup apply ${applied.outcome}${applied.code ? ` ${applied.code}` : ""}`);
        if (applied.outcome === "committed") {
          result = { kind: "applied", changed: plan.mutations.length };
          selfTest = { outcome: "not-run" };
          return { ok: true, state: snapshot() };
        }
        result = { kind: "failed", code: applied.code ?? applied.outcome };
        return { ok: false, reason: "failed", errorCode: applied.code ?? applied.outcome, state: snapshot() };
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
