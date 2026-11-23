import type {
  UsageCostShares,
  UsageProjectProblem,
  UsageRange,
  UsageScanRequest,
  UsageTokens,
} from "@work-intelligence/core";
import type { Tone } from "../components/ui/types";
import { t, type MessageKey } from "../i18n";

export const MAX_MANUAL_FOLDERS = 20;

interface UsageScanControls {
  all: boolean;
  projectIds: readonly string[];
  range: UsageRange;
  /** `YYYY-MM-DD` values of the date inputs, used when range is custom. */
  since: string;
  until: string;
  manualFolders: readonly string[];
}

const PROBLEM_KEYS = {
  "claude-dir-missing": "usage.problemClaudeDirMissing",
  "codex-dir-missing": "usage.problemCodexDirMissing",
  "permission-denied": "usage.problemPermissionDenied",
  "none-found": "usage.problemNoneFound",
} as const satisfies Record<UsageProjectProblem, MessageKey>;

const ERROR_KEYS: Record<string, MessageKey> = {
  usage_timeout: "usage.errorTimeout",
  usage_cancelled: "usage.errorCancelled",
  usage_failed: "usage.errorFailed",
};

/** The token kinds in display order, with the tone each one uses in the cost bar. */
export const USAGE_TOKEN_KINDS: ReadonlyArray<{
  kind: keyof UsageTokens & keyof UsageCostShares;
  label: MessageKey;
  tone: Tone;
}> = [
  { kind: "input", label: "usage.tokenInput", tone: "accent" },
  { kind: "cacheCreation", label: "usage.tokenCacheCreation", tone: "attention" },
  { kind: "cacheRead", label: "usage.tokenCacheRead", tone: "success" },
  { kind: "output", label: "usage.tokenOutput", tone: "done" },
];

/** Plain-language explanation of a per-project source problem. */
export function usageProblemMessage(problem: UsageProjectProblem): string {
  return t(PROBLEM_KEYS[problem]);
}

/** Maps a server error code (usage_timeout, usage_cancelled, usage_failed) to an explanation; unknown codes get a generic one. */
export function usageErrorMessage(code: string | undefined): string {
  return t((code && ERROR_KEYS[code]) || "usage.errorGeneric");
}

/** Local start of the first day and end of the last day, as ISO instants; an empty or invalid date gives undefined. */
function localDayBoundary(day: string, end: boolean): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const date = new Date(`${day}T${end ? "23:59:59.999" : "00:00:00.000"}`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Builds the POST body; manual folders are trimmed and empty ones dropped. */
export function buildUsageScanRequest(controls: UsageScanControls): UsageScanRequest {
  const manualFolders = controls.manualFolders.map((folder) => folder.trim()).filter(Boolean);
  const since = controls.range === "custom" ? localDayBoundary(controls.since, false) : undefined;
  const until = controls.range === "custom" ? localDayBoundary(controls.until, true) : undefined;
  return {
    ...(controls.all ? { all: true } : { projectIds: [...controls.projectIds] }),
    ...(manualFolders.length > 0 ? { manualFolders } : {}),
    range: controls.range,
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
  };
}

/** True when a scan has something to read: a chosen project, All projects, or a manual folder. */
export function canScanUsage(controls: UsageScanControls): boolean {
  return controls.all || controls.projectIds.length > 0 || controls.manualFolders.some((folder) => folder.trim());
}
