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
import {
  databaseInspectionStatus,
  databaseMaintenanceStatus,
  executionStatusVisual,
  hotspotRiskVisual,
  knowledgeKindVisual,
  knowledgeStatusVisual,
  metadataGapStatus,
  metadataGapsOf,
  mcpRuntimeStatusVisual,
  requestStatus,
  trackingStatus,
  verificationOf,
  verificationStatus,
} from "../../../apps/web/src/utils/status.js";

describe("status and label maps", () => {
  it("exposes the shared project, Knowledge, report, and list labels", () => {
    expect(statusLabels).toMatchObject({
      tracked: "記錄中",
      paused: "已暫停",
      ignored: "已忽略",
      unregistered: "未註冊",
    });
    expect(knowledgeKindLabels).toMatchObject({
      decision: "技術決策",
      pattern: "可重用模式",
      gotcha: "注意事項",
      procedure: "操作流程",
      skill: "技能",
    });
    expect(knowledgeStatusLabels).toEqual({ active: "使用中", archived: "已封存" });
    expect(databaseBackupKindLabels.maintenance).toBe("資料維護前");
    expect(Object.keys(projectDeletionCountLabels)).toContain("sessionWorkSummaryUpdates");
    expect(projectDeletionCountLabels.sessionDecisions).toBe("Session 決策");
    expect(sessionLinkDirectionLabels).toMatchObject({ continues: "接續自", continued_by: "後續", related: "相關" });
    expect(sessionLinkOptions).toHaveLength(3);
    expect(voidedFilterOptions.map(({ value }) => value)).toEqual(["exclude", "include", "only"]);
    expect(listPageSizeOptions).toHaveLength(5);
    expect(pageSizeToQuery("all")).toBe(0);
    expect(pageSizeToQuery(50)).toBe(50);
    expect(reportTabOptions.find(({ id }) => id === "raw")?.shortLabel).toBe("原始紀錄");
    expect(workSummarySectionLabels).toHaveLength(5);
    expect(statusDescriptions.tracked).toContain("明確授權");
    expect(changedFileSourceLabels.worktree).toBe("工作樹");
    expect(changedFileChangeStatusLabels.renamed).toBe("重新命名");
    expect(reportPeriodLabels.custom).toBe("自訂期間");
    expect(insightKindLabels.metadata).toBe("Metadata");
    expect(evidenceKindLabels.attached).toBe("Attached evidence");
    expect(knowledgeAuditActionLabels.restored).toBe("恢復");
    expect(graphNodeKindOrder).toEqual(["project", "session", "knowledge", "evidence", "file"]);
    expect(graphNodeKindLabels.file).toBe("變更檔案");
    expect(graphEdgeKindLabels.session_link).toBe("Session 關聯");
    expect(graphMetadataLabels.rootPath).toBe("專案根目錄");
  });

  it("maps domain states to visuals and distinguishes missing from not-run verification", () => {
    expect(databaseInspectionStatus.ok.label).toBe("正常");
    expect(databaseInspectionStatus.unreadable.tone).toBe("danger");
    expect(databaseMaintenanceStatus.running.label).toBe("執行中");
    expect(databaseMaintenanceStatus.completed.label).toBe("成功");
    expect(databaseMaintenanceStatus.failed.label).toBe("失敗");
    expect(verificationStatus.not_supplied.label).toBe("未回報");
    expect(trackingStatus.tracked.label).toBe("記錄中");
    expect(requestStatus.cancelled.label).toBe("已取消");
    expect(metadataGapStatus.changed_files.label).toBe("檔案 metadata 缺漏");
    expect(knowledgeStatusVisual.archived.label).toBe("已封存");
    expect(knowledgeKindVisual.gotcha.label).toBe("注意事項");
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
      }),
    ).toMatchObject({ tone: "attention", label: "無法確認" });
    expect(
      mcpRuntimeStatusVisual({
        restartRequired: false,
        monitoringAvailable: true,
        activeProcesses: 0,
        outdatedProcesses: 0,
      }),
    ).toMatchObject({ tone: "neutral", label: "尚無可監測連線" });
  });
});

describe("hotspotRiskVisual", () => {
  it("labels the failure share so the meaning never depends on color alone", () => {
    expect(hotspotRiskVisual({ sessionCount: 10, failedCount: 3 })).toMatchObject({
      tone: "danger",
      label: "失敗比例高",
    });
    expect(hotspotRiskVisual({ sessionCount: 10, failedCount: 1 })).toMatchObject({
      tone: "attention",
      label: "曾驗證失敗",
    });
    expect(hotspotRiskVisual({ sessionCount: 10, failedCount: 0 })).toMatchObject({
      tone: "success",
      label: "未曾失敗",
    });
    expect(hotspotRiskVisual({ sessionCount: 0, failedCount: 0 })).toMatchObject({ tone: "success" });
  });
});
