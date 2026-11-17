import type { DatabasePreviewResult } from "../backend/backend-supervisor.js";
import type { DatabaseIdentity } from "../db-source/types.js";
import { previewToCandidate } from "./candidates.js";
import { DATABASE_PATH_PROBLEM_MESSAGES, databasePathProblem } from "../settings/schema.js";
import type { RestartOutcome } from "./backend-recovery.js";
import type { ShellLocale } from "./i18n.js";
import type { SetupPhase } from "./setup-state.js";

/**
 * The start behind every button of the first-run page. It only decides and sequences; every effect (files, the
 * child process, settings) comes in through {@link SetupStartDeps}, so the unit tests run it without Electron.
 */

/** What a failed creation of the new database reports when the child gave no code of its own. */
const CREATE_FAILURE_CODES: Record<string, string> = { denied: "DB_PERMISSION", offline: "DB_OFFLINE" };
const ERROR_CODE_SHAPE = /^[A-Z][A-Z0-9_]{2,63}$/;

export type SetupStartResult =
  | { readonly kind: "started" }
  /** The old login service may serve (or, at login, will serve) the database: nothing was created or started. */
  | { readonly kind: "held-back" }
  | { readonly kind: "busy" }
  | { readonly kind: "failed"; readonly errorCode: string };

export interface SetupStartInput {
  readonly databasePath: string;
  /** The database the user confirmed (an existing one); absent for the defaults, which may create one. */
  readonly override: unknown;
  /** The defaults button: create the database when nothing is there yet. */
  readonly createNew: boolean;
  readonly startAnyway: boolean;
}

export interface SetupStartDeps {
  /** True only when nothing at all (not even a dangling symlink) exists at the path. */
  readonly nothingExistsAt: (path: string) => boolean;
  /** The old login service holds this start back (see `LegacyGuard.blocks`). */
  readonly legacyBlocks: (path: string) => Promise<boolean>;
  readonly allowLegacy: (path: string) => void;
  readonly prepareRuntime: () => Promise<unknown>;
  readonly missingParentDirectories: (path: string) => string[];
  readonly createDatabase: (path: string) => Promise<DatabasePreviewResult>;
  readonly removeCreatedDatabase: (path: string, identity: DatabaseIdentity, directories: readonly string[]) => boolean;
  readonly removeEmptyDirectories: (directories: readonly string[]) => void;
  /** Puts the chosen database into the in-memory settings the start reads. */
  readonly stageSettings: (path: string) => void;
  /** One managed start; `override` is the input's override, or the one for the database this call created. */
  readonly start: (override: unknown) => Promise<RestartOutcome>;
  /** Stops the backend a start left running when a later step failed. */
  readonly stopBackend: () => Promise<void>;
  /** Writes the settings file and applies the login item. */
  readonly commit: () => Promise<void>;
  readonly createdOverride: (path: string, identity: DatabaseIdentity) => unknown;
  readonly log: (line: string) => void;
}

/**
 * "使用預設設定開始" creates a database, so it is allowed only once the detection is done: before that the user has
 * not seen what was found, and an existing database would be left next to a new empty one.
 */
export function canCreateNewDatabase(phase: SetupPhase): boolean {
  return phase === "ready";
}

/**
 * Why a database the user browsed to is refused before any preview opens it (a network share, a device path, a path
 * that is not absolute), in the page's language; undefined when the path may be previewed.
 */
export function chosenPathProblem(file: string, platform: NodeJS.Platform, locale: ShellLocale): string | undefined {
  const problem = databasePathProblem(file, platform);
  return problem === undefined ? undefined : DATABASE_PATH_PROBLEM_MESSAGES[problem][locale];
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && ERROR_CODE_SHAPE.test(code) ? code : "REPAIR_REQUIRED";
}

export async function runSetupStart(input: SetupStartInput, deps: SetupStartDeps): Promise<SetupStartResult> {
  const { databasePath } = input;
  // What this attempt created, so a failed or thrown start takes back exactly that and nothing else.
  let created: { identity: DatabaseIdentity; directories: string[] } | undefined;
  let backendStarted = false;
  const rollback = (): void => {
    if (!created) return;
    const { identity, directories } = created;
    created = undefined;
    if (deps.removeCreatedDatabase(databasePath, identity, directories)) {
      deps.log("[shell] first-run removed the database it created after a failed start");
    }
  };
  try {
    if (input.startAnyway) deps.allowLegacy(databasePath);
    deps.stageSettings(databasePath);
    let override = input.override;
    if (input.createNew && deps.nothingExistsAt(databasePath)) {
      // The held-back check comes first: a start the old login service blocks must not leave a new database behind.
      if (await deps.legacyBlocks(databasePath)) {
        deps.log("[shell] start held back: the old login service may use this database");
        return { kind: "held-back" };
      }
      await deps.prepareRuntime();
      const directories = deps.missingParentDirectories(databasePath);
      const result = await deps.createDatabase(databasePath);
      const preview = previewToCandidate(result);
      if (preview.status !== "ok" || !preview.identity) {
        // The child removes a file it could not initialise; the directories it made are ours to take back.
        deps.removeEmptyDirectories(directories);
        const code = preview.errorCode ?? CREATE_FAILURE_CODES[preview.status] ?? "REPAIR_REQUIRED";
        deps.log(`[shell] first-run could not create the database: ${code}`);
        return { kind: "failed", errorCode: code };
      }
      created = { identity: preview.identity, directories };
      override = deps.createdOverride(databasePath, preview.identity);
    }
    const outcome = await deps.start(override);
    if (!outcome.ok) {
      rollback();
      if (outcome.busy) return { kind: "busy" };
      if (outcome.code === "LEGACY_SERVICE_ACTIVE") return { kind: "held-back" };
      deps.log(`[shell] first-run start failed: ${outcome.code}`);
      return { kind: "failed", errorCode: outcome.code };
    }
    backendStarted = true;
    await deps.commit();
    created = undefined;
    deps.log("[shell] first-run setup finished");
    return { kind: "started" };
  } catch (error) {
    const code = codeOf(error);
    deps.log(`[shell] first-run start threw: ${error instanceof Error ? error.name : "unknown"} (${code})`);
    if (backendStarted) await deps.stopBackend().catch(() => undefined);
    rollback();
    return { kind: "failed", errorCode: code };
  }
}
