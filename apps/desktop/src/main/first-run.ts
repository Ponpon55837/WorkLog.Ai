import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { dialog } from "electron";
import { findCheckoutRegistrations } from "@work-intelligence/agent-setup";
import {
  buildSetupState,
  collectDbCandidates,
  missingParentDirectories,
  previewToCandidate,
  removeCreatedDatabase,
  removeEmptyDirectories,
  resolveDbSource,
  type BackendSupervisor,
  type CandidatePreview,
  type DatabaseIdentity,
  type DatabasePreviewResult,
  type DbProbeResult,
  type DbSourceDecision,
  type DbSourceGroup,
  type EnvironmentSource,
  type LegacyServiceDetection,
  type SetupActionResult,
  type SetupPhase,
  type SetupSourceInput,
  type SetupState,
} from "@work-intelligence/desktop-core";
import type { BackendController, StartOverride } from "./backend.js";
import type { DesktopPaths } from "./config.js";
import type { LegacyGuard } from "./legacy.js";
import type { Logger } from "./log.js";
import type { RepairWindow } from "./repair-window.js";
import { applyLoginItem, commitSettings, defaultSettings } from "./settings.js";
import type { ShellState } from "./state.js";

/**
 * The first-run page (DT-01). Detection is read-only: the old login service, hand-written Agent registrations and the
 * standard locations are collected, and every database found is previewed by one short-lived child that opens it
 * read-only. Nothing is written until the user picks; the settings file is written only after the start with that
 * choice worked, so a failed start leaves the App exactly as unconfigured as before.
 */
export interface FirstRun {
  /** Starts the detection once; later calls return the same run. */
  begin(): Promise<void>;
  snapshot(): SetupState;
  useDefaults(launchAtLogin: boolean, startAnyway: boolean): Promise<SetupActionResult>;
  useSource(input: {
    readonly sourceId: string;
    readonly launchAtLogin: boolean;
    readonly allowMigration?: boolean;
    readonly startAnyway?: boolean;
  }): Promise<SetupActionResult>;
  chooseFile(): Promise<SetupActionResult>;
  /** "稍後再說": the window closes and the tray keeps "完成首次設定…". */
  later(): void;
  /** Milliseconds the last detection took (diagnostics and the performance gate). */
  readonly detectionMs: number | undefined;
}

export interface FirstRunOptions {
  readonly state: ShellState;
  readonly paths: DesktopPaths;
  readonly supervisor: BackendSupervisor;
  readonly backend: BackendController;
  readonly legacy: LegacyGuard;
  readonly window: RepairWindow;
  readonly log: Logger;
  /** The runtime the preview child needs; installs the bundled one in a packaged App. */
  readonly prepareRuntime: () => Promise<unknown>;
  /** A start from this page worked: open the Dashboard once. */
  readonly onStarted: () => void;
  readonly environment: NodeJS.ProcessEnv;
  /** The port of a new default setup; the product default unless a test build overrides it. */
  readonly defaultPort?: number;
}

interface SourceEntry {
  readonly input: SetupSourceInput;
  readonly path: string;
  readonly preview: CandidatePreview;
}

const MAX_PROJECT_NAMES = 5;

/** What a failed creation of the new database reports when the child gave no code of its own. */
const CREATE_FAILURE_CODES: Record<string, string> = { denied: "DB_PERMISSION", offline: "DB_OFFLINE" };

/** True only when nothing at all (not even a dangling symlink) exists at the path. */
function nothingExistsAt(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    return (error as { code?: unknown } | null)?.code === "ENOENT";
  }
}

/** What the resolver needs from one preview: the statuses stay as the child reported them. */
function probeResultFrom(result: DatabasePreviewResult | undefined): DbProbeResult {
  if (!result) return { status: "unreadable", detail: "not previewed" };
  if (result.outcome === "failed") return { status: "unreadable", detail: result.code };
  const { preflight } = result;
  return {
    status: preflight.status,
    ...(preflight.identity ? { identity: preflight.identity } : {}),
    ...(preflight.schemaVersion === undefined ? {} : { schemaVersion: preflight.schemaVersion }),
    ...(preflight.projectCount === undefined ? {} : { projectCount: preflight.projectCount }),
  };
}

function projectNamesFrom(result: DatabasePreviewResult | undefined): readonly string[] {
  if (!result || result.outcome !== "checked") return [];
  return (result.preflight.projectNames ?? []).slice(0, MAX_PROJECT_NAMES);
}

function legacySources(detection: LegacyServiceDetection): EnvironmentSource[] {
  if (detection.kind !== "found" || !detection.databasePath) return [];
  return [
    {
      label: detection.definitionPath,
      environment: { WORK_INTELLIGENCE_DB: detection.databasePath },
      resolutionBase: detection.repositoryRoot ?? homedir(),
      managedByCurrentUser: true,
    },
  ];
}

function agentSources(log: Logger): EnvironmentSource[] {
  try {
    return findCheckoutRegistrations({ homeDirectory: homedir(), repositoryRoot: homedir() })
      .filter((entry) => entry.kind === "mcp" && entry.effectiveDatabase)
      .map((entry) => ({
        label: entry.location,
        environment: { WORK_INTELLIGENCE_DB: entry.effectiveDatabase },
        resolutionBase: entry.repositoryRoot ?? homedir(),
        managedByCurrentUser: true,
      }));
  } catch (error) {
    log(`[shell] first-run: Agent registrations unreadable: ${error instanceof Error ? error.name : "unknown"}`);
    return [];
  }
}

export function createFirstRun(options: FirstRunOptions): FirstRun {
  const { state, paths, supervisor, backend, legacy, window, log } = options;
  const defaults = defaultSettings(false, options.defaultPort);
  let phase: SetupPhase = "detecting";
  let decision: DbSourceDecision | null = null;
  let sources: SourceEntry[] = [];
  let chosen = false;
  let errorCode: string | undefined;
  let busy = false;
  let detection: Promise<void> | undefined;
  let detectionMs: number | undefined;

  function entryFor(group: DbSourceGroup, result: DatabasePreviewResult | undefined): SourceEntry {
    const preview = result ? previewToCandidate(result) : { status: "unreadable" as const, needsMigration: false };
    const canUse = preview.status === "ok" && preview.identity !== undefined;
    return {
      path: group.absolutePath,
      preview,
      input: {
        id: randomUUID(),
        group,
        projectNames: projectNamesFrom(result),
        canUse,
        needsMigration: canUse && preview.needsMigration,
        ...(preview.errorCode ? { errorCode: preview.errorCode } : {}),
      },
    };
  }

  async function detect(): Promise<void> {
    const started = Date.now();
    // The three reads do not depend on each other; the runtime is needed only by the preview child.
    const [found, agents] = await Promise.all([
      legacy.refresh(),
      Promise.resolve().then(() => agentSources(log)),
      options.prepareRuntime(),
    ]);
    const candidates = collectDbCandidates({
      platform: process.platform,
      environment: options.environment,
      home: homedir(),
      serviceDefinitions: legacySources(found),
      agentMcpConfigs: agents,
    });
    const distinct = [
      ...new Set(candidates.filter((entry) => !entry.invalidReason).map((entry) => entry.absolutePath)),
    ];
    const previews = new Map<string, DatabasePreviewResult>();
    try {
      const results = await supervisor.previewMany(distinct);
      distinct.forEach((path, index) => {
        const result = results[index];
        if (result) previews.set(path, result);
      });
    } catch (error) {
      log(`[shell] first-run preview failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    const resolution = await resolveDbSource({
      candidates,
      platform: process.platform,
      probe: async (path) => probeResultFrom(previews.get(path)),
    });
    decision = resolution.decision;
    // A database that is not there is not something to choose; the defaults button covers a new one.
    sources = resolution.groups
      .filter((group) => group.probeStatus !== "missing")
      .map((group) => entryFor(group, previews.get(group.absolutePath)));
    phase = "ready";
    detectionMs = Date.now() - started;
    log(
      `[shell] first-run detection ${decision.kind} sources=${sources.length} previews=${distinct.length} (${detectionMs} ms)`,
    );
    state.touch();
  }

  function begin(): Promise<void> {
    detection ??= detect().catch((error: unknown) => {
      log(`[shell] first-run detection failed: ${error instanceof Error ? error.message : "unknown error"}`);
      decision = null;
      sources = [];
      phase = "ready";
      state.touch();
    });
    return detection;
  }

  function snapshot(): SetupState {
    return buildSetupState({
      locale: state.locale,
      platform: process.platform,
      homeDirectory: homedir(),
      phase,
      decision,
      sources: sources.map((entry) => entry.input),
      defaults: {
        databasePath: defaults.desired.databasePath,
        port: defaults.desired.port,
        backupDirectory: defaults.desired.backupDirectory,
        launchAtLogin: defaults.desired.launchAtLogin,
      },
      legacy: legacy.latest(),
      ...(errorCode ? { errorCode } : {}),
      busy,
      chosen,
    });
  }

  /** Back to UNCONFIGURED with nothing committed; the page shows `reason`. */
  function failSetup(): void {
    state.settings = null;
    state.setOwner("UNCONFIGURED");
    phase = "ready";
  }

  async function startWith(
    databasePath: string,
    override: StartOverride | undefined,
    launchAtLogin: boolean,
    startAnyway: boolean,
    createNew = false,
  ): Promise<SetupActionResult> {
    if (busy || !state.needsSetup) return { ok: false, reason: "busy" };
    busy = true;
    phase = "starting";
    errorCode = undefined;
    state.touch();
    // What this attempt created, so a failed start can take back exactly that and nothing else.
    let created: { identity: DatabaseIdentity; directories: string[] } | undefined;
    const rollback = (): void => {
      if (!created) return;
      const { identity, directories } = created;
      created = undefined;
      if (removeCreatedDatabase(databasePath, identity, directories)) {
        log("[shell] first-run removed the database it created after a failed start");
      }
    };
    try {
      if (startAnyway) legacy.allow(databasePath);
      const base = defaultSettings(launchAtLogin, options.defaultPort);
      state.settings = { ...base, desired: { ...base.desired, databasePath } };
      let startOverride = override;
      if (createNew && nothingExistsAt(databasePath)) {
        // The held-back check comes first: a start the old login service blocks must not leave a new database behind.
        if (await legacy.blocks(databasePath)) {
          log("[shell] start held back: the old login service may use this database");
          failSetup();
          return { ok: false, reason: "legacy-service", state: snapshot() };
        }
        await options.prepareRuntime();
        const directories = missingParentDirectories(databasePath);
        const result = await supervisor.createDatabase(databasePath);
        const preview = previewToCandidate(result);
        if (preview.status !== "ok" || !preview.identity) {
          // The child removes a file it could not initialise; the directories it made are ours to take back.
          removeEmptyDirectories(directories);
          const code = preview.errorCode ?? CREATE_FAILURE_CODES[preview.status] ?? "REPAIR_REQUIRED";
          failSetup();
          errorCode = code;
          log(`[shell] first-run could not create the database: ${code}`);
          return { ok: false, reason: "failed", errorCode: code, state: snapshot() };
        }
        created = { identity: preview.identity, directories };
        startOverride = { databasePath, expectedIdentity: preview.identity, allowSchemaMigration: false };
      }
      let outcome: Awaited<ReturnType<BackendController["start"]>>;
      try {
        outcome = await backend.start("takeover", startOverride);
      } catch (error) {
        rollback();
        throw error;
      }
      if (outcome.ok) {
        created = undefined;
        await commitSettings(state, paths);
        applyLoginItem(state);
        phase = "done";
        log("[shell] first-run setup finished");
        options.onStarted();
        return { ok: true, state: snapshot() };
      }
      rollback();
      // Nothing is committed: no settings file, and the owner goes back to UNCONFIGURED, not NEEDS_REPAIR.
      failSetup();
      if (outcome.busy) return { ok: false, reason: "busy", state: snapshot() };
      if (outcome.code === "LEGACY_SERVICE_ACTIVE") return { ok: false, reason: "legacy-service", state: snapshot() };
      errorCode = outcome.code;
      log(`[shell] first-run start failed: ${outcome.code}`);
      return { ok: false, reason: "failed", errorCode: outcome.code, state: snapshot() };
    } finally {
      busy = false;
      state.touch();
    }
  }

  return {
    begin,
    snapshot,
    get detectionMs() {
      return detectionMs;
    },
    useDefaults: async (launchAtLogin, startAnyway) => {
      await begin();
      return startWith(defaults.desired.databasePath, undefined, launchAtLogin, startAnyway, true);
    },
    useSource: async ({ sourceId, launchAtLogin, allowMigration, startAnyway }) => {
      const entry = sources.find((source) => source.input.id === sourceId);
      if (!entry?.input.canUse || !entry.preview.identity) return { ok: false, reason: "invalid" };
      if (entry.input.needsMigration && allowMigration !== true) return { ok: false, reason: "invalid" };
      return startWith(
        entry.path,
        {
          databasePath: entry.path,
          expectedIdentity: entry.preview.identity,
          allowSchemaMigration: entry.input.needsMigration,
        },
        launchAtLogin,
        startAnyway === true,
      );
    },
    chooseFile: async () => {
      if (busy) return { ok: false, reason: "busy" };
      const owner = window.window();
      if (!owner) return { ok: false, reason: "failed" };
      const picked = await dialog.showOpenDialog(owner, {
        properties: ["openFile"],
        filters: [{ name: "SQLite", extensions: ["sqlite", "sqlite3", "db"] }],
      });
      const file = picked.filePaths[0];
      if (picked.canceled || !file) return { ok: false, reason: "cancelled" };
      busy = true;
      state.touch();
      try {
        await options.prepareRuntime();
        const [result] = await supervisor.previewMany([file]);
        const probe = probeResultFrom(result);
        const group: DbSourceGroup = {
          id: randomUUID(),
          candidates: [],
          kinds: ["explicit-selection"],
          status: probe.status,
          probeStatus: probe.status,
          identity: probe.identity ?? null,
          preview: { schemaVersion: probe.schemaVersion, projectCount: probe.projectCount },
          absolutePath: file,
        };
        sources = [...sources.filter((source) => source.path !== file), entryFor(group, result)];
        chosen = true;
        return { ok: true, state: snapshot() };
      } catch (error) {
        log(`[shell] first-run browse failed: ${error instanceof Error ? error.message : "unknown error"}`);
        return { ok: false, reason: "failed" };
      } finally {
        busy = false;
        state.touch();
      }
    },
    later: () => {
      log("[shell] first-run setup postponed");
      window.close();
    },
  };
}
