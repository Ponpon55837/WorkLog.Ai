import type {
  ChangedFileChangeStatus,
  ChangedFileSource,
  GraphNode,
  KnowledgeAuditAction,
  ProjectStatus,
  ReportEvidence,
  ReportPeriod,
  WorkSummarySections
} from "@work-intelligence/core";
import { knowledgeKindVisual, knowledgeStatusVisual, trackingStatus, type StatusVisual } from "./status";

function labelsOf<K extends string>(visuals: Record<K, StatusVisual>): Record<K, string> {
  return Object.fromEntries(Object.entries<StatusVisual>(visuals).map(([key, visual]) => [key, visual.label])) as Record<K, string>;
}

/** Label-only views of the status maps in utils/status.ts (single source of truth). */
export const statusLabels = labelsOf(trackingStatus);
export const knowledgeKindLabels = labelsOf(knowledgeKindVisual);
export const knowledgeStatusLabels = labelsOf(knowledgeStatusVisual);

export const listPageSizeOptions = [
  { value: 10, label: "10" },
  { value: 20, label: "20" },
  { value: 50, label: "50" },
  { value: 100, label: "100" },
  { value: "all", label: "All" }
] as const;
export type ListPageSize = (typeof listPageSizeOptions)[number]["value"];

export function pageSizeToQuery(value: ListPageSize): number {
  return value === "all" ? 0 : value;
}

export type ReportTab = "overview" | "work" | "trend" | "risks" | "raw" | "evidence";
export const reportTabOptions: Array<{ id: ReportTab; label: string; shortLabel: string }> = [
  { id: "overview", label: "報告總覽", shortLabel: "總覽" },
  { id: "work", label: "完成與驗證", shortLabel: "工作" },
  { id: "trend", label: "趨勢與專案", shortLabel: "趨勢" },
  { id: "risks", label: "風險與決策", shortLabel: "風險" },
  { id: "raw", label: "原始工作紀錄", shortLabel: "原始紀錄" },
  { id: "evidence", label: "來源證據", shortLabel: "證據" }
];

export const workSummarySectionLabels: Array<{ key: keyof WorkSummarySections; label: string }> = [
  { key: "outcomes", label: "成果" },
  { key: "scope", label: "範圍" },
  { key: "decisions", label: "決策" },
  { key: "verification", label: "驗證" },
  { key: "nextSteps", label: "狀態／未結項" }
];

export const statusDescriptions: Record<ProjectStatus, string> = {
  unregistered: "尚未授權，所有 ingest 都會略過。",
  tracked: "明確授權；可讀取 handoff 並保存工作紀錄。",
  paused: "暫停記錄，既有資料保留。",
  ignored: "明確排除，不會建立新的工作資料。"
};

export const changedFileSourceLabels: Record<ChangedFileSource, string> = {
  agent: "Agent",
  handoff: "Handoff",
  git: "Git",
  worktree: "工作樹"
};

export const changedFileChangeStatusLabels: Record<ChangedFileChangeStatus, string> = {
  added: "新增",
  modified: "修改",
  deleted: "刪除",
  renamed: "重新命名"
};

export const reportPeriodLabels: Record<ReportPeriod, string> = {
  day: "今日",
  week: "本週",
  month: "本月",
  quarter: "本季",
  year: "本年"
};

export const insightKindLabels: Record<"verification" | "metadata" | "event", string> = {
  verification: "Verification",
  metadata: "Metadata",
  event: "Event"
};

export const evidenceKindLabels: Record<ReportEvidence["kind"], string> = {
  handoff: "Handoff",
  verification: "Verification",
  "changed-files": "Changed files",
  event: "Event",
  attached: "Attached evidence"
};

export const knowledgeAuditActionLabels: Record<KnowledgeAuditAction, string> = {
  created: "建立",
  updated: "更新",
  archived: "封存",
  restored: "恢復"
};

export const graphNodeKindOrder = ["project", "session", "knowledge", "evidence", "file"] as const;

export const graphNodeKindLabels: Record<GraphNode["kind"], string> = {
  project: "專案",
  session: "工作 Session",
  knowledge: "工作知識",
  evidence: "證據",
  file: "變更檔案"
};

export const graphEdgeKindLabels = {
  contains: "包含",
  changed_file: "變更檔案",
  has_knowledge: "關聯知識",
  has_evidence: "附加證據"
} as const;

export const graphMetadataLabels: Record<string, string> = {
  rootPath: "專案根目錄",
  status: "記錄狀態",
  completedAt: "完成時間",
  changedFilesCount: "變更檔案",
  verification: "Verification",
  kind: "資料類型",
  tagsCount: "標籤數量",
  reference: "參考位置",
  capturedAt: "擷取時間",
  path: "檔案路徑"
};
