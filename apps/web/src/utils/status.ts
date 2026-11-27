import {
  Archive,
  BookOpen,
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
  Replace,
  Scale,
  Shapes,
  TriangleAlert,
} from "lucide-vue-next";
import type {
  AgentObservationState,
  AgentReviewPageState,
  AgentReviewRequestStatus,
  DatabaseInspectionState,
  DatabaseMaintenanceStatus,
  AgentHookInstallState,
  AgentMcpRegistrationState,
  AgentRegistrationSource,
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
  if (status.activeProcesses === 0 && status.agentObservedWithoutLease) {
    return visual("attention", CircleAlert, "status.agentSeenButNoConnectionRecord");
  }
  if (status.activeProcesses === 0) return visual("neutral", CircleDashed, "status.noConnectionsToMonitorYet");
  return visual("success", CircleCheck, "status.currentVersion");
}

const LEASE_CAUSE_NOTE_KEYS = {
  lease_unreported: "systemStatus.agentSeenLeaseUnreported",
  directory_unwritable: "systemStatus.agentSeenLeaseDirectoryUnwritable",
  scope_mismatch: "systemStatus.agentSeenLeaseScopeMismatch",
  agent_disconnected: "systemStatus.agentSeenLeaseAgentDisconnected",
} as const;

/** The note that says why an observed Agent has no visible connection record; the general note when the cause is unknown. */
export function agentSeenLeaseNoteKey(
  status: SystemStatus["mcp"],
): (typeof LEASE_CAUSE_NOTE_KEYS)[keyof typeof LEASE_CAUSE_NOTE_KEYS] | "systemStatus.agentSeenWithoutLeaseNote" {
  const cause = status.leaseDiagnosis?.cause;
  return cause ? LEASE_CAUSE_NOTE_KEYS[cause] : "systemStatus.agentSeenWithoutLeaseNote";
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

type DesktopLoginItem = NonNullable<NonNullable<SystemStatus["desktop"]>["loginItem"]>;

/** Whether the App's own login item disagrees with what the user chose; an unsupported or unreadable state is never a mismatch. */
export function desktopLoginItemMismatch(item: DesktopLoginItem): boolean {
  if (!item.supported || item.system === "unknown") return false;
  return item.desired !== (item.system === "enabled");
}

/** Whether the free space inside the database file is worth compacting. */
export function reclaimVisual(suggested: boolean | undefined): StatusVisual {
  return suggested
    ? visual("attention", CircleAlert, "systemStatus.reclaimWorthIt")
    : visual("neutral", CircleMinus, "systemStatus.reclaimNotNeeded");
}

/** The status label of the App's login item card. */
export function desktopLoginItemStatusVisual(item: DesktopLoginItem | undefined): StatusVisual {
  if (!item) return visual("attention", CircleAlert, "status.cannotConfirm");
  if (!item.supported) return visual("neutral", CircleMinus, "status.notSupported");
  if (item.system === "unknown") return visual("attention", CircleAlert, "status.cannotConfirm");
  if (desktopLoginItemMismatch(item)) return visual("attention", CircleAlert, "status.needsChecking");
  return item.system === "enabled"
    ? visual("success", CircleCheck, "systemStatus.appLoginItemOn")
    : visual("neutral", CircleMinus, "systemStatus.appLoginItemOff");
}

export function agentMcpRegistrationVisual(state: AgentMcpRegistrationState): StatusVisual {
  if (state === "registered") return visual("success", CircleCheck, "status.registered");
  if (state === "direct") return visual("attention", Clock3, "status.directRegistration");
  if (state === "other") return visual("attention", CircleAlert, "status.registeredOther");
  if (state === "unknown") return visual("attention", CircleAlert, "status.cannotConfirm");
  return visual("attention", CircleDashed, "status.unregistered");
}

export const agentSkillCopyStatus: Record<AgentSkillCopyState, StatusVisual> = {
  current: visual("success", CircleCheck, "common.upToDate"),
  missing: visual("attention", CircleDashed, "status.notInstalled"),
  stale: visual("attention", Clock3, "status.updateNeeded"),
  unreadable: visual("attention", CircleAlert, "status.cannotConfirm"),
};

/** @internal test-only */
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
  /** A short extra line under the row, when the state needs one. */
  note?: string;
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

const hookInstalledBySource: Record<AgentRegistrationSource, StatusVisual> = {
  app: visual("success", CircleCheck, "status.installedByApp"),
  checkout: visual("success", CircleCheck, "status.installedByCheckout"),
  plugin: visual("success", CircleCheck, "status.installedByPlugin"),
};

/** A working hook says who manages it; a checkout's also says it keeps working and that moving to the App is optional. */
function hookRow(
  location: string,
  state: AgentHookInstallState,
  source: AgentRegistrationSource | null | undefined,
): AgentConnectionRow {
  const owned = state === "installed" && source ? hookInstalledBySource[source] : undefined;
  return {
    title: t("status.globalHook"),
    location,
    status: owned ?? agentHookInstallStatus[state],
    ok: state === "installed" || state === "disabled",
    ...(owned && source === "checkout" ? { note: t("status.checkoutHookKeepsWorking") } : {}),
  };
}

function observationRow(state: AgentObservationState | undefined): AgentConnectionRow[] {
  if (state === undefined) return [];
  const status =
    state === "current"
      ? visual("success", CircleCheck, "status.agentObservedCurrent")
      : state === "stale"
        ? visual("attention", Clock3, "status.agentObservedStale")
        : visual("neutral", CircleDashed, "status.agentObservedNone");
  return [
    {
      title: t("status.agentObservation"),
      location: t("status.agentObservationLocation"),
      status,
      ok: state !== "stale",
    },
  ];
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
        hookRow(t("status.codexHomeHooksJsonSave"), agents.codex.hook, agents.codex.hookSource),
        ...observationRow(agents.codex.observation),
      ],
    },
    {
      agent: "Claude Code",
      rows: [
        mcpRow("~/.claude.json", agents.claudeCode.mcpRegistered),
        skillRow("Skill", "~/.claude/skills/work-intelligence", agents.claudeCode.skill),
        hookRow(t("status.claudeSettingsJsonSaveReminder"), agents.claudeCode.hook, agents.claudeCode.hookSource),
        ...observationRow(agents.claudeCode.observation),
      ],
    },
  ];
}

export type OnboardingStepState = "complete" | "pending" | "checking" | "unknown" | "other";

/**
 * The first-run "connect an Agent" step. An MCP entry that is registered or runs the server directly completes it;
 * nothing registered anywhere is a to-do; an entry that exists but runs another command is `other`, which is not
 * "cannot confirm" because the state is known.
 */
export function agentConnectionStepState(
  agents: SystemAgentConnections | null,
  loading: boolean,
  error: string,
): OnboardingStepState {
  const states = agents ? [agents.codex.mcpRegistered, agents.claudeCode.mcpRegistered] : [];
  if (states.some((state) => state === "registered" || state === "direct")) return "complete";
  if (states.length > 0 && states.every((state) => state === "missing")) return "pending";
  if (states.includes("other")) return "other";
  if (error) return "unknown";
  return loading ? "checking" : "unknown";
}

export function onboardingStepStatusVisual(state: OnboardingStepState): StatusVisual {
  if (state === "complete") return visual("success", CircleCheck, "common.completedStatus");
  if (state === "other") return visual("attention", CircleAlert, "status.registeredOther");
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
  in_progress: visual("accent", Clock3, "common.inProgress"),
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

export const agentReviewPageStateVisual: Record<AgentReviewPageState, StatusVisual> = {
  updated: visual("success", CircleCheck, "status.agentReviewPageUpdated"),
  checked: visual("done", Check, "status.agentReviewPageChecked"),
  pending: visual("attention", Clock3, "status.agentReviewPagePending"),
  unchanged: visual("neutral", CircleMinus, "status.agentReviewPageUnchanged"),
};

export const outstandingCleanupRequestVisual: Record<OutstandingCleanupRequestStatus, StatusVisual> = {
  pending: visual("attention", CircleDashed, "status.awaitingAgent"),
  awaiting_review: visual("done", CircleAlert, "status.awaitingReview"),
  completed: visual("done", Check, "status.cleanupFinished"),
  cancelled: visual("neutral", CircleSlash, "common.cancelled"),
};

export const agentReviewRequestVisual: Record<AgentReviewRequestStatus, StatusVisual> = {
  pending: visual("attention", CircleDashed, "status.agentReviewPending"),
  processing: visual("accent", LoaderCircle, "status.processing"),
  completed: visual("success", Check, "status.agentReviewCompleted"),
  failed: visual("danger", CircleX, "common.failed"),
  cancelled: visual("neutral", CircleSlash, "common.cancelled"),
};

/** What an Agent decided on a Session decision or a Knowledge candidate. */
export type AgentVerdictKind = "confirmed" | "rejected" | "promoted" | "accepted" | "confirm" | "archive" | "supersede";

export const agentVerdictVisual: Record<AgentVerdictKind, StatusVisual> = {
  confirmed: visual("success", Check, "common.confirmed"),
  rejected: visual("neutral", CircleSlash, "common.rejected"),
  promoted: visual("success", BookOpen, "status.promotedToKnowledge"),
  accepted: visual("success", Check, "status.accepted"),
  confirm: visual("success", Check, "common.confirmed"),
  archive: visual("neutral", Archive, "status.archived"),
  supersede: visual("accent", Replace, "status.supersededByAgent"),
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
