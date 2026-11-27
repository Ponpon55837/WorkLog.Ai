import type {
  UsageAgent,
  UsageAllocation,
  UsageAllocationBasis,
  UsageBlockItem,
  UsageDayItem,
  UsageModelItem,
  UsageProjectGroup,
  UsageProjectItem,
  UsageProjectProblem,
  UsageRange,
  UsageScanRequest,
  UsageTokens,
  UsageTokenSummary,
} from "@work-intelligence/core";
import type { ChartTone } from "../components/ui/types";
import { toDateInputValue } from "./format";
import { t, type MessageKey } from "../i18n";

export const MAX_MANUAL_FOLDERS = 20;

export interface UsageScanControls {
  all: boolean;
  projectIds: readonly string[];
  range: UsageRange;
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

export const USAGE_TOKEN_TONES = {
  input: "accent",
  output: "done",
  cacheRead: "diagram-6",
  cacheCreation: "diagram-5",
} as const satisfies Record<keyof UsageTokens, ChartTone>;

/** Longest daily series drawn; a longer range keeps its most recent days. */
const MAX_DAILY_DAYS = 366;

const AGENT_KEYS = {
  "claude-code": "usage.agentClaudeCode",
  codex: "usage.agentCodex",
} as const satisfies Record<UsageAgent, MessageKey>;

interface UsageDailyPoint {
  date: string;
  input: number;
  output: number;
}

interface UsageCompositionRow {
  parts: { kind: keyof UsageTokens; value: number; share: number }[];
  total: number;
}

interface UsageComposition {
  counted: UsageCompositionRow;
  cache: UsageCompositionRow;
  cacheReadMultiple: number | null;
}

interface UsageModelRow {
  key: string;
  agentLabel: string;
  modelLabel: string;
  responses: number;
  tokens: UsageTokens;
  primary: number;
  share: number;
}

interface UsageBlockRow {
  agentLabel: string;
  startAt: string;
  endAt: string;
  primary: number;
  primaryPerMinute: number;
  elapsedMs: number;
  remainingMs: number;
  progress: number;
}

/** Agent display name: product names stay English in both languages. */
function usageAgentLabel(agent: UsageAgent): string {
  return t(AGENT_KEYS[agent]);
}

function compositionRow(entries: readonly (readonly [keyof UsageTokens, number])[]): UsageCompositionRow {
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  return {
    total,
    parts: entries.map(([kind, value]) => ({ kind, value, share: total > 0 ? value / total : 0 })),
  };
}

export function usageComposition(tokens: UsageTokenSummary): UsageComposition {
  return {
    counted: compositionRow([
      ["input", tokens.input],
      ["output", tokens.output],
    ]),
    cache: compositionRow([
      ["cacheRead", tokens.cacheRead],
      ["cacheCreation", tokens.cacheCreation],
    ]),
    cacheReadMultiple: tokens.primary > 0 ? tokens.cacheRead / tokens.primary : null,
  };
}

function parseLocalDay(day: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return undefined;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function fillDailyRange(
  daily: readonly UsageDayItem[],
  range: { since: string | null; until: string | null },
  now: Date = new Date(),
): UsageDailyPoint[] {
  const byDate = new Map(daily.map((item) => [item.date, item.tokens]));
  const dates = [...byDate.keys()].sort();
  const first = range.since ? new Date(range.since) : undefined;
  const last = range.until ? new Date(range.until) : now;
  const starts = [first && !Number.isNaN(first.getTime()) ? toDateInputValue(first) : undefined, dates[0]];
  const ends = [toDateInputValue(Number.isNaN(last.getTime()) ? now : last), dates[dates.length - 1]];
  const startDay = starts.filter((day): day is string => Boolean(day)).sort()[0];
  const endDay = ends
    .filter((day): day is string => Boolean(day))
    .sort()
    .at(-1);
  const start = startDay ? parseLocalDay(startDay) : undefined;
  const end = endDay ? parseLocalDay(endDay) : undefined;
  if (!start || !end || start > end) return [];

  const points: UsageDailyPoint[] = [];
  // Step by calendar day so a daylight-saving change never skips or repeats a date.
  let cursor = start;
  while (cursor <= end) {
    const date = toDateInputValue(cursor);
    const tokens = byDate.get(date);
    points.push({ date, input: tokens?.input ?? 0, output: tokens?.output ?? 0 });
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
  }
  return points.slice(-MAX_DAILY_DAYS);
}

export function usageDayLabel(date: string): string {
  return date.slice(5).replace("-", "/");
}

export function withRatio<T extends object>(
  items: readonly T[],
  valueOf: (item: T) => number,
): (T & { ratio: number })[] {
  const highest = items.reduce((top, item) => Math.max(top, valueOf(item)), 0);
  return items.map((item) => ({ ...item, ratio: highest > 0 ? valueOf(item) / highest : 0 }));
}

/** Each item with `share`, its value as a part of the sum of all values (0..1; 0 when the sum is 0). @internal test-only */
export function withShare<T extends object>(
  items: readonly T[],
  valueOf: (item: T) => number,
): (T & { share: number })[] {
  const total = items.reduce((sum, item) => sum + valueOf(item), 0);
  return items.map((item) => ({ ...item, share: total > 0 ? valueOf(item) / total : 0 }));
}

export function usageModelRows(models: readonly UsageModelItem[]): UsageModelRow[] {
  return withShare(
    models.map((model) => ({
      key: `${model.agent}:${model.model}`,
      agentLabel: usageAgentLabel(model.agent),
      modelLabel: model.model || t("usage.modelUnlabelled"),
      responses: model.responses,
      tokens: model.tokens,
      primary: model.primary,
    })),
    (row) => row.primary,
  );
}

/** Display values of the active 5-hour blocks. */
export function usageBlockRows(blocks: readonly UsageBlockItem[]): UsageBlockRow[] {
  return blocks.map((block) => {
    const span = block.elapsedMs + block.remainingMs;
    return {
      agentLabel: usageAgentLabel(block.agent),
      startAt: block.startAt,
      endAt: block.endAt,
      primary: block.primary,
      primaryPerMinute: block.primaryPerMinute,
      elapsedMs: block.elapsedMs,
      remainingMs: block.remainingMs,
      progress: span > 0 ? Math.min(1, Math.max(0, block.elapsedMs / span)) : 0,
    };
  });
}

interface UsageProjectSection {
  key: string;
  /** Every project id of the group, shown or not: the whole-group control selects all of them. */
  projectIds: string[];
  /** Project names joined for the group label; tracked project names only. */
  names: string;
  /** The group's projects not already listed in an earlier group. */
  members: UsageProjectItem[];
}

interface UsageProjectLayout {
  sections: UsageProjectSection[];
  /** Projects that share no source with another project. */
  loose: UsageProjectItem[];
}

interface UsageSharedProjectRow {
  projectId: string;
  name: string;
  included: boolean;
  conversations: number;
  primary: number;
  byBasis: Record<UsageAllocationBasis, number>;
}

interface UsageSharedGroupRow {
  key: string;
  /** Names of the group's projects, in the order of the project list. */
  names: string;
  included: boolean;
  conversations: number;
  primary: number;
  projects: UsageSharedProjectRow[];
}

/** Names of the given tracked projects in list order, e.g. `assistant, devtools, devdocs`; never a path. */
function usageGroupNames(ids: readonly string[], projects: readonly UsageProjectItem[]): string {
  const wanted = new Set(ids);
  return projects
    .filter((project) => wanted.has(project.id))
    .map((project) => project.name)
    .join(", ");
}

/**
 * Splits the project list into groups that share a source and the rest. Larger groups come first and a project is
 * listed once, under the first group that has it; a group's control still selects all of its projects.
 */
export function usageProjectLayout(
  projects: readonly UsageProjectItem[],
  groups: readonly UsageProjectGroup[],
): UsageProjectLayout {
  const shown = new Set<string>();
  const sections: UsageProjectSection[] = [];
  const ordered = [...groups].sort((a, b) => b.projects.length - a.projects.length);
  for (const [index, group] of ordered.entries()) {
    const inGroup = new Set(group.projects);
    const groupProjects = projects.filter((project) => inGroup.has(project.id));
    const members = groupProjects.filter((project) => !shown.has(project.id));
    for (const member of members) shown.add(member.id);
    if (members.length === 0) continue;
    sections.push({
      key: `group-${index}`,
      projectIds: groupProjects.map((project) => project.id),
      names: usageGroupNames(group.projects, projects),
      members,
    });
  }
  return { sections, loose: projects.filter((project) => !shown.has(project.id)) };
}

/** Selection after the whole-group control: every project of the group added, or all of them removed. */
export function toggleUsageGroup(selected: readonly string[], ids: readonly string[], checked: boolean): string[] {
  const group = new Set(ids);
  const others = selected.filter((id) => !group.has(id));
  return checked ? [...others, ...ids] : others;
}

/** Conversations of shared sources by group and project, with names from the tracked project list. */
export function usageSharedRows(
  allocation: UsageAllocation,
  projects: readonly UsageProjectItem[],
): UsageSharedGroupRow[] {
  const byId = new Map(projects.map((project) => [project.id, project]));
  return allocation.groups.map((group, index) => ({
    key: `shared-${index}`,
    names: usageGroupNames(group.projects, projects),
    included: group.unallocated.included,
    conversations: group.unallocated.conversations,
    primary: group.unallocated.primary,
    projects: group.allocated.map((entry) => ({
      projectId: entry.projectId,
      name: byId.get(entry.projectId)?.name ?? t("usage.unknownProject"),
      included: entry.included,
      conversations: entry.conversations,
      primary: entry.primary,
      byBasis: entry.byBasis,
    })),
  }));
}

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
