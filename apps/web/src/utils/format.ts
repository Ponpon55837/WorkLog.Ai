import type { WorkReport } from "@work-intelligence/core";

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-TW", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function formatReadableSummary(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (!normalized) {
    return "";
  }

  return normalized
    .replace(/\s+Status signals\s*:/i, "\n\nStatus signals:\n")
    .replace(/\s*\|\s*/g, "\n")
    .replace(
      /(pending-backend-contract|pendingbackend|Reverted|blocked|completed|complete|pending)(?=[A-Za-z#])/gi,
      "$1\n",
    )
    .replace(/(^|\n)\s*#{1,6}\s*/gm, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function toDateInputValue(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function startOfMonth(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), 1);
}

function formatReportDay(value: string): string {
  const [, month = "", day = ""] = value.split("-");
  return `${month}/${day}`;
}

export function formatReportTrendLabel(value: string, granularity: WorkReport["trendGranularity"]): string {
  if (granularity === "month") {
    const [year = "", month = ""] = value.split("-");
    return `${year}/${month}`;
  }
  return formatReportDay(value);
}

/** Keeps the end of a label (e.g. the deepest folders of a path) within `maxDisplayUnits`. */
export function graphNodeLabelTail(value: string, maxDisplayUnits = 25): string {
  const reversed = [...value].reverse().join("");
  const truncated = graphNodeLabel(reversed, maxDisplayUnits);
  return truncated === reversed ? value : `…${[...truncated.slice(0, -1)].reverse().join("")}`;
}

/** Truncates a graph label to `maxDisplayUnits` (CJK characters count as 2 units). */
export function graphNodeLabel(value: string, maxDisplayUnits = 25): string {
  let displayUnits = 0;
  let label = "";
  for (const character of value) {
    // The null-to-extended-ASCII range is intentional: it estimates display width for graph labels.
    // eslint-disable-next-line no-control-regex
    const characterUnits = /[^\u0000-\u00ff]/u.test(character) ? 2 : 1;
    if (displayUnits + characterUnits > maxDisplayUnits) {
      return `${label}…`;
    }
    label += character;
    displayUnits += characterUnits;
  }
  return label;
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/** "12 分鐘前" / "昨天 18:40" / "9月20日" — pair with a title tooltip carrying formatDate(). */
export function formatRelative(value: string, now = new Date()): string {
  const date = new Date(value);
  const diffMinutes = Math.round((now.getTime() - date.getTime()) / 60_000);
  if (diffMinutes < 1) {
    return "剛剛";
  }
  if (diffMinutes < 60) {
    return `${diffMinutes} 分鐘前`;
  }
  const time = new Intl.DateTimeFormat("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  const dayDiff = dayIndex(now) - dayIndex(date);
  if (dayDiff === 0) {
    return `${Math.round(diffMinutes / 60)} 小時前`;
  }
  if (dayDiff === 1) {
    return `昨天 ${time}`;
  }
  const sameYear = date.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(
    "zh-TW",
    sameYear ? { month: "short", day: "numeric" } : { dateStyle: "medium" },
  ).format(date);
}

function dayIndex(date: Date): number {
  return Math.floor(new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / 86_400_000);
}

/** Group label for date-grouped lists: 今天 / 昨天 / 9月20日（週六）. */
export function formatDayGroup(value: string, now = new Date()): string {
  const date = new Date(value);
  const dayDiff = dayIndex(now) - dayIndex(date);
  if (dayDiff === 0) {
    return "今天";
  }
  if (dayDiff === 1) {
    return "昨天";
  }
  const sameYear = date.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(
    "zh-TW",
    sameYear ? { month: "long", day: "numeric", weekday: "short" } : { dateStyle: "long" },
  ).format(date);
}

/** Elapsed time between two ISO instants, e.g. 「1 天 3 小時」「45 分鐘」; empty when the order is reversed. */
export function formatDuration(from: string, to: string): string {
  const minutes = Math.round((Date.parse(to) - Date.parse(from)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 0) {
    return "";
  }
  if (minutes < 1) {
    return "不到 1 分鐘";
  }
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const rest = minutes % 60;
  const parts = [days ? `${days} 天` : "", hours ? `${hours} 小時` : "", !days && rest ? `${rest} 分鐘` : ""];
  return parts.filter(Boolean).join(" ");
}

/** A Session counts as updated when it changed more than a minute after it was finalized. */
export function wasUpdatedAfterFinalize(session: { createdAt: string; updatedAt: string }): boolean {
  return Date.parse(session.updatedAt) - Date.parse(session.createdAt) > 60_000;
}
