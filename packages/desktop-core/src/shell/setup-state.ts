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

export type SetupScreen = "new" | "existing" | "choose";

export type SetupPhase = "detecting" | "ready" | "starting" | "done";

export interface SetupSourceView {
  readonly id: string;
  readonly display: string;
  readonly status: DbGroupStatus | "unknown";
  readonly kinds: readonly DbSourceKind[];
  readonly projectCount?: number;
  readonly projectNames: readonly string[];
  readonly canUse: boolean;
  readonly needsMigration: boolean;
  readonly errorCode?: string;
  readonly legacyConflict: boolean;
  readonly storageRisk?: StorageRiskView;
}

export interface SetupLegacyView {
  readonly running: "running" | "stopped" | "unknown";
  readonly startsAtLogin: boolean;
  readonly canDisable: boolean;
  readonly databaseDisplay?: string;
  readonly systemSettings?: SystemSettingsTarget;
}

export interface SetupState {
  readonly locale: ShellLocale;
  readonly phase: SetupPhase;
  readonly screen: SetupScreen;
  readonly reason?: "multiple-distinct" | "conflict" | "unverifiable" | "blocked" | "risky-storage";
  readonly defaults: {
    readonly databaseDisplay: string;
    readonly url: string;
    readonly backupDisplay: string;
    readonly launchAtLogin: boolean;
    readonly legacyConflict: boolean;
  };
  readonly recommendedId?: string;
  readonly sources: readonly SetupSourceView[];
  readonly legacy: SetupLegacyView | null;
  /** False while detection runs, so a new database is never created before the user could see what was found. */
  readonly canUseDefaults: boolean;
  readonly pathProblem?: string;
  readonly errorCode?: string;
  readonly busy: boolean;
}

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
  readonly pathProblem?: string;
  readonly busy: boolean;
  readonly chosen?: boolean;
}

function resolveExisting(value: string, platform: NodeJS.Platform, realpath: (value: string) => string): string {
  const api = platform === "win32" ? path.win32 : path.posix;
  const direct = canonicalInstallationPath(value, platform, realpath);
  if (direct !== value || !api.isAbsolute(value)) return direct;
  const parent = api.dirname(value);
  if (parent === value) return value;
  const resolvedParent = canonicalInstallationPath(parent, platform, realpath);
  return resolvedParent === parent ? value : api.join(resolvedParent, api.basename(value));
}

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

/** An unreadable definition counts as the same database: two backends on one database must never happen silently. */
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

export type LegacyStartDecision = "start" | "hold-active" | "hold-login";

export function decideLegacyStart(inputs: {
  readonly detection: LegacyServiceDetection | null;
  readonly databasePath: string;
  readonly platform: NodeJS.Platform;
  readonly launchMode: LaunchMode;
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

export interface LegacyServiceRelevance {
  readonly conflict: boolean;
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
