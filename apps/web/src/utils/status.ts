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
  ProjectStatus,
  ReportSynthesisRequest,
  ReportVerificationStatus,
  SystemAgentConnections,
  SystemStatus,
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

export function mcpRuntimeStatusVisual(status: SystemStatus["mcp"]): StatusVisual {
  if (status.restartRequired) return { tone: "attention", icon: TriangleAlert, label: "需要重新連線" };
  if (!status.monitoringAvailable) return { tone: "attention", icon: CircleAlert, label: "無法確認" };
  if (status.activeProcesses === 0) return { tone: "neutral", icon: CircleDashed, label: "尚無可監測連線" };
  return { tone: "success", icon: CircleCheck, label: "目前版本" };
}

export function userServiceStatusVisual(status: SystemStatus["userService"]): StatusVisual {
  if (status.state === "running" && status.enabled !== false) {
    return { tone: "success", icon: CircleCheck, label: "執行中" };
  }
  if (status.state === "not_installed") {
    return { tone: "neutral", icon: CircleDashed, label: "未安裝" };
  }
  if (status.state === "unsupported") {
    return { tone: "neutral", icon: CircleMinus, label: "不支援" };
  }
  if (status.state === "stopped" && status.enabled === false) {
    return { tone: "neutral", icon: CircleMinus, label: "已停用" };
  }
  return { tone: "attention", icon: CircleAlert, label: "需檢查" };
}

export function agentMcpRegistrationVisual(state: AgentMcpRegistrationState): StatusVisual {
  if (state === "registered") return { tone: "success", icon: CircleCheck, label: "已註冊" };
  if (state === "unknown") return { tone: "attention", icon: CircleAlert, label: "無法確認" };
  return { tone: "attention", icon: CircleDashed, label: "未註冊" };
}

export const agentSkillCopyStatus: Record<AgentSkillCopyState, StatusVisual> = {
  current: { tone: "success", icon: CircleCheck, label: "最新" },
  missing: { tone: "attention", icon: CircleDashed, label: "未安裝" },
  stale: { tone: "attention", icon: Clock3, label: "需要更新" },
  unreadable: { tone: "attention", icon: CircleAlert, label: "無法確認" },
};

export const agentHookInstallStatus: Record<AgentHookInstallState, StatusVisual> = {
  installed: { tone: "success", icon: CircleCheck, label: "已安裝" },
  stale: { tone: "attention", icon: Clock3, label: "需要更新" },
  missing: { tone: "attention", icon: CircleDashed, label: "未安裝" },
  disabled: { tone: "neutral", icon: CircleMinus, label: "已停用" },
  unknown: { tone: "attention", icon: CircleAlert, label: "無法確認" },
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
  return { title: "MCP 註冊", location, status: agentMcpRegistrationVisual(state), ok: state === "registered" };
}

function skillRow(title: string, location: string, state: AgentSkillCopyState): AgentConnectionRow {
  return { title, location, status: agentSkillCopyStatus[state], ok: state === "current" };
}

function hookRow(location: string, state: AgentHookInstallState): AgentConnectionRow {
  return {
    title: "全域 hook",
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
        skillRow("相容 skill", "CODEX_HOME/skills/work-intelligence（舊版 Codex）", agents.codex.legacySkill),
        hookRow("CODEX_HOME/hooks.json · 保存提醒", agents.codex.hook),
      ],
    },
    {
      agent: "Claude Code",
      rows: [
        mcpRow("~/.claude.json", agents.claudeCode.mcpRegistered),
        skillRow("Skill", "~/.claude/skills/work-intelligence", agents.claudeCode.skill),
        hookRow("~/.claude/settings.json · 保存提醒", agents.claudeCode.hook),
      ],
    },
  ];
}

export function onboardingStepStatusVisual(state: "complete" | "pending" | "checking" | "unknown"): StatusVisual {
  if (state === "complete") return { tone: "success", icon: CircleCheck, label: "已完成" };
  if (state === "checking") return { tone: "accent", icon: LoaderCircle, label: "檢查中" };
  if (state === "unknown") return { tone: "attention", icon: CircleAlert, label: "無法確認" };
  return { tone: "attention", icon: CircleDashed, label: "待完成" };
}

export function mcpReconnectStatusVisual(status: SystemStatus["mcp"]): StatusVisual {
  if (status.restartRequired) return { tone: "attention", icon: TriangleAlert, label: "需要重新連線" };
  if (!status.monitoringAvailable) return { tone: "attention", icon: CircleAlert, label: "無法確認" };
  if (status.activeProcesses === 0) return { tone: "attention", icon: CircleAlert, label: "尚無可確認連線" };
  return { tone: "success", icon: CircleCheck, label: "不需要重新連線" };
}

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

export const outstandingItemStatusVisual: Record<OutstandingItemStatus, StatusVisual> = {
  pending: { tone: "attention", icon: CircleDashed, label: "待處理" },
  completed: { tone: "success", icon: CircleCheck, label: "已完成" },
  not_needed: { tone: "neutral", icon: CircleMinus, label: "不再需要" },
};

/** A standing Knowledge page: "missing" is a default page the project has not requested yet. */
export const knowledgePageStatusVisual: Record<KnowledgePageStatus | "missing", StatusVisual> = {
  missing: { tone: "neutral", icon: CircleDashed, label: "尚未建立" },
  empty: { tone: "accent", icon: LoaderCircle, label: "等待 Agent 撰寫" },
  fresh: { tone: "success", icon: CircleCheck, label: "最新" },
  has_new_data: { tone: "accent", icon: Clock3, label: "有新資料" },
};

export const knowledgePageReviewReasonLabels: Record<KnowledgePageReviewReason, string> = {
  source_updated_after_save: "來源 Session 在儲存後有修改",
  source_voided_after_save: "來源 Session 在儲存後已作廢",
  source_restored_after_save: "來源 Session 在儲存後已還原",
  source_missing: "來源 Session 已不存在或無法存取",
  source_state_unknown: "無法確認頁面儲存時的來源狀態",
};

export const HOTSPOT_HIGH_FAILURE_RATE = 0.3;

/** Hotspot risk from the share of Sessions whose verification failed; the label carries the meaning, not the color. */
export function hotspotRiskVisual(hotspot: { sessionCount: number; failedCount: number }): StatusVisual {
  const rate = hotspot.sessionCount > 0 ? hotspot.failedCount / hotspot.sessionCount : 0;
  if (rate >= HOTSPOT_HIGH_FAILURE_RATE) return { tone: "danger", icon: CircleX, label: "失敗比例高" };
  if (rate > 0) return { tone: "attention", icon: TriangleAlert, label: "曾驗證失敗" };
  return { tone: "success", icon: CircleCheck, label: "未曾失敗" };
}

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
