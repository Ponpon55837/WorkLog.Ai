import type { ReportMetricComparison, WorkReport } from "@work-intelligence/core";

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-TW", {
    dateStyle: "medium",
    timeStyle: "short"
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
    .replace(/(pending-backend-contract|pendingbackend|Reverted|blocked|completed|complete|pending)(?=[A-Za-z#])/gi, "$1\n")
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

export function parseDateInputValue(value: string): Date {
  const [year = "1970", month = "1", day = "1"] = value.split("-");
  return new Date(Number(year), Number(month) - 1, Number(day));
}

export function startOfMonth(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), 1);
}

export function displayDate(value: string): string {
  if (!value) {
    return "選擇日期";
  }

  const [year, month, day] = value.split("-");
  return `${year}/${month}/${day}`;
}

export function eventDetails(value: Record<string, unknown> | undefined): string {
  return value ? JSON.stringify(value) : "";
}

export function formatKnowledgeTags(tags: string[]): string {
  return tags.map((tag) => `#${tag}`).join(" · ");
}

export function formatReportDelta(comparison: ReportMetricComparison): string {
  if (comparison.direction === "flat") {
    return "與上一期相同";
  }
  return `${comparison.delta > 0 ? "+" : ""}${comparison.delta} · 上期 ${comparison.previous}`;
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

export function reportTrendHeight(value: number, reportValue: WorkReport): string {
  const max = Math.max(
    1,
    ...reportValue.trends.map((point) => Math.max(point.sessions, point.events))
  );
  return `${value ? Math.max(12, Math.round((value / max) * 100)) : 4}%`;
}

export function shouldShowTrendLabel(index: number, total: number): boolean {
  return total <= 14 || index === 0 || index === total - 1 || index % Math.ceil(total / 7) === 0;
}

export function graphNodeLabel(value: string): string {
  const maxDisplayUnits = 25;
  let displayUnits = 0;
  let label = "";
  for (const character of value) {
    // The null-to-extended-ASCII range is intentional: it estimates display width for graph labels.
    // eslint-disable-next-line no-control-regex
    const characterUnits = /[^\u0000-ÿ]/u.test(character) ? 2 : 1;
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
