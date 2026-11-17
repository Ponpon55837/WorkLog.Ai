import type { DbGroupStatus, DbSourceDecision, DbSourceGroup, DbSourceKind } from "../db-source/types.js";
import type { LegacyServiceDetection } from "../legacy-service/types.js";
import type { ShellLocale } from "./i18n.js";
import { displayPath } from "./repair-state.js";

/**
 * The first-run page (DT-01): what main found, read-only, and what the user may choose. Like the repair page it holds
 * no real path; sources are named by opaque ids main hands out.
 */

/** `new`: nothing found, start with the defaults. `existing`: one consistent database, use it. `choose`: the user picks. */
export type SetupScreen = "new" | "existing" | "choose";

export type SetupPhase = "detecting" | "ready" | "starting" | "done";

export interface SetupSourceView {
  /** Opaque id; the only thing the page sends back. */
  readonly id: string;
  readonly display: string;
  readonly status: DbGroupStatus | "unknown";
  /** Where this database was found (the App's environment, the old login service, an Agent, the defaults). */
  readonly kinds: readonly DbSourceKind[];
  readonly projectCount?: number;
  readonly projectNames: readonly string[];
  readonly canUse: boolean;
  /** Using it also updates its schema; the page asks for explicit consent first. */
  readonly needsMigration: boolean;
  /** The preview could not run: the backend error code. */
  readonly errorCode?: string;
  /** The old login service may serve this database: using it needs the user's explicit "仍要啟動". */
  readonly legacyConflict: boolean;
}

export interface SetupLegacyView {
  readonly running: "running" | "stopped" | "unknown";
  readonly recognised: boolean;
  readonly databaseDisplay?: string;
  /** `cd … && pnpm service:uninstall` (PowerShell form on Windows), when the checkout is known. */
  readonly removeCommand?: string;
  readonly fallbackRemoveCommand: string;
}

export interface SetupState {
  readonly locale: ShellLocale;
  readonly phase: SetupPhase;
  readonly screen: SetupScreen;
  /** Why the user has to choose. */
  readonly reason?: "multiple-distinct" | "conflict" | "unverifiable" | "blocked";
  readonly defaults: {
    readonly databaseDisplay: string;
    readonly url: string;
    readonly backupDisplay: string;
    readonly launchAtLogin: boolean;
    /** The old login service may serve the default database. */
    readonly legacyConflict: boolean;
  };
  /** The database the first button uses on the `existing` screen. */
  readonly recommendedId?: string;
  readonly sources: readonly SetupSourceView[];
  readonly legacy: SetupLegacyView | null;
  /** The last start from this page failed; the page shows the message of this code and stays. */
  readonly errorCode?: string;
  readonly busy: boolean;
}

/** One detected database as main keeps it: the group, the id handed to the page, and what its preview allows. */
export interface SetupSourceInput {
  readonly id: string;
  readonly group: DbSourceGroup;
  readonly projectNames: readonly string[];
  readonly canUse: boolean;
  readonly needsMigration: boolean;
  readonly errorCode?: string;
}

export interface SetupStateInputs {
  readonly locale: ShellLocale;
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly phase: SetupPhase;
  readonly decision: DbSourceDecision | null;
  readonly sources: readonly SetupSourceInput[];
  readonly defaults: {
    readonly databasePath: string;
    readonly port: number;
    readonly backupDirectory: string;
    readonly launchAtLogin: boolean;
  };
  readonly legacy: LegacyServiceDetection | null;
  readonly errorCode?: string;
  readonly busy: boolean;
  /** The user browsed to a database of their own: the page lists everything to choose from. */
  readonly chosen?: boolean;
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const normalize = (value: string) =>
    platform === "win32" ? value.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase() : value.replace(/\/+$/, "");
  return normalize(a) === normalize(b);
}

/**
 * Whether the old login service (`pnpm service:install`) may serve the database the App is about to open: it is
 * installed, not known to be stopped, and its database is that one, or cannot be read from its definition (an
 * unrecognised definition counts as the same, because two backends on one database must never happen silently).
 */
export function legacyServiceConflicts(
  detection: LegacyServiceDetection | null,
  databasePath: string,
  platform: NodeJS.Platform,
): boolean {
  if (!detection || detection.kind !== "found") return false;
  if (detection.running === "stopped") return false;
  if (!detection.recognised || detection.databasePath === undefined) return true;
  return samePath(detection.databasePath, databasePath, platform);
}

/** Where the old login service matters to the repair page, if anywhere. */
export interface LegacyServiceRelevance {
  /** It may serve the App's database. */
  readonly conflict: boolean;
  /** The last start found the port taken and the old service is on that port (or its port cannot be told). */
  readonly portInUse: boolean;
}

export function legacyServiceRelevance(inputs: {
  readonly detection: LegacyServiceDetection | null;
  readonly databasePath: string | null;
  readonly port: number | null;
  readonly latestErrorCode: string | undefined;
  readonly platform: NodeJS.Platform;
}): LegacyServiceRelevance {
  const { detection } = inputs;
  if (!detection || detection.kind !== "found") return { conflict: false, portInUse: false };
  const conflict =
    inputs.databasePath !== null && legacyServiceConflicts(detection, inputs.databasePath, inputs.platform);
  const portInUse =
    inputs.latestErrorCode === "PORT_OCCUPIED_BY_OTHER" &&
    detection.running !== "stopped" &&
    (detection.port === undefined || detection.port === inputs.port);
  return { conflict, portInUse };
}

/** The screen for a decision; a group the user cannot use never becomes the recommended one. */
function screenFor(
  decision: DbSourceDecision | null,
  sources: readonly SetupSourceInput[],
): Pick<SetupState, "screen" | "reason" | "recommendedId"> {
  if (!decision || decision.kind === "offer-new-database") return { screen: "new" };
  if (decision.kind === "use") {
    const source = sources.find((entry) => entry.group.id === decision.group.id);
    if (source?.canUse) return { screen: "existing", recommendedId: source.id };
    return { screen: "choose", reason: "unverifiable" };
  }
  if (decision.kind === "blocked") return { screen: "choose", reason: "blocked" };
  return { screen: "choose", reason: decision.reason };
}

/** Builds the page's snapshot; real paths are masked here, as on the repair page. */
export function buildSetupState(inputs: SetupStateInputs): SetupState {
  const show = (path: string): string => displayPath(path, inputs.homeDirectory, inputs.platform);
  const legacy = inputs.legacy?.kind === "found" ? inputs.legacy : null;
  const conflicts = (path: string): boolean => legacyServiceConflicts(inputs.legacy, path, inputs.platform);
  return {
    locale: inputs.locale,
    phase: inputs.phase,
    ...(inputs.chosen
      ? { screen: "choose" as const, reason: "multiple-distinct" as const }
      : screenFor(inputs.decision, inputs.sources)),
    defaults: {
      databaseDisplay: show(inputs.defaults.databasePath),
      url: `http://127.0.0.1:${inputs.defaults.port}`,
      backupDisplay: show(inputs.defaults.backupDirectory),
      launchAtLogin: inputs.defaults.launchAtLogin,
      legacyConflict: conflicts(inputs.defaults.databasePath),
    },
    sources: inputs.sources.map((source) => ({
      id: source.id,
      display: show(source.group.absolutePath),
      status: source.group.status,
      kinds: source.group.kinds,
      ...(source.group.preview.projectCount === undefined ? {} : { projectCount: source.group.preview.projectCount }),
      projectNames: source.projectNames,
      canUse: source.canUse,
      needsMigration: source.needsMigration,
      ...(source.errorCode ? { errorCode: source.errorCode } : {}),
      legacyConflict: conflicts(source.group.absolutePath),
    })),
    legacy: legacy
      ? {
          running: legacy.running,
          recognised: legacy.recognised,
          ...(legacy.databasePath === undefined ? {} : { databaseDisplay: show(legacy.databasePath) }),
          ...(legacy.removeCommand === undefined ? {} : { removeCommand: legacy.removeCommand }),
          fallbackRemoveCommand: legacy.fallbackRemoveCommand,
        }
      : null,
    ...(inputs.errorCode ? { errorCode: inputs.errorCode } : {}),
    busy: inputs.busy,
  };
}
