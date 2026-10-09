import { describe, expect, it } from "vitest";
import {
  changedFileChangeStatusLabels,
  changedFileSourceLabels,
  databaseBackupKindLabels,
  evidenceKindLabels,
  graphEdgeKindLabels,
  graphMetadataLabels,
  graphNodeKindLabels,
  graphNodeKindOrder,
  insightKindLabels,
  knowledgeAuditActionLabels,
  knowledgeKindLabels,
  knowledgeStatusLabels,
  listPageSizeOptions,
  outstandingItemStatusLabels,
  pageSizeToQuery,
  projectDeletionCountLabels,
  reportPeriodLabels,
  reportTabOptions,
  sessionLinkDirectionLabels,
  sessionLinkOptions,
  statusDescriptions,
  statusLabels,
  voidedFilterOptions,
  workSummarySectionLabels,
} from "../../../apps/web/src/utils/labels.js";
import type { SystemStatus } from "../../../packages/core/src/index.js";
import {
  agentConnectionGroups,
  agentHookInstallStatus,
  databaseInspectionStatus,
  databaseMaintenanceStatus,
  executionStatusVisual,
  hotspotRiskVisual,
  knowledgeKindVisual,
  knowledgeStatusVisual,
  metadataGapStatus,
  metadataGapsOf,
  mcpReconnectStatusVisual,
  mcpRuntimeStatusVisual,
  outstandingItemStatusVisual,
  requestStatus,
  trackingStatus,
  verificationOf,
  verificationStatus,
  userServiceStatusVisual,
} from "../../../apps/web/src/utils/status.js";
import { t } from "../../../apps/web/src/i18n/index.js";

describe("status and label maps", () => {
  it("exposes the shared project, Knowledge, report, and list labels", () => {
    expect(statusLabels).toMatchObject({
      tracked: t("status.tracked"),
      paused: t("status.paused"),
      ignored: t("status.ignored"),
      unregistered: t("status.unregistered"),
    });
    expect(knowledgeKindLabels).toMatchObject({
      decision: t("status.technicalDecision"),
      pattern: t("status.reusablePattern"),
      gotcha: t("status.gotcha"),
      procedure: t("status.procedure"),
      skill: t("status.skill"),
    });
    expect(knowledgeStatusLabels).toEqual({ active: t("status.active"), archived: t("status.archived") });
    expect(databaseBackupKindLabels.maintenance).toBe(t("labels.beforeDataMaintenance"));
    expect(Object.keys(projectDeletionCountLabels)).toContain("sessionWorkSummaryUpdates");
    expect(projectDeletionCountLabels.sessionDecisions).toBe(t("labels.sessionDecisions"));
    expect(sessionLinkDirectionLabels).toMatchObject({
      continues: t("labels.continues"),
      continued_by: t("labels.continuedBy"),
      related: t("labels.relatedOption"),
    });
    expect(sessionLinkOptions).toHaveLength(3);
    expect(voidedFilterOptions.map(({ value }) => value)).toEqual(["exclude", "include", "only"]);
    expect(listPageSizeOptions).toHaveLength(5);
    expect(outstandingItemStatusLabels).toEqual({
      pending: t("common.pending"),
      completed: t("common.completedStatus"),
      not_needed: t("common.noLongerNeeded"),
    });
    expect(pageSizeToQuery("all")).toBe(0);
    expect(pageSizeToQuery(50)).toBe(50);
    expect(reportTabOptions.find(({ id }) => id === "raw")?.shortLabel).toBe(t("labels.rawRecords"));
    expect(workSummarySectionLabels).toHaveLength(5);
    expect(statusDescriptions.tracked).toBe(t("labels.explicitlyAuthorizedHandoffsCanBe"));
    expect(changedFileSourceLabels.worktree).toBe(t("labels.worktree"));
    expect(changedFileChangeStatusLabels.renamed).toBe(t("labels.renamed"));
    expect(reportPeriodLabels.custom).toBe(t("common.customRange"));
    expect(insightKindLabels.metadata).toBe("Metadata");
    expect(evidenceKindLabels.attached).toBe("Attached evidence");
    expect(knowledgeAuditActionLabels.restored).toBe(t("labels.restored"));
    expect(graphNodeKindOrder).toEqual(["project", "session", "knowledge", "evidence", "file"]);
    expect(graphNodeKindLabels.file).toBe(t("labels.changedFiles"));
    expect(graphEdgeKindLabels.session_link).toBe(t("labels.sessionLinks"));
    expect(graphMetadataLabels.rootPath).toBe(t("labels.projectRoot"));
  });

  it("maps domain states to visuals and distinguishes missing from not-run verification", () => {
    expect(databaseInspectionStatus.ok.label).toBe(t("status.healthy"));
    expect(databaseInspectionStatus.unreadable.tone).toBe("danger");
    expect(databaseMaintenanceStatus.running.label).toBe(t("status.running"));
    expect(databaseMaintenanceStatus.completed.label).toBe(t("status.succeeded"));
    expect(databaseMaintenanceStatus.failed.label).toBe(t("common.failed"));
    expect(verificationStatus.in_progress).toMatchObject({ tone: "accent", label: t("common.inProgress") });
    expect(verificationOf({ verification: { status: "in_progress" } })).toBe("in_progress");
    expect(verificationStatus.not_supplied.label).toBe(t("common.notReported"));
    expect(trackingStatus.tracked.label).toBe(t("status.tracked"));
    expect(requestStatus.cancelled.label).toBe(t("common.cancelled"));
    expect(outstandingItemStatusVisual).toMatchObject({
      pending: { tone: "attention", label: t("common.pending") },
      completed: { tone: "success", label: t("common.completedStatus") },
      not_needed: { tone: "neutral", label: t("common.noLongerNeeded") },
    });
    expect(metadataGapStatus.changed_files.label).toBe(t("status.fileMetadataMissing"));
    expect(knowledgeStatusVisual.archived.label).toBe(t("status.archived"));
    expect(knowledgeKindVisual.gotcha.label).toBe(t("status.gotcha"));
    expect(executionStatusVisual.label).toBe("completed");
    expect(verificationOf({})).toBe("not_supplied");
    expect(verificationOf({ verification: { status: "passed" } })).toBe("passed");
    expect(metadataGapsOf({ gaps: ["changed_files", "verification"], verificationStatus: "not_run" })).toEqual([
      "changed_files",
      "verification_not_run",
    ]);
    expect(metadataGapsOf({ gaps: ["verification"], verificationStatus: "not_supplied" })).toEqual([
      "verification_missing",
    ]);
    expect(
      mcpRuntimeStatusVisual({
        restartRequired: false,
        monitoringAvailable: false,
        activeProcesses: 0,
        outdatedProcesses: 0,
        updateAvailableProcesses: 0,
      }),
    ).toMatchObject({ tone: "attention", label: t("status.cannotConfirm") });
    expect(
      mcpRuntimeStatusVisual({
        restartRequired: false,
        monitoringAvailable: true,
        activeProcesses: 0,
        outdatedProcesses: 0,
        updateAvailableProcesses: 0,
      }),
    ).toMatchObject({ tone: "neutral", label: t("status.noConnectionsToMonitorYet") });
    expect(
      mcpReconnectStatusVisual({
        restartRequired: true,
        monitoringAvailable: false,
        activeProcesses: 0,
        outdatedProcesses: 0,
        updateAvailableProcesses: 0,
      }),
    ).toMatchObject({ tone: "attention", label: t("status.reconnectNeeded") });
    expect(
      mcpReconnectStatusVisual({
        restartRequired: false,
        monitoringAvailable: false,
        activeProcesses: 0,
        outdatedProcesses: 0,
        updateAvailableProcesses: 0,
      }),
    ).toMatchObject({ tone: "attention", label: t("status.cannotConfirm") });
    expect(
      mcpReconnectStatusVisual({
        restartRequired: false,
        monitoringAvailable: true,
        activeProcesses: 0,
        outdatedProcesses: 0,
        updateAvailableProcesses: 0,
      }),
    ).toMatchObject({ tone: "attention", label: t("status.noConnectionsToConfirmYet") });
    expect(
      mcpReconnectStatusVisual({
        restartRequired: false,
        monitoringAvailable: true,
        activeProcesses: 1,
        outdatedProcesses: 0,
        updateAvailableProcesses: 0,
      }),
    ).toMatchObject({ tone: "success", label: t("status.noReconnectNeeded") });
  });

  it("maps every login service state and warns when the service is not enabled", () => {
    const serviceStatus = (
      state: SystemStatus["userService"]["state"],
      enabled: SystemStatus["userService"]["enabled"],
    ): SystemStatus["userService"] => ({
      supported: state !== "unsupported",
      state,
      manager: null,
      enabled,
      running: state === "running",
      configPath: null,
      databasePath: "/tmp/work-intelligence.sqlite",
      backupDirectory: "/tmp/backups",
      logPath: "/tmp/server.log",
    });

    expect(userServiceStatusVisual(serviceStatus("running", true))).toMatchObject({
      tone: "success",
      label: t("status.running"),
    });
    expect(userServiceStatusVisual(serviceStatus("running", null))).toMatchObject({
      tone: "success",
      label: t("status.running"),
    });
    expect(userServiceStatusVisual(serviceStatus("running", false))).toMatchObject({
      tone: "attention",
      label: t("status.needsChecking"),
    });
    expect(userServiceStatusVisual(serviceStatus("not_installed", false))).toMatchObject({
      tone: "neutral",
      label: t("status.notInstalled"),
    });
    expect(userServiceStatusVisual(serviceStatus("unsupported", null))).toMatchObject({
      tone: "neutral",
      label: t("status.notSupported"),
    });
    expect(userServiceStatusVisual(serviceStatus("stopped", false))).toMatchObject({
      tone: "neutral",
      label: t("status.disabled"),
    });
    expect(userServiceStatusVisual(serviceStatus("stopped", true))).toMatchObject({
      tone: "attention",
      label: t("status.needsChecking"),
    });
    expect(userServiceStatusVisual(serviceStatus("unavailable", null))).toMatchObject({
      tone: "attention",
      label: t("status.needsChecking"),
    });
  });
});

describe("hotspotRiskVisual", () => {
  it("labels the failure share so the meaning never depends on color alone", () => {
    expect(hotspotRiskVisual({ sessionCount: 10, failedCount: 3 })).toMatchObject({
      tone: "danger",
      label: t("status.highFailureRate"),
    });
    expect(hotspotRiskVisual({ sessionCount: 10, failedCount: 1 })).toMatchObject({
      tone: "attention",
      label: t("status.hasFailedVerification"),
    });
    expect(hotspotRiskVisual({ sessionCount: 10, failedCount: 0 })).toMatchObject({
      tone: "success",
      label: t("status.neverFailed"),
    });
    expect(hotspotRiskVisual({ sessionCount: 0, failedCount: 0 })).toMatchObject({ tone: "success" });
  });

  it("groups Agent setup rows per Agent and marks only healthy or deliberately disabled parts as ok", () => {
    const groups = agentConnectionGroups({
      codex: { mcpRegistered: "registered", canonicalSkill: "missing", legacySkill: "stale", hook: "stale" },
      claudeCode: { mcpRegistered: "unknown", skill: "current", hook: "disabled" },
    });

    expect(groups.map((group) => group.agent)).toEqual(["Codex", "Claude Code"]);
    expect(groups[0]?.rows.map((row) => [row.title, row.ok, row.status.label])).toEqual([
      [t("status.mcpRegistration"), true, t("status.registered")],
      ["Skill", false, t("status.notInstalled")],
      [t("status.compatibilitySkill"), false, t("status.updateNeeded")],
      [t("status.globalHook"), false, t("status.updateNeeded")],
    ]);
    expect(groups[1]?.rows.map((row) => [row.title, row.ok])).toEqual([
      [t("status.mcpRegistration"), false],
      ["Skill", true],
      [t("status.globalHook"), true],
    ]);
    expect(agentHookInstallStatus.stale).toMatchObject({ tone: "attention", label: t("status.updateNeeded") });
  });
});
