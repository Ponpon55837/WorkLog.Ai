import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { PROJECT_DATA_TABLES } from "../../../packages/core/src/index.js";
import type { StoreRequest } from "../helpers/store-harness.js";
import { createStoreHarness, jsonResponse } from "../helpers/store-harness.js";
import { useBackupsStore } from "../../../apps/web/src/stores/backups.js";
import { useGraphStore } from "../../../apps/web/src/stores/graph.js";
import { useHandoffImportStore } from "../../../apps/web/src/stores/handoff-import.js";
import { useKnowledgeStore } from "../../../apps/web/src/stores/knowledge.js";
import { useMetadataBackfillStore } from "../../../apps/web/src/stores/metadata-backfill.js";
import { useProjectDataTransferStore } from "../../../apps/web/src/stores/project-data-transfer.js";

const mocks = vi.hoisted(() => ({ showToast: vi.fn(), confirmAction: vi.fn(async () => true) }));

vi.mock("../../../apps/web/src/composables/useToast", () => ({
  useToast: () => ({ showToast: mocks.showToast }),
}));
vi.mock("../../../apps/web/src/composables/useConfirm", () => ({ confirmAction: mocks.confirmAction }));

let harness: ReturnType<typeof createStoreHarness>;
let backupDeleteOutcome: "deleted" | "missing";
let exportFailure: boolean;
let knowledgeListMode: "normal" | "skipped" | "error";
let knowledgeHistoryMode: "normal" | "missing";
let backfillPreviewMode: "normal" | "empty" | "error";
let backfillCreateMode: "created" | "not-needed";
let backfillCancelMode: "cancelled" | "not-cancellable";

const backup = { kind: "manual", fileName: "backup-1.sqlite", createdAt: "2026-09-27T00:00:00.000Z", bytes: 10 };
const project = {
  id: "project-1",
  name: "Alpha",
  rootPath: "/projects/alpha",
  status: "tracked",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};
const backfillRequest = {
  id: "backfill-1",
  idempotencyKey: "request-1",
  scopeType: "all",
  status: "pending",
  requestedAt: "2026-09-27T00:00:00.000Z",
  sourceSessionIds: ["session-1"],
};

function resourceResponder({ url, method }: StoreRequest): unknown {
  if (url.pathname === "/api/backups" && method === "GET") {
    return { outcome: "database_backups", keep: 3, automaticKeep: 7, backups: [backup] };
  }
  if (url.pathname === "/api/backups" && method === "POST") {
    return { outcome: "database_backups", keep: 3, automaticKeep: 7, backups: [backup], created: backup };
  }
  if (url.pathname === "/api/backups/backup-1.sqlite" && method === "DELETE") {
    return backupDeleteOutcome === "deleted"
      ? { outcome: "backup_deleted", keep: 3, automaticKeep: 7, backups: [], deleted: backup }
      : { outcome: "backup_not_found" };
  }
  if (url.pathname === "/api/export" && exportFailure) {
    return jsonResponse({ code: "service_unavailable", error: "unavailable" }, 503);
  }
  if (url.pathname === "/api/graph") {
    const isNext = url.searchParams.has("cursor");
    return {
      outcome: "graph",
      projects: [project],
      nodes: isNext
        ? [
            { id: "session-1", kind: "session", label: "duplicate", metadata: {} },
            { id: "file-1", kind: "file", label: "file", metadata: {} },
          ]
        : [{ id: "session-1", kind: "session", label: "session", metadata: {} }],
      edges: [],
      totalNodes: 2,
      totalEdges: 0,
      totalNodesByKind: { project: 0, session: 1, knowledge: 0, evidence: 0, file: 1 },
      sourceProjectIds: ["project-1"],
      sourceSessionIds: isNext ? ["session-1", "session-2"] : ["session-1"],
      truncation: { nodeLimit: 180, edgeLimit: 360, nodesTruncated: false, edgesTruncated: false },
      ...(isNext ? {} : { nextCursor: "cursor-2" }),
    };
  }
  if (url.pathname === "/api/imports/handoffs/preview") {
    return {
      outcome: "preview",
      project,
      projectStatus: "tracked",
      handoffDirectory: "/projects/alpha/.handoffs",
      directoryFound: true,
      truncated: false,
      items: [
        {
          sourcePath: ".handoffs/eligible.md",
          title: "Eligible",
          decision: "eligible",
          changedFiles: [],
          changedFilesStatus: "present",
        },
        {
          sourcePath: ".handoffs/pending.md",
          title: "Pending",
          decision: "pending",
          reason: "pending",
          changedFiles: [],
          changedFilesStatus: "missing",
        },
      ],
      totals: { discovered: 2, eligible: 1, excluded: 0, alreadyImported: 0, errors: 0 },
    };
  }
  if (url.pathname === "/api/imports/handoffs" && method === "POST") {
    return {
      outcome: "imported",
      project,
      selectedCount: 1,
      imported: [{ id: "session-new" }],
      skipped: [],
      failures: [],
    };
  }
  if (url.pathname === "/api/knowledge") {
    if (knowledgeListMode === "skipped") return { outcome: "skipped", reason: "Knowledge 已暫停。" };
    if (knowledgeListMode === "error") return jsonResponse({ code: "service_unavailable", error: "unavailable" }, 503);
    return {
      outcome: "knowledge",
      items: [{ id: "knowledge-1", title: "Pattern" }],
      projects: [],
      pageInfo: { page: 1, pageSize: 10, total: 1, totalPages: 1 },
    };
  }
  if (url.pathname === "/api/knowledge/knowledge-1/history") {
    if (knowledgeHistoryMode === "missing") return { outcome: "not_found" };
    return { outcome: "knowledge_history", history: [{ id: "history-1" }] };
  }
  if (url.pathname === "/api/knowledge/candidates") {
    return { outcome: "knowledge_candidates", items: [{ id: "candidate-1" }], openRequests: [] };
  }
  if (url.pathname === "/api/knowledge/knowledge-1" && method === "PATCH") {
    return { outcome: "knowledge_updated", knowledge: { id: "knowledge-1", title: "Updated" } };
  }
  if (url.pathname === "/api/knowledge/candidate-requests" && method === "POST") {
    return { outcome: "knowledge_candidate_request", request: { id: "candidate-request-1" }, duplicate: false };
  }
  if (url.pathname === "/api/knowledge/candidates/candidate-1/decision") {
    return { outcome: "already_decided", candidate: { id: "candidate-1" } };
  }
  if (url.pathname === "/api/backfill/metadata/preview") {
    if (backfillPreviewMode === "error")
      return jsonResponse({ code: "service_unavailable", error: "unavailable" }, 503);
    return {
      outcome: "backfill_preview",
      scannedSessions: 1,
      truncated: false,
      items:
        backfillPreviewMode === "empty"
          ? []
          : [{ sessionId: "session-1", gaps: ["verification"], verificationStatus: "not_supplied" }],
      totals: {
        needsBackfill: backfillPreviewMode === "empty" ? 0 : 1,
        changedFilesMissing: 0,
        verificationMissing: 1,
        verificationNotRun: 0,
      },
    };
  }
  if (url.pathname === "/api/backfill/metadata-requests" && method === "POST") {
    if (backfillCreateMode === "not-needed")
      return { outcome: "metadata_backfill_not_needed", reason: "沒有需要回補的資料。" };
    return { outcome: "metadata_backfill_request", request: backfillRequest, duplicate: false };
  }
  if (url.pathname === "/api/backfill/metadata-requests/backfill-1/cancel") {
    if (backfillCancelMode === "not-cancellable")
      return { outcome: "metadata_backfill_request_not_cancellable", reason: "這批請求已完成。" };
    return { outcome: "metadata_backfill_request_cancelled", request: { ...backfillRequest, status: "cancelled" } };
  }
  if (url.pathname === "/api/import/preview") {
    return {
      outcome: "project_data_import_preview",
      additions: { projects: 1 },
      skipped: {},
      conflicts: {},
      selectedProjects: [],
      remappedPaths: [],
      conflictDetails: [],
      conflictDetailsTruncated: false,
    };
  }
  if (url.pathname === "/api/import") {
    return {
      outcome: "project_data_imported",
      additions: { projects: 1 },
      skipped: {},
      conflicts: {},
      selectedProjects: [],
      remappedPaths: [],
      conflictDetails: [],
      conflictDetailsTruncated: false,
      importedAt: "2026-09-27T00:00:00.000Z",
    };
  }
  return {};
}

beforeEach(() => {
  backupDeleteOutcome = "deleted";
  exportFailure = false;
  knowledgeListMode = "normal";
  knowledgeHistoryMode = "normal";
  backfillPreviewMode = "normal";
  backfillCreateMode = "created";
  backfillCancelMode = "cancelled";
  harness = createStoreHarness(resourceResponder);
  mocks.showToast.mockClear();
  mocks.confirmAction.mockReset().mockResolvedValue(true);
});

afterEach(async () => {
  await harness.cleanup();
  vi.restoreAllMocks();
});

describe("resource stores", () => {
  it("loads backup records, creates a snapshot, and reports a localized load error", async () => {
    const store = useBackupsStore();
    store.setBackupsActive(true);
    await vi.waitFor(() => expect(harness.count("/api/backups")).toBe(1));
    expect(store.backups).toEqual([backup]);
    expect(store.backupKeep).toBe(3);
    await store.createBackup();
    await vi.waitFor(() => expect(harness.count("/api/backups")).toBeGreaterThan(1));
    expect(mocks.showToast).toHaveBeenCalledWith("已備份目前的資料。", "success");

    harness.setResponder(({ url }) =>
      url.pathname === "/api/backups"
        ? jsonResponse({ code: "service_unavailable", error: "temporarily unavailable" }, 503)
        : resourceResponder({ url, method: "GET", body: undefined, signal: undefined }),
    );
    await store.loadBackups();
    expect(store.backupsError).toBe("服務暫時無法使用，請稍後再試。");
    store.setBackupsActive(false);
  });

  it("confirms backup removal, handles missing files, and downloads or reports export errors", async () => {
    const store = useBackupsStore();
    await store.loadBackups();
    mocks.confirmAction.mockResolvedValueOnce(false);
    await store.deleteBackup(backup as never);
    expect(harness.count("/api/backups/backup-1.sqlite", "DELETE")).toBe(0);

    await store.deleteBackup(backup as never);
    expect(harness.count("/api/backups/backup-1.sqlite", "DELETE")).toBe(1);
    expect(store.backupDeleting).toBeNull();
    expect(mocks.showToast).toHaveBeenLastCalledWith("已刪除備份：backup-1.sqlite", "success");

    backupDeleteOutcome = "missing";
    await store.deleteBackup(backup as never);
    expect(mocks.showToast).toHaveBeenLastCalledWith("找不到這份備份，請重新整理清單。", "danger");

    const anchor = { href: "", download: "", click: vi.fn() };
    vi.stubGlobal("document", { createElement: vi.fn(() => anchor) });
    vi.stubGlobal("window", { setTimeout: vi.fn() });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:database");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    await store.exportDatabase();
    expect(anchor.download).toMatch(/^work-intelligence-export-\d{8}\.sqlite$/);
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(store.databaseExporting).toBe(false);

    exportFailure = true;
    await store.exportDatabase();
    expect(mocks.showToast).toHaveBeenLastCalledWith("服務暫時無法使用，請稍後再試。", "danger");
  });

  it("pages Graph data, removes duplicate nodes, and exposes completion and selection state", async () => {
    const store = useGraphStore();
    await store.loadGraph();
    expect(store.graphCanLoadMore).toBe(true);
    await store.loadMoreGraph();
    expect(store.graph?.nodes.map((node) => node.id)).toEqual(["session-1", "file-1"]);
    expect(store.graph?.sourceSessionIds).toEqual(["session-1", "session-2"]);
    expect(store.graphCanLoadMore).toBe(false);
    const selected = store.graph?.nodes[0];
    if (!selected) throw new Error("Expected the first graph node.");
    store.selectGraphNode(selected);
    expect(store.selectedGraphNode).toEqual(selected);
    await store.loadMoreGraph();
    expect(mocks.showToast).toHaveBeenCalledWith("圖譜已載入完成。");
  });

  it("previews handoffs, filters selectable rows, applies selected imports, and clears the dialog", async () => {
    const store = useHandoffImportStore();
    await store.previewHandoffs(project as never);
    expect(store.importableHandoffs).toHaveLength(1);
    expect(store.selectedHandoffCount).toBe(0);
    store.selectAllHandoffs();
    expect(store.isHandoffSelected(".handoffs/eligible.md")).toBe(true);
    expect(store.isHandoffSelected(".handoffs/pending.md")).toBe(false);
    store.toggleHandoffSelection({ sourcePath: ".handoffs/pending.md", decision: "pending" } as never);
    expect(store.selectedHandoffCount).toBe(1);
    store.clearHandoffSelection();
    expect(store.selectedHandoffCount).toBe(0);
    expect(store.handoffDecisionLabel({ decision: "already_imported" } as never)).toBe("已匯入");
    expect(store.handoffDecisionLabel({ decision: "excluded", reason: "excluded_by_user" } as never)).toBe(
      "使用者排除",
    );
    expect(store.handoffDecisionLabel({ decision: "excluded", reason: "blocked" } as never)).toBe("Blocked，略過");
    expect(store.handoffDecisionLabel({ decision: "excluded", reason: "pending" } as never)).toBe("Pending，略過");
    expect(store.handoffDecisionLabel({ decision: "excluded", reason: "planning_only" } as never)).toBe("僅規劃，略過");
    expect(store.handoffDecisionLabel({ decision: "error" } as never)).toBe("讀取失敗");
    expect(store.handoffDecisionLabel({ decision: "excluded", reason: "missing_status" } as never)).toBe(
      "缺少完成狀態",
    );
    store.selectAllHandoffs();
    await store.applyHandoffImport();
    expect(harness.count("/api/imports/handoffs", "POST")).toBe(1);
    expect(store.handoffImportPreview).toBeNull();
    expect(store.handoffImportApplying).toBe(false);
    expect(mocks.showToast).toHaveBeenCalledWith("已匯入 1 個 handoff；略過 0 個，失敗 0 個。");
  });

  it("loads Knowledge, history, and candidates, then refreshes the active list after an edit", async () => {
    const store = useKnowledgeStore();
    await store.loadKnowledge();
    expect(store.knowledgeItems[0]?.title).toBe("Pattern");
    await store.loadKnowledgeHistory("knowledge-1", "/projects/alpha");
    expect(store.knowledgeHistory).toHaveLength(1);
    await store.loadCandidates("/projects/alpha");
    expect(store.candidates).toHaveLength(1);
    expect(store.candidatesLoading).toBe(false);

    await store.updateKnowledge({ knowledgeId: "knowledge-1", title: "Updated" } as never);
    await vi.waitFor(() => expect(harness.count("/api/knowledge")).toBeGreaterThan(1));
    expect(harness.count("/api/knowledge/knowledge-1", "PATCH")).toBe(1);
  });

  it("reports Knowledge query outcomes and refreshes matching candidate queries after decisions", async () => {
    const store = useKnowledgeStore();
    knowledgeListMode = "skipped";
    await store.loadKnowledge();
    expect(store.knowledgeError).toBe("Knowledge 已暫停。");
    knowledgeListMode = "error";
    await store.loadKnowledge();
    expect(store.knowledgeError).toBe("服務暫時無法使用，請稍後再試。");

    knowledgeHistoryMode = "missing";
    await store.loadKnowledgeHistory("knowledge-1", "/projects/alpha");
    expect(store.knowledgeHistoryError).toBe("這筆 Knowledge 已不存在。");
    store.closeKnowledgeHistory();
    expect(store.knowledgeHistory).toEqual([]);

    knowledgeListMode = "normal";
    await store.loadCandidates("/projects/alpha", true);
    expect(store.candidatesLoading).toBe(false);
    await store.requestKnowledgeCandidates("/projects/alpha", "/projects/alpha");
    await vi.waitFor(() => expect(harness.count("/api/knowledge/candidates")).toBeGreaterThan(1));
    await store.decideKnowledgeCandidate(
      { candidateId: "candidate-1", decision: "accept", sourceSessionId: "session-1" } as never,
      "/projects/alpha",
    );
    await vi.waitFor(() => expect(harness.count("/api/knowledge/candidates")).toBeGreaterThan(2));
    expect(harness.count("/api/knowledge/candidate-requests", "POST")).toBe(1);
    expect(harness.count("/api/knowledge/candidates/candidate-1/decision", "POST")).toBe(1);
  });

  it("scans metadata gaps, creates and cancels a request, keeping its request state current", async () => {
    const store = useMetadataBackfillStore();
    await store.previewMetadataBackfill();
    expect(store.metadataBackfillPreview?.items).toHaveLength(1);
    expect(store.metadataBackfillRequest?.status).toBe("pending");
    expect(store.metadataBackfillRequestIsActive).toBe(true);
    expect(mocks.showToast).toHaveBeenCalled();
    await store.cancelMetadataBackfillRequest();
    expect(harness.count("/api/backfill/metadata-requests/backfill-1/cancel", "POST")).toBe(1);
    expect(store.metadataBackfillRequest?.status).toBe("cancelled");
  });

  it("handles empty scans, quiet refreshes, API failures, declined confirms, and non-cancellable requests", async () => {
    const store = useMetadataBackfillStore();
    backfillPreviewMode = "empty";
    await store.previewMetadataBackfill();
    expect(store.metadataBackfillPreview?.items).toEqual([]);
    expect(harness.count("/api/backfill/metadata-requests")).toBe(1);
    await store.refreshMetadataBackfillRequest();
    expect(store.metadataBackfillRequestLoading).toBe(false);
    store.setMetadataBackfillActive(true);
    store.setMetadataBackfillActive(false);

    backfillPreviewMode = "error";
    await store.previewMetadataBackfill();
    expect(store.metadataBackfillError).toBe("服務暫時無法使用，請稍後再試。");
    await store.loadMetadataBackfillRequest();

    backfillPreviewMode = "normal";
    await store.previewMetadataBackfill();
    backfillCreateMode = "not-needed";
    await store.createMetadataBackfillRequest();
    expect(store.metadataBackfillRequest).toBeNull();
    expect(mocks.showToast).toHaveBeenLastCalledWith("沒有需要回補的資料。");

    backfillCreateMode = "created";
    await store.createMetadataBackfillRequest();
    mocks.confirmAction.mockResolvedValueOnce(false);
    await store.cancelMetadataBackfillRequest();
    expect(harness.count("/api/backfill/metadata-requests/backfill-1/cancel", "POST")).toBe(0);
    mocks.confirmAction.mockResolvedValueOnce(true);
    backfillCancelMode = "not-cancellable";
    await store.cancelMetadataBackfillRequest();
    expect(store.metadataBackfillRequestError).toBe("這批請求已完成。");
  });

  it("validates import files locally, previews valid bundles, and applies confirmed imports", async () => {
    const store = useProjectDataTransferStore();
    await store.loadImportFile(undefined);
    await store.loadImportFile({ name: "large.json", size: 50 * 1024 * 1024 + 1, text: async () => "" } as File);
    expect(store.importError).toBe("匯入檔不可超過 50 MiB。");
    await store.loadImportFile({ name: "broken.json", size: 8, text: async () => "{" } as File);
    expect(store.importError).toContain("JSON");
    await store.loadImportFile({ name: "wrong-shape.json", size: 8, text: async () => "{}" } as File);
    expect(store.importError).toContain("匯出檔格式錯誤：");

    const bundle = {
      format: "work-intelligence-export",
      formatVersion: 1,
      schemaVersion: 1,
      exportedAt: "2026-09-27T00:00:00.000Z",
      scope: { type: "all" },
      tables: Object.fromEntries(PROJECT_DATA_TABLES.map((table) => [table, []])),
    };
    await store.loadImportFile({ name: "work.json", size: 500, text: async () => JSON.stringify(bundle) } as File);
    expect(store.importError).toBe("");
    store.importRemapFrom = "/old-root";
    await store.previewProjectDataImport();
    expect(store.importError).toBe("請同時填寫舊路徑前綴與新路徑前綴。");
    store.importRemapTo = "/new-root";
    await nextTick();
    await store.previewProjectDataImport();
    expect(store.importPreview?.outcome).toBe("project_data_import_preview");
    mocks.confirmAction.mockResolvedValueOnce(false);
    await store.applyProjectDataImport();
    expect(harness.count("/api/import", "POST")).toBe(0);
    mocks.confirmAction.mockResolvedValueOnce(true);
    await store.applyProjectDataImport();
    expect(harness.count("/api/import/preview", "POST")).toBe(1);
    expect(harness.count("/api/import", "POST")).toBe(1);
    expect(store.importFileName).toBe("");
    expect(store.importLoading).toBe(false);
    expect(mocks.confirmAction).toHaveBeenCalledTimes(2);
    expect(store.importProjects).toEqual([]);

    exportFailure = true;
    await store.exportProjectData({ type: "all" });
    expect(store.transferError).toBe("服務暫時無法使用，請稍後再試。");
    expect(store.portableExporting).toBe(false);
  });
});
