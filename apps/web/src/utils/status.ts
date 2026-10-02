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
import { t, translatedRecord, type MessageKey } from "../i18n";

/**
 * Single source of truth for status → tone/icon/label.
 * Rules come from .agents/skills/worklog-ui/references/tokens.md#status-mapping and domain-semantics.md.
 */
export type StatusVisual = { tone: Tone; icon?: IconComponent; label: string };

/** The label is a message key translated on every read, so module-level maps follow the locale. */
function visual(tone: Tone, icon: IconComponent | undefined, label: MessageKey): StatusVisual {
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
  ok: visual("success", CircleCheck, "status.healthy"),
  missing: visual("attention", CircleAlert, "status.missing"),
  unhealthy: visual("danger", CircleX, "status.unhealthy"),
  unreadable: visual("danger", CircleAlert, "status.unreadable"),
};

export function mcpRuntimeStatusVisual(status: SystemStatus["mcp"]): StatusVisual {
  if (status.restartRequired) return visual("attention", TriangleAlert, "status.reconnectNeeded");
  if (!status.monitoringAvailable) return visual("attention", CircleAlert, "status.cannotConfirm");
  if (status.updateAvailable) return visual("accent", CircleAlert, "status.updateAvailable");
  if (status.activeProcesses === 0) return visual("neutral", CircleDashed, "status.noConnectionsToMonitorYet");
  return visual("success", CircleCheck, "status.currentVersion");
}

export function userServiceStatusVisual(status: SystemStatus["userService"]): StatusVisual {
  if (status.state === "running" && status.enabled !== false) {
    return visual("success", CircleCheck, "status.running");
  }
  if (status.state === "not_installed") {
    return visual("neutral", CircleDashed, "status.notInstalled");
  }
  if (status.state === "unsupported") {
    return visual("neutral", CircleMinus, "status.notSupported");
  }
  if (status.state === "stopped" && status.enabled === false) {
    return visual("neutral", CircleMinus, "status.disabled");
  }
  return visual("attention", CircleAlert, "status.needsChecking");
}

export function agentMcpRegistrationVisual(state: AgentMcpRegistrationState): StatusVisual {
  if (state === "registered") return visual("success", CircleCheck, "status.registered");
  if (state === "unknown") return visual("attention", CircleAlert, "status.cannotConfirm");
  return visual("attention", CircleDashed, "status.unregistered");
}

export const agentSkillCopyStatus: Record<AgentSkillCopyState, StatusVisual> = {
  current: visual("success", CircleCheck, "common.upToDate"),
  missing: visual("attention", CircleDashed, "status.notInstalled"),
  stale: visual("attention", Clock3, "status.updateNeeded"),
  unreadable: visual("attention", CircleAlert, "status.cannotConfirm"),
};

export const agentHookInstallStatus: Record<AgentHookInstallState, StatusVisual> = {
  installed: visual("success", CircleCheck, "status.installed"),
  stale: visual("attention", Clock3, "status.updateNeeded"),
  missing: visual("attention", CircleDashed, "status.notInstalled"),
  disabled: visual("neutral", CircleMinus, "status.disabled"),
  unknown: visual("attention", CircleAlert, "status.cannotConfirm"),
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
  return {
    title: t("status.mcpRegistration"),
    location,
    status: agentMcpRegistrationVisual(state),
    ok: state === "registered",
  };
}

function skillRow(title: string, location: string, state: AgentSkillCopyState): AgentConnectionRow {
  return { title, location, status: agentSkillCopyStatus[state], ok: state === "current" };
}

function hookRow(location: string, state: AgentHookInstallState): AgentConnectionRow {
  return {
    title: t("status.globalHook"),
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
        skillRow(t("status.compatibilitySkill"), t("status.codexHomeSkillsWorkIntelligence"), agents.codex.legacySkill),
        hookRow(t("status.codexHomeHooksJsonSave"), agents.codex.hook),
      ],
    },
    {
      agent: "Claude Code",
      rows: [
        mcpRow("~/.claude.json", agents.claudeCode.mcpRegistered),
        skillRow("Skill", "~/.claude/skills/work-intelligence", agents.claudeCode.skill),
        hookRow(t("status.claudeSettingsJsonSaveReminder"), agents.claudeCode.hook),
      ],
    },
  ];
}

export function onboardingStepStatusVisual(state: "complete" | "pending" | "checking" | "unknown"): StatusVisual {
  if (state === "complete") return visual("success", CircleCheck, "common.completedStatus");
  if (state === "checking") return visual("accent", LoaderCircle, "status.checking");
  if (state === "unknown") return visual("attention", CircleAlert, "status.cannotConfirm");
  return visual("attention", CircleDashed, "status.toDo");
}

export function mcpReconnectStatusVisual(status: SystemStatus["mcp"]): StatusVisual {
  if (status.restartRequired) return visual("attention", TriangleAlert, "status.reconnectNeeded");
  if (!status.monitoringAvailable) return visual("attention", CircleAlert, "status.cannotConfirm");
  if (status.updateAvailable) return visual("accent", CircleAlert, "status.updateAvailable");
  if (status.activeProcesses === 0) return visual("attention", CircleAlert, "status.noConnectionsToConfirmYet");
  return visual("success", CircleCheck, "status.noReconnectNeeded");
}

export const databaseMaintenanceStatus: Record<DatabaseMaintenanceStatus, StatusVisual> = {
  running: visual("accent", LoaderCircle, "status.running"),
  completed: visual("success", CircleCheck, "status.succeeded"),
  failed: visual("danger", CircleX, "common.failed"),
};

export const verificationStatus: Record<ReportVerificationStatus, StatusVisual> = {
  passed: visual("success", CircleCheck, "common.passed"),
  failed: visual("danger", CircleX, "common.failed"),
  not_run: visual("neutral", CircleMinus, "common.notRun"),
  not_supplied: visual("attention", CircleDashed, "common.notReported"),
};

export const trackingStatus: Record<ProjectStatus, StatusVisual> = {
  tracked: visual("success", FolderGit2, "status.tracked"),
  paused: visual("attention", Folder, "status.paused"),
  ignored: visual("neutral", FolderX, "status.ignored"),
  unregistered: visual("neutral", Folder, "status.unregistered"),
};

export const requestStatus: Record<RequestStatus, StatusVisual> = {
  pending: visual("attention", CircleDashed, "common.pending"),
  processing: visual("accent", LoaderCircle, "status.processing"),
  completed: visual("done", Check, "common.completedStatus"),
  failed: visual("danger", CircleX, "common.failed"),
  cancelled: visual("neutral", CircleSlash, "common.cancelled"),
};

export const metadataGapStatus: Record<MetadataGapKind, StatusVisual> = {
  changed_files: visual("attention", FileQuestion, "status.fileMetadataMissing"),
  verification_missing: visual("attention", CircleDashed, "status.verificationNotReported"),
  verification_not_run: visual("neutral", CircleMinus, "status.explicitlyNotRun"),
};

export const knowledgeStatusVisual: Record<KnowledgeStatus, StatusVisual> = {
  active: visual("success", undefined, "status.active"),
  archived: visual("neutral", undefined, "status.archived"),
};

export const knowledgeKindVisual: Record<KnowledgeKind, StatusVisual> = {
  decision: visual("accent", Scale, "status.technicalDecision"),
  pattern: visual("done", Shapes, "status.reusablePattern"),
  gotcha: visual("attention", TriangleAlert, "status.gotcha"),
  procedure: visual("success", ListOrdered, "status.procedure"),
  skill: visual("neutral", GraduationCap, "status.skill"),
};

export const outstandingCleanupRequestVisual: Record<OutstandingCleanupRequestStatus, StatusVisual> = {
  pending: visual("attention", CircleDashed, "status.awaitingAgent"),
  awaiting_review: visual("done", CircleAlert, "status.awaitingReview"),
  completed: visual("done", Check, "status.cleanupFinished"),
  cancelled: visual("neutral", CircleSlash, "common.cancelled"),
};

export const outstandingCleanupProposalVisual: Record<OutstandingCleanupProposalStatus, StatusVisual> = {
  pending: visual("attention", CircleDashed, "status.awaitingReview"),
  accepted: visual("success", Check, "status.accepted"),
  rejected: visual("neutral", CircleSlash, "common.rejected"),
};

export const outstandingItemStatusVisual: Record<OutstandingItemStatus, StatusVisual> = {
  pending: visual("attention", CircleDashed, "common.pending"),
  completed: visual("success", CircleCheck, "common.completedStatus"),
  not_needed: visual("neutral", CircleMinus, "common.noLongerNeeded"),
};

/** A standing Knowledge page: "missing" is a default page the project has not requested yet. */
export const knowledgePageStatusVisual: Record<KnowledgePageStatus | "missing", StatusVisual> = {
  missing: visual("neutral", CircleDashed, "common.notCreatedYet"),
  empty: visual("accent", LoaderCircle, "common.waitingForTheAgentTo"),
  fresh: visual("success", CircleCheck, "common.upToDate"),
  has_new_data: visual("accent", Clock3, "common.newDataAvailable"),
};

export const knowledgePageReviewReasonLabels: Record<KnowledgePageReviewReason, string> = translatedRecord({
  source_updated_after_save: "status.theSourceSessionChangedAfter",
  source_voided_after_save: "status.theSourceSessionWasVoided",
  source_restored_after_save: "status.theSourceSessionWasRestored",
  source_missing: "status.theSourceSessionNoLonger",
  source_state_unknown: "status.cannotConfirmTheSourceStatus",
});

export const HOTSPOT_HIGH_FAILURE_RATE = 0.3;

/** Hotspot risk from the share of Sessions whose verification failed; the label carries the meaning, not the color. */
export function hotspotRiskVisual(hotspot: { sessionCount: number; failedCount: number }): StatusVisual {
  const rate = hotspot.sessionCount > 0 ? hotspot.failedCount / hotspot.sessionCount : 0;
  if (rate >= HOTSPOT_HIGH_FAILURE_RATE) return visual("danger", CircleX, "status.highFailureRate");
  if (rate > 0) return visual("attention", TriangleAlert, "status.hasFailedVerification");
  return visual("success", CircleCheck, "status.neverFailed");
}

/** Trust markers: stale is rule-based (later Sessions changed appliesTo paths); review follows a reported contradiction. */
export const knowledgeTrustVisual = {
  possiblyStale: visual("attention", Clock3, "status.possiblyStale"),
  needsReview: visual("danger", CircleAlert, "status.needsReview"),
} satisfies Record<string, StatusVisual>;

export const executionStatusVisual: StatusVisual = visual("neutral", undefined, "status.executionCompleted");

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
