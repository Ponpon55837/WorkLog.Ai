import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  filesLeftByTransaction,
  agentSetupJournalPath,
  applyAgentSetupTransaction,
  createAgentSetupPlan,
  describeAgentSetupMutations,
  findCheckoutRegistrations,
  inspectAgentHooks,
  inspectAgentRegistrations,
  projectCodexHooksRunFinalize,
  readClaudePluginEnabled,
  readCodexPluginHooksPresent,
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
  readCurrentContractFingerprint,
  readHostObservations,
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
import { configDirectory } from "@work-intelligence/shared/database-location";
import { runAgentOperation } from "./agent-operation.js";
import type { DesktopPaths } from "./config.js";
import type { Logger } from "./log.js";
import type { ShellState } from "./state.js";

export interface AgentsPage {
  snapshot(): AgentsState;
  preview(adopt: boolean, agents?: readonly SetupAgentId[]): Promise<AgentsActionResult>;
  previewRemove(): Promise<AgentsActionResult>;
  apply(previewId: string): Promise<AgentsActionResult>;
  discard(): AgentsActionResult;
  undo(): Promise<AgentsActionResult>;
  selfTest(): Promise<AgentsActionResult>;
  useCheckoutDatabase(agent: SetupAgentId): Promise<AgentsActionResult>;
  recover(): void;
}

export interface AgentsPageOptions {
  readonly state: ShellState;
  readonly coordinator: OperationCoordinator;
  readonly paths: Pick<DesktopPaths, "runtimeRoot">;
  readonly skillSourcePath: string;
  readonly log: Logger;
  readonly offerDatabase: (path: string) => Promise<void>;
}

const SELF_TEST_TIMEOUT_MS = 15_000;

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

  function planOptions(
    adopt: boolean,
    registrations: readonly CheckoutRegistration[],
    selected?: readonly SetupAgentId[],
  ): AgentSetupPlanOptions {
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
      repositoryRoot: roots[0] ?? home,
      target: { kind: "launcher", shimPath, skillSourcePath: options.skillSourcePath },
      platform,
      ...(selected ? { agents: selected } : {}),
      // Only entries on the App's own database are taken over: one Agent must not end up writing to two databases.
      ...(adopt && databasePath ? { adopt: { repositoryRoots: roots, databasePath } } : {}),
    };
  }

  function otherDatabaseOf(entries: readonly CheckoutRegistration[]): CheckoutRegistration | undefined {
    const other = entries.filter((entry) => entry.sameAsAppDatabase === false && entry.effectiveDatabase);
    return other.find((entry) => entry.kind === "mcp") ?? other[0];
  }

  function isDetected(id: SetupAgentId): boolean {
    const folder =
      id === "codex"
        ? process.env.CODEX_HOME?.trim() || join(home, ".codex")
        : process.env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
    return existsSync(folder) || (id === "claude-code" && existsSync(join(home, ".claude.json")));
  }

  function pluginBringsHooks(id: SetupAgentId): boolean {
    const folder =
      id === "codex"
        ? process.env.CODEX_HOME?.trim() || join(home, ".codex")
        : process.env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
    return id === "codex" ? readCodexPluginHooksPresent(folder) : readClaudePluginEnabled(folder);
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
    const observations = readHostObservations(configDirectory());
    const currentContractFingerprint = readCurrentContractFingerprint(options.paths.runtimeRoot);
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
        ...(observations[id] ? { observation: { contractFingerprint: observations[id].contractFingerprint } } : {}),
        ...(currentContractFingerprint ? { currentContractFingerprint } : {}),
      });
      return {
        id,
        state: status.state,
        nextStep: status.nextStep,
        mcp: ownerOf(mcp?.source),
        hooks: ownerOf(hook?.source),
        ...(handWritten.some((entry) => entry.duplicateOfLauncher) ? { duplicateOldHook: true as const } : {}),
        ...(id === "codex" &&
        hookInstallation?.state === "installed" &&
        projectCodexHooksRunFinalize([
          ...new Set(handWritten.flatMap((entry) => (entry.repositoryRoot ? [entry.repositoryRoot] : []))),
        ])
          ? { projectHooksNote: true as const }
          : {}),
        ...(hookInstallation ? { hookState: hookInstallation.state, hookSource: hookInstallation.source } : {}),
        // A global hook next to the plugin's own hooks would run the reminder twice.
        ...(hookInstallation?.state === "installed" &&
        (hookInstallation.source === "app" || hookInstallation.source === "checkout") &&
        pluginBringsHooks(id)
          ? { pluginHooksDuplicate: true as const }
          : {}),
        ...(firstRoot ? { checkoutDisplay: show(firstRoot) } : {}),
        detected: isDetected(id),
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
    preview: (adopt, selected) =>
      exclusive(() => {
        if (!launcherReady())
          return { ok: false, reason: "failed", errorCode: "LAUNCHER_NOT_READY", state: snapshot() };
        const plan = createAgentSetupPlan(planOptions(adopt, checkoutRegistrations(), selected), "install");
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
