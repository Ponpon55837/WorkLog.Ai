import type { ApiErrorCode, WorkReport } from "@work-intelligence/core";
import { intlLocale, t, translatedRecord, type MessageKey } from "../i18n";

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat(intlLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

/** Local time of day (e.g. 下午6:32), for lists already grouped by date. */
export function formatTimeOfDay(value: string): string {
  return new Intl.DateTimeFormat(intlLocale(), { hour: "numeric", minute: "2-digit" }).format(new Date(value));
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

const apiErrorMessages: Record<string, string> = translatedRecord({
  invalid_input: "format.theInputIsInvalidCheck",
  not_found: "format.theRequestedDataWasNot",
  conflict: "format.theDataChangedRefreshAnd",
  payload_too_large: "format.theDataExceedsTheSize",
  unsupported_media_type: "format.theRequestFormatIsNot",
  host_not_allowed: "format.theRequestHostIsNot",
  origin_not_allowed: "format.theRequestOriginIsNot",
  service_unavailable: "format.theServiceIsTemporarilyUnavailable",
  project_not_found: "format.projectNotFoundRefreshThe",
  invalid_bundle: "format.theImportFileIsInvalid",
  unsupported_schema: "format.theImportFileSData",
  invalid_project_deletion_confirmation: "format.theDeletionConfirmationIsInvalid",
  project_location_confirmation_required: "format.beforeRelocatingATrackedProject",
  project_location_conflict: "format.theNewFolderOverlapsAnother",
  project_location_invalid: "format.chooseAFolderThatExists",
  backup_unavailable: "format.backupsAreUnavailableRightNow",
  database_busy: "format.theDatabaseIsBusyPlease",
  PROJECT_NOT_FOUND: "format.thisProjectWasNotFound",
  PROJECT_NAME_MISMATCH: "format.theNameDoesNotMatch",
  PROJECT_BACKUP_FAILED: "format.couldNotCreateAndVerify",
  PROJECT_DELETE_FAILED: "format.theDeletionDidNotFinish",
  SESSION_NOT_FOUND: "format.sessionNotFoundRefresh",
  SESSION_NOT_VOIDED: "format.onlyVoidedSessionsCanBeDeleted",
  SESSION_CITED_BY_PENDING_CLEANUP: "format.sessionCitedByPendingCleanup",
  SESSION_BACKUP_FAILED: "format.couldNotBackUpBeforeSessionDeletion",
  SESSION_DELETE_FAILED: "format.sessionDeletionDidNotFinish",
  network_error: "common.cannotReachTheLocalApi",
  malformed_response: "common.theApiResponseWasMalformed",
} satisfies Partial<Record<ApiErrorCode | "network_error" | "malformed_response", MessageKey>>);

export function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "code" in error && "status" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") {
      return apiErrorMessages[code] ?? fallback;
    }
  }
  return error instanceof Error ? error.message : fallback;
}

/** "12 分鐘前" / "昨天 18:40" / "9月20日" — pair with a title tooltip carrying formatDate(). */
export function formatRelative(value: string, now = new Date()): string {
  const date = new Date(value);
  const diffMinutes = Math.round((now.getTime() - date.getTime()) / 60_000);
  if (diffMinutes < 1) {
    return t("format.justNow");
  }
  if (diffMinutes < 60) {
    return t("format.minutesAgo", { diffMinutes });
  }
  const time = new Intl.DateTimeFormat(intlLocale(), { hour: "2-digit", minute: "2-digit", hour12: false }).format(
    date,
  );
  const dayDiff = dayIndex(now) - dayIndex(date);
  if (dayDiff === 0) {
    return t("format.hoursAgo", { value: Math.round(diffMinutes / 60) });
  }
  if (dayDiff === 1) {
    return t("format.yesterday", { time });
  }
  const sameYear = date.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(
    intlLocale(),
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
    return t("common.today");
  }
  if (dayDiff === 1) {
    return t("common.yesterday");
  }
  const sameYear = date.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(
    intlLocale(),
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
    return t("format.under1Minute");
  }
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const rest = minutes % 60;
  const parts = [
    days ? t("format.durationDays", { days }) : "",
    hours ? t("format.durationHours", { hours }) : "",
    !days && rest ? t("format.durationMinutes", { rest }) : "",
  ];
  return parts.filter(Boolean).join(" ");
}

/** A Session counts as updated when it changed more than a minute after it was finalized. */
export function wasUpdatedAfterFinalize(session: { createdAt: string; updatedAt: string }): boolean {
  return Date.parse(session.updatedAt) - Date.parse(session.createdAt) > 60_000;
}

/** File sizes in the largest unit that keeps the number at least 1 (B, KB, MB, GB). */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/** Weekday name for the current locale (週日 / Sun); `narrow` gives 日 in Chinese and stays short in English. */
export function weekdayLabel(date: Date, utc = false, width: "short" | "narrow" = "short"): string {
  const weekday = width === "narrow" && intlLocale() !== "zh-TW" ? "short" : width;
  return new Intl.DateTimeFormat(intlLocale(), { weekday, ...(utc ? { timeZone: "UTC" } : {}) }).format(date);
}
