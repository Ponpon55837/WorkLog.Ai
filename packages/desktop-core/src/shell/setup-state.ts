import { realpathSync } from "node:fs";
import path from "node:path";
import type { DbGroupStatus, DbSourceDecision, DbSourceGroup, DbSourceKind } from "../db-source/types.js";
import { canonicalInstallationPath } from "../integration/record.js";
import { canDisableLegacyService } from "../legacy-service/disable.js";
import { systemSettingsField, type SystemSettingsTarget } from "../legacy-service/system-settings.js";
import type { LegacyServiceDetection, LegacyServiceFound } from "../legacy-service/types.js";
import { canCreateNewDatabase } from "./setup-start.js";
import { storageBlocksUse } from "../db-source/storage-policy.js";
import { buildStorageRiskView, type StorageRiskView } from "./storage-risk-view.js";
import type { LaunchMode } from "./launch-mode.js";
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
  /** The old login service serves this database, or starts at the next login and then will: the page shows its warning. */
  readonly legacyConflict: boolean;
  /** The database is on a network drive, a removable disk, a cloud-sync folder, a hard link, or an unknown disk (DT-08). */
  readonly storageRisk?: StorageRiskView;
}

export interface SetupLegacyView {
  readonly running: "running" | "stopped" | "unknown";
  /** It is not running now but starts at the next login. */
  readonly startsAtLogin: boolean;
  /** 「停用舊的登入服務」 is offered (see `canDisableLegacyService`). */
  readonly canDisable: boolean;
  readonly databaseDisplay?: string;
  /** Where the App opens for the user to turn the service off by hand; absent where it has no such place. */
  readonly systemSettings?: SystemSettingsTarget;
}

export interface SetupState {
  readonly locale: ShellLocale;
  readonly phase: SetupPhase;
  readonly screen: SetupScreen;
  /** Why the user has to choose. */
  readonly reason?: "multiple-distinct" | "conflict" | "unverifiable" | "blocked" | "risky-storage";
  readonly defaults: {
    readonly databaseDisplay: string;
    readonly url: string;
    readonly backupDisplay: string;
    readonly launchAtLogin: boolean;
    /** The old login service serves, or at the next login will serve, the default database. */
    readonly legacyConflict: boolean;
  };
  /** The database the first button uses on the `existing` screen. */
  readonly recommendedId?: string;
  readonly sources: readonly SetupSourceView[];
  readonly legacy: SetupLegacyView | null;
  /**
   * "使用預設設定開始" may be used. It is false while the detection runs, so a new database is never created before the
   * user could see what was found.
   */
  readonly canUseDefaults: boolean;
  /** The database the user browsed to cannot be used (network share, device path, not absolute): the reason, in the page's language. */
  readonly pathProblem?: string;
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
  /** The reason the last browsed path was refused, already in the page's language. */
  readonly pathProblem?: string;
  readonly busy: boolean;
  /** The user browsed to a database of their own: the page lists everything to choose from. */
  readonly chosen?: boolean;
}

/** Resolves the real path, or for a database that does not exist yet its real folder plus the file name. */
function resolveExisting(value: string, platform: NodeJS.Platform, realpath: (value: string) => string): string {
  const api = platform === "win32" ? path.win32 : path.posix;
  const direct = canonicalInstallationPath(value, platform, realpath);
  if (direct !== value || !api.isAbsolute(value)) return direct;
  // The database may not exist yet: resolve the folder it will be in (a symlinked or 8.3 parent still compares equal).
  const parent = api.dirname(value);
  if (parent === value) return value;
  const resolvedParent = canonicalInstallationPath(parent, platform, realpath);
  return resolvedParent === parent ? value : api.join(resolvedParent, api.basename(value));
}

/**
 * The form two database paths are compared in: symlinks and Windows short names resolved with `realpathSync.native`
 * (the helper the integration record uses), a path that does not exist yet by its folder, then separators and trailing
 * slashes normalised. Windows and macOS compare case-insensitively (NTFS, and the default APFS volume); Linux does not.
 */
export function canonicalDatabasePath(
  value: string,
  platform: NodeJS.Platform,
  realpath: (value: string) => string = realpathSync.native,
): string {
  const resolved = resolveExisting(value, platform, realpath);
  const normalised =
    platform === "win32" ? resolved.replaceAll("/", "\\").replace(/\\+$/, "") : resolved.replace(/\/+$/, "");
  return platform === "win32" || platform === "darwin" ? normalised.toLowerCase() : normalised;
}

/** Whether the detected service uses this database; a definition that cannot be read counts as the same one. */
function usesDatabase(
  detection: LegacyServiceFound,
  databasePath: string,
  platform: NodeJS.Platform,
  realpath: ((value: string) => string) | undefined,
): boolean {
  if (!detection.recognised || detection.databasePath === undefined) return true;
  return (
    canonicalDatabasePath(detection.databasePath, platform, realpath) ===
    canonicalDatabasePath(databasePath, platform, realpath)
  );
}

function foundService(detection: LegacyServiceDetection | null): LegacyServiceFound | null {
  return detection?.kind === "found" ? detection : null;
}

/**
 * Whether the old login service (`pnpm service:install`) may be serving the database the App is about to open: it is
 * installed, not known to be stopped, and its database is that one, or cannot be read from its definition (an
 * unrecognised definition counts as the same, because two backends on one database must never happen silently).
 */
export function legacyServiceConflicts(
  detection: LegacyServiceDetection | null,
  databasePath: string,
  platform: NodeJS.Platform,
  realpath?: (value: string) => string,
): boolean {
  const service = foundService(detection);
  if (!service || service.running === "stopped") return false;
  return usesDatabase(service, databasePath, platform, realpath);
}

/**
 * What the status views warn about: a service that serves the database now, or one that is stopped but enabled, which
 * starts at the next login. A stopped service whose autostart is disabled or unknown is not warned about.
 */
export function legacyServiceWarns(
  detection: LegacyServiceDetection | null,
  databasePath: string,
  platform: NodeJS.Platform,
  realpath?: (value: string) => string,
): boolean {
  const service = foundService(detection);
  if (!service) return false;
  if (service.running === "stopped" && service.enabled !== "enabled") return false;
  return usesDatabase(service, databasePath, platform, realpath);
}

/**
 * What a start on `databasePath` does about the old login service:
 * - `start`: nothing to hold back (no service, another database, a stale definition, or the user said "仍要啟動").
 * - `hold-active`: its backend may answer right now (running or not known to be stopped); wait for "仍要啟動".
 * - `hold-login`: a login (background) start while it is stopped but enabled: it starts at login too, and the App can
 *   win that race, so the App stays out of the way until "仍要啟動".
 * An interactive start with a stopped but enabled service starts, with the persistent warning.
 */
export type LegacyStartDecision = "start" | "hold-active" | "hold-login";

export function decideLegacyStart(inputs: {
  readonly detection: LegacyServiceDetection | null;
  readonly databasePath: string;
  readonly platform: NodeJS.Platform;
  readonly launchMode: LaunchMode;
  /** The user already said "仍要啟動" for this database in this run. */
  readonly allowed: boolean;
  readonly realpath?: (value: string) => string;
}): LegacyStartDecision {
  const { detection, databasePath, platform, realpath } = inputs;
  if (inputs.allowed) return "start";
  if (legacyServiceConflicts(detection, databasePath, platform, realpath)) return "hold-active";
  if (
    inputs.launchMode === "background" &&
    foundService(detection)?.enabled === "enabled" &&
    legacyServiceWarns(detection, databasePath, platform, realpath)
  ) {
    return "hold-login";
  }
  return "start";
}

/** Where the old login service matters to the repair page, if anywhere. */
export interface LegacyServiceRelevance {
  /** It serves the App's database, or starts at the next login and then will (see {@link legacyServiceWarns}). */
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
  const conflict = inputs.databasePath !== null && legacyServiceWarns(detection, inputs.databasePath, inputs.platform);
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
  const show = (value: string): string => displayPath(value, inputs.homeDirectory, inputs.platform);
  const legacy = inputs.legacy?.kind === "found" ? inputs.legacy : null;
  const conflicts = (databasePath: string): boolean => legacyServiceWarns(inputs.legacy, databasePath, inputs.platform);
  const riskOf = (source: SetupSourceInput): StorageRiskView | undefined =>
    buildStorageRiskView({
      risk: source.group.storageRisk?.risk,
      locale: inputs.locale,
      chosenByUser: source.group.kinds.includes("explicit-selection"),
      needsMigration: source.needsMigration,
    });
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
    sources: inputs.sources.map((source) => {
      const storageRisk = riskOf(source);
      return {
        id: source.id,
        display: show(source.group.absolutePath),
        status: source.group.status,
        kinds: source.group.kinds,
        ...(source.group.preview.projectCount === undefined ? {} : { projectCount: source.group.preview.projectCount }),
        projectNames: source.projectNames,
        canUse: source.canUse && !storageBlocksUse(source.group.storageRisk?.risk, source.needsMigration),
        needsMigration: source.needsMigration,
        ...(source.errorCode ? { errorCode: source.errorCode } : {}),
        legacyConflict: conflicts(source.group.absolutePath),
        ...(storageRisk ? { storageRisk } : {}),
      };
    }),
    legacy: legacy
      ? {
          running: legacy.running,
          startsAtLogin: legacy.running === "stopped" && legacy.enabled === "enabled",
          canDisable: canDisableLegacyService(legacy),
          ...(legacy.databasePath === undefined ? {} : { databaseDisplay: show(legacy.databasePath) }),
          ...systemSettingsField(legacy.platform),
        }
      : null,
    canUseDefaults: canCreateNewDatabase(inputs.phase),
    ...(inputs.pathProblem ? { pathProblem: inputs.pathProblem } : {}),
    ...(inputs.errorCode ? { errorCode: inputs.errorCode } : {}),
    busy: inputs.busy,
  };
}
