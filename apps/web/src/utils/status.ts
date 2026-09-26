import {
  Check,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleSlash,
  CircleX,
  Clock3,
  FileQuestion,
  Folder,
  FolderGit2,
  FolderX,
  GraduationCap,
  ListOrdered,
  LoaderCircle,
  Scale,
  Shapes,
  TriangleAlert,
} from "lucide-vue-next";
import type {
  DatabaseInspectionState,
  DatabaseMaintenanceStatus,
  KnowledgeKind,
  KnowledgeStatus,
  MetadataBackfillRequest,
  ProjectStatus,
  ReportSynthesisRequest,
  ReportVerificationStatus,
} from "@work-intelligence/core";
import type { IconComponent, Tone } from "../components/ui/types";

/**
 * Single source of truth for status → tone/icon/label.
 * Rules come from .agents/skills/worklog-ui/references/tokens.md#status-mapping and domain-semantics.md.
 */
export type StatusVisual = { tone: Tone; icon?: IconComponent; label: string };

export type RequestStatus = ReportSynthesisRequest["status"] | MetadataBackfillRequest["status"];
export type MetadataGapKind = "changed_files" | "verification_missing" | "verification_not_run";

export const databaseInspectionStatus: Record<DatabaseInspectionState, StatusVisual> = {
  ok: { tone: "success", icon: CircleCheck, label: "正常" },
  missing: { tone: "attention", icon: CircleAlert, label: "不存在" },
  unhealthy: { tone: "danger", icon: CircleX, label: "異常" },
  unreadable: { tone: "danger", icon: CircleAlert, label: "無法讀取" },
};

export const databaseMaintenanceStatus: Record<DatabaseMaintenanceStatus, StatusVisual> = {
  running: { tone: "accent", icon: LoaderCircle, label: "執行中" },
  completed: { tone: "success", icon: CircleCheck, label: "成功" },
  failed: { tone: "danger", icon: CircleX, label: "失敗" },
};

export const verificationStatus: Record<ReportVerificationStatus, StatusVisual> = {
  passed: { tone: "success", icon: CircleCheck, label: "通過" },
  failed: { tone: "danger", icon: CircleX, label: "失敗" },
  not_run: { tone: "neutral", icon: CircleMinus, label: "未執行" },
  not_supplied: { tone: "attention", icon: CircleDashed, label: "未回報" },
};

export const trackingStatus: Record<ProjectStatus, StatusVisual> = {
  tracked: { tone: "success", icon: FolderGit2, label: "記錄中" },
  paused: { tone: "attention", icon: Folder, label: "已暫停" },
  ignored: { tone: "neutral", icon: FolderX, label: "已忽略" },
  unregistered: { tone: "neutral", icon: Folder, label: "未註冊" },
};

export const requestStatus: Record<RequestStatus, StatusVisual> = {
  pending: { tone: "attention", icon: CircleDashed, label: "待處理" },
  processing: { tone: "accent", icon: LoaderCircle, label: "處理中" },
  completed: { tone: "done", icon: Check, label: "已完成" },
  failed: { tone: "danger", icon: CircleX, label: "失敗" },
  cancelled: { tone: "neutral", icon: CircleSlash, label: "已取消" },
};

export const metadataGapStatus: Record<MetadataGapKind, StatusVisual> = {
  changed_files: { tone: "attention", icon: FileQuestion, label: "檔案 metadata 缺漏" },
  verification_missing: { tone: "attention", icon: CircleDashed, label: "Verification 未回報" },
  verification_not_run: { tone: "neutral", icon: CircleMinus, label: "明確未執行" },
};

export const knowledgeStatusVisual: Record<KnowledgeStatus, StatusVisual> = {
  active: { tone: "success", label: "使用中" },
  archived: { tone: "neutral", label: "已封存" },
};

export const knowledgeKindVisual: Record<KnowledgeKind, StatusVisual> = {
  decision: { tone: "accent", icon: Scale, label: "技術決策" },
  pattern: { tone: "done", icon: Shapes, label: "可重用模式" },
  gotcha: { tone: "attention", icon: TriangleAlert, label: "注意事項" },
  procedure: { tone: "success", icon: ListOrdered, label: "操作流程" },
  skill: { tone: "neutral", icon: GraduationCap, label: "技能" },
};

/** Trust markers: stale is rule-based (later Sessions changed appliesTo paths); review follows a reported contradiction. */
export const knowledgeTrustVisual = {
  possiblyStale: { tone: "attention", icon: Clock3, label: "可能過時" },
  needsReview: { tone: "danger", icon: CircleAlert, label: "需要檢視" },
} satisfies Record<string, StatusVisual>;

export const executionStatusVisual: StatusVisual = { tone: "neutral", label: "completed" };

/** Missing verification is historical `not_supplied`, never `not_run`. */
export function verificationOf(session: {
  verification?: { status: ReportVerificationStatus };
}): ReportVerificationStatus {
  return session.verification?.status ?? "not_supplied";
}

/** Splits the API's `verification` gap into 未回報 vs 明確未執行 (README requirement 8). */
export function metadataGapsOf(item: {
  gaps: readonly ("changed_files" | "verification")[];
  verificationStatus: ReportVerificationStatus;
}): MetadataGapKind[] {
  return item.gaps.map((gap) => {
    if (gap === "changed_files") {
      return "changed_files";
    }
    return item.verificationStatus === "not_run" ? "verification_not_run" : "verification_missing";
  });
}
