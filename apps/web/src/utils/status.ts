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
  AgentHookInstallState,
  AgentMcpRegistrationState,
  AgentSkillCopyState,
  KnowledgeKind,
  KnowledgePageStatus,
  KnowledgePageReviewReason,
  KnowledgeStatus,
  MetadataBackfillRequest,
  OutstandingItemStatus,
  OutstandingCleanupRequestStatus,
  OutstandingCleanupProposalStatus,
  ProjectStatus,
  ReportSynthesisRequest,
  ReportVerificationStatus,
  SystemAgentConnections,
  SystemStatus,
} from "@work-intelligence/core";
import type { IconComponent, Tone } from "../components/ui/types";
import { t, translatedRecord } from "../i18n";

/**
 * Single source of truth for status → tone/icon/label.
 * Rules come from .agents/skills/worklog-ui/references/tokens.md#status-mapping and domain-semantics.md.
 */
export type StatusVisual = { tone: Tone; icon?: IconComponent; label: string };

/** The label is a 繁體中文 source string translated on every read, so module-level maps follow the locale. */
function visual(tone: Tone, icon: IconComponent | undefined, label: string): StatusVisual {
  return {
    tone,
    ...(icon ? { icon } : {}),
    get label() {
      return t(label);
    },
  };
}

export type RequestStatus = ReportSynthesisRequest["status"] | MetadataBackfillRequest["status"];
export type MetadataGapKind = "changed_files" | "verification_missing" | "verification_not_run";

export const databaseInspectionStatus: Record<DatabaseInspectionState, StatusVisual> = {
  ok: visual("success", CircleCheck, "正常"),
  missing: visual("attention", CircleAlert, "不存在"),
  unhealthy: visual("danger", CircleX, "異常"),
  unreadable: visual("danger", CircleAlert, "無法讀取"),
};

export function mcpRuntimeStatusVisual(status: SystemStatus["mcp"]): StatusVisual {
  if (status.restartRequired) return visual("attention", TriangleAlert, "需要重新連線");
  if (!status.monitoringAvailable) return visual("attention", CircleAlert, "無法確認");
  if (status.updateAvailable) return visual("accent", CircleAlert, "有新版可用");
  if (status.activeProcesses === 0) return visual("neutral", CircleDashed, "尚無可監測連線");
  return visual("success", CircleCheck, "目前版本");
}

export function userServiceStatusVisual(status: SystemStatus["userService"]): StatusVisual {
  if (status.state === "running" && status.enabled !== false) {
    return visual("success", CircleCheck, "執行中");
  }
  if (status.state === "not_installed") {
    return visual("neutral", CircleDashed, "未安裝");
  }
  if (status.state === "unsupported") {
    return visual("neutral", CircleMinus, "不支援");
  }
  if (status.state === "stopped" && status.enabled === false) {
    return visual("neutral", CircleMinus, "已停用");
  }
  return visual("attention", CircleAlert, "需檢查");
}

export function agentMcpRegistrationVisual(state: AgentMcpRegistrationState): StatusVisual {
  if (state === "registered") return visual("success", CircleCheck, "已註冊");
  if (state === "unknown") return visual("attention", CircleAlert, "無法確認");
  return visual("attention", CircleDashed, "未註冊");
}

export const agentSkillCopyStatus: Record<AgentSkillCopyState, StatusVisual> = {
  current: visual("success", CircleCheck, "最新"),
  missing: visual("attention", CircleDashed, "未安裝"),
  stale: visual("attention", Clock3, "需要更新"),
  unreadable: visual("attention", CircleAlert, "無法確認"),
};

export const agentHookInstallStatus: Record<AgentHookInstallState, StatusVisual> = {
  installed: visual("success", CircleCheck, "已安裝"),
  stale: visual("attention", Clock3, "需要更新"),
  missing: visual("attention", CircleDashed, "未安裝"),
  disabled: visual("neutral", CircleMinus, "已停用"),
  unknown: visual("attention", CircleAlert, "無法確認"),
};

export interface AgentConnectionRow {
  title: string;
  /** Where the component lives, so the user knows what the state refers to. */
  location: string;
  status: StatusVisual;
  /** Registered, current, installed, or deliberately disabled; anything else needs setup. */
  ok: boolean;
}

export interface AgentConnectionGroup {
  agent: "Codex" | "Claude Code";
  rows: AgentConnectionRow[];
}

function mcpRow(location: string, state: AgentMcpRegistrationState): AgentConnectionRow {
  return { title: t("MCP 註冊"), location, status: agentMcpRegistrationVisual(state), ok: state === "registered" };
}

function skillRow(title: string, location: string, state: AgentSkillCopyState): AgentConnectionRow {
  return { title, location, status: agentSkillCopyStatus[state], ok: state === "current" };
}

function hookRow(location: string, state: AgentHookInstallState): AgentConnectionRow {
  return {
    title: t("全域 hook"),
    location,
    status: agentHookInstallStatus[state],
    ok: state === "installed" || state === "disabled",
  };
}

/** Groups the per-Agent setup components in the order a user fixes them: MCP, then skill, then hook. */
export function agentConnectionGroups(agents: SystemAgentConnections): AgentConnectionGroup[] {
  return [
    {
      agent: "Codex",
      rows: [
        mcpRow("CODEX_HOME/config.toml", agents.codex.mcpRegistered),
        skillRow("Skill", "~/.agents/skills/work-intelligence", agents.codex.canonicalSkill),
        skillRow(t("相容 skill"), t("CODEX_HOME/skills/work-intelligence（舊版 Codex）"), agents.codex.legacySkill),
        hookRow(t("CODEX_HOME/hooks.json · 保存提醒"), agents.codex.hook),
      ],
    },
    {
      agent: "Claude Code",
      rows: [
        mcpRow("~/.claude.json", agents.claudeCode.mcpRegistered),
        skillRow("Skill", "~/.claude/skills/work-intelligence", agents.claudeCode.skill),
        hookRow(t("~/.claude/settings.json · 保存提醒"), agents.claudeCode.hook),
      ],
    },
  ];
}

export function onboardingStepStatusVisual(state: "complete" | "pending" | "checking" | "unknown"): StatusVisual {
  if (state === "complete") return visual("success", CircleCheck, "已完成");
  if (state === "checking") return visual("accent", LoaderCircle, "檢查中");
  if (state === "unknown") return visual("attention", CircleAlert, "無法確認");
  return visual("attention", CircleDashed, "待完成");
}

export function mcpReconnectStatusVisual(status: SystemStatus["mcp"]): StatusVisual {
  if (status.restartRequired) return visual("attention", TriangleAlert, "需要重新連線");
  if (!status.monitoringAvailable) return visual("attention", CircleAlert, "無法確認");
  if (status.updateAvailable) return visual("accent", CircleAlert, "有新版可用");
  if (status.activeProcesses === 0) return visual("attention", CircleAlert, "尚無可確認連線");
  return visual("success", CircleCheck, "不需要重新連線");
}

export const databaseMaintenanceStatus: Record<DatabaseMaintenanceStatus, StatusVisual> = {
  running: visual("accent", LoaderCircle, "執行中"),
  completed: visual("success", CircleCheck, "成功"),
  failed: visual("danger", CircleX, "失敗"),
};

export const verificationStatus: Record<ReportVerificationStatus, StatusVisual> = {
  passed: visual("success", CircleCheck, "通過"),
  failed: visual("danger", CircleX, "失敗"),
  not_run: visual("neutral", CircleMinus, "未執行"),
  not_supplied: visual("attention", CircleDashed, "未回報"),
};

export const trackingStatus: Record<ProjectStatus, StatusVisual> = {
  tracked: visual("success", FolderGit2, "記錄中"),
  paused: visual("attention", Folder, "已暫停"),
  ignored: visual("neutral", FolderX, "已忽略"),
  unregistered: visual("neutral", Folder, "未註冊"),
};

export const requestStatus: Record<RequestStatus, StatusVisual> = {
  pending: visual("attention", CircleDashed, "待處理"),
  processing: visual("accent", LoaderCircle, "處理中"),
  completed: visual("done", Check, "已完成"),
  failed: visual("danger", CircleX, "失敗"),
  cancelled: visual("neutral", CircleSlash, "已取消"),
};

export const metadataGapStatus: Record<MetadataGapKind, StatusVisual> = {
  changed_files: visual("attention", FileQuestion, "檔案 metadata 缺漏"),
  verification_missing: visual("attention", CircleDashed, "Verification 未回報"),
  verification_not_run: visual("neutral", CircleMinus, "明確未執行"),
};

export const knowledgeStatusVisual: Record<KnowledgeStatus, StatusVisual> = {
  active: visual("success", undefined, "使用中"),
  archived: visual("neutral", undefined, "已封存"),
};

export const knowledgeKindVisual: Record<KnowledgeKind, StatusVisual> = {
  decision: visual("accent", Scale, "技術決策"),
  pattern: visual("done", Shapes, "可重用模式"),
  gotcha: visual("attention", TriangleAlert, "注意事項"),
  procedure: visual("success", ListOrdered, "操作流程"),
  skill: visual("neutral", GraduationCap, "技能"),
};

export const outstandingCleanupRequestVisual: Record<OutstandingCleanupRequestStatus, StatusVisual> = {
  pending: visual("attention", CircleDashed, "待 Agent 整理"),
  awaiting_review: visual("done", CircleAlert, "待審核"),
  completed: visual("done", Check, "整理結束"),
  cancelled: visual("neutral", CircleSlash, "已取消"),
};

export const outstandingCleanupProposalVisual: Record<OutstandingCleanupProposalStatus, StatusVisual> = {
  pending: visual("attention", CircleDashed, "待審核"),
  accepted: visual("success", Check, "已接受"),
  rejected: visual("neutral", CircleSlash, "已拒絕"),
};

export const outstandingItemStatusVisual: Record<OutstandingItemStatus, StatusVisual> = {
  pending: visual("attention", CircleDashed, "待處理"),
  completed: visual("success", CircleCheck, "已完成"),
  not_needed: visual("neutral", CircleMinus, "不再需要"),
};

/** A standing Knowledge page: "missing" is a default page the project has not requested yet. */
export const knowledgePageStatusVisual: Record<KnowledgePageStatus | "missing", StatusVisual> = {
  missing: visual("neutral", CircleDashed, "尚未建立"),
  empty: visual("accent", LoaderCircle, "等待 Agent 撰寫"),
  fresh: visual("success", CircleCheck, "最新"),
  has_new_data: visual("accent", Clock3, "有新資料"),
};

export const knowledgePageReviewReasonLabels: Record<KnowledgePageReviewReason, string> = translatedRecord({
  source_updated_after_save: "來源 Session 在儲存後有修改",
  source_voided_after_save: "來源 Session 在儲存後已作廢",
  source_restored_after_save: "來源 Session 在儲存後已還原",
  source_missing: "來源 Session 已不存在或無法存取",
  source_state_unknown: "無法確認頁面儲存時的來源狀態",
});

export const HOTSPOT_HIGH_FAILURE_RATE = 0.3;

/** Hotspot risk from the share of Sessions whose verification failed; the label carries the meaning, not the color. */
export function hotspotRiskVisual(hotspot: { sessionCount: number; failedCount: number }): StatusVisual {
  const rate = hotspot.sessionCount > 0 ? hotspot.failedCount / hotspot.sessionCount : 0;
  if (rate >= HOTSPOT_HIGH_FAILURE_RATE) return visual("danger", CircleX, "失敗比例高");
  if (rate > 0) return visual("attention", TriangleAlert, "曾驗證失敗");
  return visual("success", CircleCheck, "未曾失敗");
}

/** Trust markers: stale is rule-based (later Sessions changed appliesTo paths); review follows a reported contradiction. */
export const knowledgeTrustVisual = {
  possiblyStale: visual("attention", Clock3, "可能過時"),
  needsReview: visual("danger", CircleAlert, "需要檢視"),
} satisfies Record<string, StatusVisual>;

export const executionStatusVisual: StatusVisual = visual("neutral", undefined, "completed");

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
