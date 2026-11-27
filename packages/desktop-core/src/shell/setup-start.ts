import type { DatabasePreviewResult } from "../backend/backend-supervisor.js";
import type { DatabaseIdentity } from "../db-source/types.js";
import { previewToCandidate } from "./candidates.js";
import { DATABASE_PATH_PROBLEM_MESSAGES, databasePathProblem } from "../settings/schema.js";
import type { RestartOutcome } from "./backend-recovery.js";
import type { ShellLocale } from "./i18n.js";
import type { SetupPhase } from "./setup-state.js";

const CREATE_FAILURE_CODES: Record<string, string> = { denied: "DB_PERMISSION", offline: "DB_OFFLINE" };
const ERROR_CODE_SHAPE = /^[A-Z][A-Z0-9_]{2,63}$/;

export type SetupStartResult =
  | { readonly kind: "started" }
  | { readonly kind: "held-back" }
  | { readonly kind: "busy" }
  | { readonly kind: "failed"; readonly errorCode: string };

export interface SetupStartInput {
  readonly databasePath: string;
  readonly override: unknown;
  readonly createNew: boolean;
  readonly startAnyway: boolean;
}

export interface SetupStartDeps {
  readonly nothingExistsAt: (path: string) => boolean;
  readonly legacyBlocks: (path: string) => Promise<boolean>;
  readonly allowLegacy: (path: string) => void;
  readonly prepareRuntime: () => Promise<unknown>;
  readonly missingParentDirectories: (path: string) => string[];
  readonly createDatabase: (path: string) => Promise<DatabasePreviewResult>;
  readonly removeCreatedDatabase: (path: string, identity: DatabaseIdentity, directories: readonly string[]) => boolean;
  readonly removeEmptyDirectories: (directories: readonly string[]) => void;
  readonly stageSettings: (path: string) => void;
  readonly start: (override: unknown) => Promise<RestartOutcome>;
  readonly stopBackend: () => Promise<void>;
  readonly commit: () => Promise<void>;
  readonly createdOverride: (path: string, identity: DatabaseIdentity) => unknown;
  readonly log: (line: string) => void;
}

export function canCreateNewDatabase(phase: SetupPhase): boolean {
  return phase === "ready";
}

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
      if (await deps.legacyBlocks(databasePath)) {
        deps.log("[shell] start held back: the old login service may use this database");
        return { kind: "held-back" };
      }
      await deps.prepareRuntime();
      const directories = deps.missingParentDirectories(databasePath);
      const result = await deps.createDatabase(databasePath);
      const preview = previewToCandidate(result);
      if (preview.status !== "ok" || !preview.identity) {
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
