import type { ServerResponse } from "node:http";
import type { ProjectRecord, UsageProjectItem, UsageProjectsResponse } from "@work-intelligence/core";
import { usageScanRequestSchema } from "@work-intelligence/schema";
import {
  UsageScanAbortedError,
  UsageScanTimeoutError,
  type UsageProjectInput,
} from "@work-intelligence/shared/agent-usage";
import { readJsonBody, sendError, sendJson } from "../http.js";
import { isScannableFolder } from "../usage-scan.js";
import { buildUsageResponse } from "../usage-response.js";
import { parseRequestInput, type Route, type RouteContext } from "./router.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const RANGE_DAYS = { "7d": 7, "30d": 30 } as const;

function trackedProjects(context: RouteContext): ProjectRecord[] {
  return context.store.listProjects().filter((project) => project.status === "tracked");
}

function toInput(project: ProjectRecord): UsageProjectInput {
  return { id: project.id, name: project.name, root: project.rootPath };
}

function abortOnClose(response: ServerResponse): AbortController {
  const controller = new AbortController();
  response.on("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  return controller;
}

function currentProjectId(projects: readonly ProjectRecord[]): string | undefined {
  let current: ProjectRecord | undefined;
  for (const project of projects) {
    if (project.lastIngestedAt && (!current?.lastIngestedAt || project.lastIngestedAt > current.lastIngestedAt)) {
      current = project;
    }
  }
  return current?.id;
}

function localeOf(context: RouteContext): "en" | "zh-TW" {
  const header = context.request.headers["accept-language"];
  return typeof header === "string" && /^\s*zh/i.test(header) ? "zh-TW" : "en";
}

/** The messages are fixed, so no path or log text can leak. */
function sendUsageError(response: ServerResponse, error: unknown): void {
  if (response.headersSent || response.destroyed) return;
  if (error instanceof UsageScanAbortedError) {
    sendError(response, 499, "用量掃描已取消。", undefined, "usage_cancelled");
  } else if (error instanceof UsageScanTimeoutError) {
    sendError(response, 504, "用量掃描逾時；請縮小時間範圍或專案後再試。", undefined, "usage_timeout");
  } else {
    console.error("[work-intelligence] usage scan failed");
    sendError(response, 500, "無法讀取 Agent 用量。", undefined, "usage_failed");
  }
}

async function listUsageProjects(context: RouteContext): Promise<void> {
  const { response, services } = context;
  const projects = trackedProjects(context);
  const controller = abortOnClose(response);
  try {
    const found = await services.usage.sources(projects.map(toInput), controller.signal);
    const byId = new Map(found.projects.map((entry) => [entry.projectId, entry]));
    const current = currentProjectId(projects);
    const items: UsageProjectItem[] = projects.map((project) => {
      const entry = byId.get(project.id);
      return {
        id: project.id,
        name: project.name,
        current: project.id === current,
        sources: { claudeFolders: entry?.claudeFolders ?? 0, codexFiles: entry?.codexFiles ?? 0 },
        ...(entry?.problem ? { problem: entry.problem } : {}),
      };
    });
    const groups = found.groups.map((group) => ({
      projects: group.projectIds,
      claudeFolders: group.claudeFolders,
      codexFiles: group.codexFiles,
    }));
    sendJson(response, 200, { items, groups } satisfies UsageProjectsResponse);
  } catch (error) {
    sendUsageError(response, error);
  }
}

async function scanUsage(context: RouteContext): Promise<void> {
  const { response, services } = context;
  const parsed = parseRequestInput(usageScanRequestSchema, await readJsonBody(context.request));
  if (!parsed.success) {
    sendError(response, 400, "用量掃描的請求格式錯誤。", parsed.error.flatten());
    return;
  }
  const body = parsed.data;
  const manualFolders = body.manualFolders ?? [];
  if (!manualFolders.every(isScannableFolder)) {
    sendError(response, 400, "手動加入的資料夾必須是絕對路徑。");
    return;
  }
  const now = Date.now();
  const since = body.range === "custom" ? body.since : new Date(now - RANGE_DAYS[body.range] * DAY_MS).toISOString();
  const until = body.range === "custom" ? body.until : undefined;
  if (since && until && Date.parse(since) > Date.parse(until)) {
    sendError(response, 400, "開始時間不可晚於結束時間。");
    return;
  }
  const tracked = trackedProjects(context);
  const wanted = body.all ? undefined : new Set(body.projectIds ?? []);
  const projects = tracked.filter((project) => !wanted || wanted.has(project.id));
  if (projects.length === 0 && manualFolders.length === 0) {
    sendError(response, 400, "請至少選擇一個記錄中的專案或資料夾。");
    return;
  }
  const controller = abortOnClose(response);
  try {
    const outcome = await services.usage.scan(
      {
        projects: projects.map(toInput),
        allProjects: tracked.map(toInput),
        manualFolders,
        ...(since ? { since } : {}),
        ...(until ? { until } : {}),
      },
      controller.signal,
    );
    sendJson(
      response,
      200,
      buildUsageResponse(outcome.report, {
        problems: outcome.problems,
        projectNames: projects.map((project) => project.name),
        projectNamesById: Object.fromEntries(tracked.map((project) => [project.id, project.name])),
        range: { since: since ?? null, until: until ?? null },
        durationMs: Date.now() - now,
        locale: localeOf(context),
      }),
    );
  } catch (error) {
    sendUsageError(response, error);
  }
}

export const usageRoutes: readonly Route[] = [
  { method: "GET", pattern: "/api/usage/projects", handler: listUsageProjects },
  { method: "POST", pattern: "/api/usage/scan", handler: scanUsage },
];
