import { useQueryCache } from "@pinia/colada";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import type { StoreRequest } from "../helpers/store-harness.js";
import { createStoreHarness, jsonResponse } from "../helpers/store-harness.js";
import { useBackupsStore } from "../../../apps/web/src/stores/backups.js";
import { useGraphStore } from "../../../apps/web/src/stores/graph.js";
import { useHandoffImportStore } from "../../../apps/web/src/stores/handoff-import.js";
import { useKnowledgeStore } from "../../../apps/web/src/stores/knowledge.js";
import { useMetadataBackfillStore } from "../../../apps/web/src/stores/metadata-backfill.js";
import { useProjectDataTransferStore } from "../../../apps/web/src/stores/project-data-transfer.js";
import { t } from "../../../apps/web/src/i18n/index.js";

const mocks = vi.hoisted(() => ({ showToast: vi.fn(), confirmAction: vi.fn(async () => true) }));

vi.mock("../../../apps/web/src/composables/useToast", () => ({
  useToast: () => ({ showToast: mocks.showToast }),
}));
vi.mock("../../../apps/web/src/composables/useConfirm", () => ({ confirmAction: mocks.confirmAction }));

let harness: ReturnType<typeof createStoreHarness>;
let backupDeleteOutcome: "deleted" | "missing";
let exportFailure: boolean;
let importChanged: boolean;
let stagedGone: boolean;
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
const stagedHeader = {
  schemaVersion: 40,
  exportedAt: "2026-09-27T00:00:00.000Z",
  scope: { type: "all" },
  projects: [
    { id: "project-1", name: "Alpha" },
    { id: "project-2", name: "Beta" },
  ],
};
const importPreview = {
  outcome: "project_data_import_preview",
  strategy: "newer-wins",
  additions: { projects: 1 },
  skipped: {},
  conflicts: {},
  updates: { sessions: 2 },
  keptLocal: { sessions: 1 },
  renumbered: {},
  selectedProjects: [],
  remappedPaths: [],
  autoRemaps: [],
  conflictDetails: [],
  conflictDetailsTruncated: false,
  conflictGroups: [],
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
    const page = Number(url.searchParams.get("page") ?? 1);
    const pageSize = Number(url.searchParams.get("pageSize") ?? 10);
    return {
      outcome: "knowledge",
      items: [{ id: "knowledge-1", title: "Pattern" }],
      projects: [],
      pageInfo: { page, pageSize, total: 1, totalPages: 1 },
    };
  }
  if (url.pathname === "/api/knowledge/knowledge-1/history") {
    if (knowledgeHistoryMode === "missing") return { outcome: "not_found" };
    return {
      outcome: "knowledge_history",
      history: [{ id: "history-1" }],
      feedback: [{ id: "feedback-1", kind: "applied" }],
    };
  }
  if (url.pathname === "/api/knowledge/candidates") {
    return {
      outcome: "knowledge_candidates",
      items: [{ id: "candidate-1" }],
      openRequests: [],
      backlog: [
        { projectId: "project-1", uncoveredSessions: 7, highValueSessions: 3 },
        { projectId: "project-2", uncoveredSessions: 2, highValueSessions: 0 },
      ],
    };
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
  if (url.pathname === "/api/import/staged" && method === "POST") {
    return jsonResponse(
      { stagingId: "stage-1", expiresAt: "2026-09-27T00:30:00.000Z", header: stagedHeader, preview: importPreview },
      201,
    );
  }
  if (url.pathname.startsWith("/api/import/staged/") && method === "DELETE") return new Response(null, { status: 204 });
  if (url.pathname.startsWith("/api/import/staged/") && stagedGone) {
    return jsonResponse({ error: "暫存的匯入檔已過期或不存在；請重新選擇檔案。", code: "not_found" }, 404);
  }
  if (url.pathname === "/api/import/staged/stage-1/preview" && method === "POST") {
    return { ...importPreview, additions: { projects: 5 } };
  }
  if (url.pathname === "/api/import/staged/stage-1" && method === "POST") {
    return {
      ...importPreview,
      outcome: "project_data_imported",
      importedAt: "2026-09-27T00:00:00.000Z",
      changed: importChanged,
    };
  }
  return {};
}

beforeEach(() => {
  backupDeleteOutcome = "deleted";
  importChanged = true;
  stagedGone = false;
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
  it("keys Knowledge list requests by every search, filter, and pagination value", async () => {
    const store = useKnowledgeStore();
    store.setKnowledgeListActive(true);
    await vi.waitFor(() => expect(harness.count("/api/knowledge")).toBe(1));

    store.knowledgeQuery = "  retry policy  ";
    store.knowledgeKind = "gotcha";
    store.knowledgeProjectId = "project-1";
    store.knowledgeStatus = "archived";
    store.knowledgePage = 2;
    store.knowledgePageSize = 20;
    store.loadKnowledge();

    await vi.waitFor(() => expect(harness.count("/api/knowledge")).toBe(2));
    const filteredRequest = harness.calls.filter(({ url }) => url.pathname === "/api/knowledge")[1];
    expect(filteredRequest?.url.searchParams.get("q")).toBe("retry policy");
    expect(filteredRequest?.url.searchParams.get("kind")).toBe("gotcha");
    expect(filteredRequest?.url.searchParams.get("projectId")).toBe("project-1");
    expect(filteredRequest?.url.searchParams.get("status")).toBe("archived");
    expect(filteredRequest?.url.searchParams.get("page")).toBe("2");
    expect(filteredRequest?.url.searchParams.get("pageSize")).toBe("20");

    store.knowledgePage = 3;
    await vi.waitFor(() => expect(harness.count("/api/knowledge")).toBe(3));
    expect(harness.calls.filter(({ url }) => url.pathname === "/api/knowledge")[2]?.url.searchParams.get("page")).toBe(
      "3",
    );
  });

  it("loads backup records, creates a snapshot, and reports a localized load error", async () => {
    const store = useBackupsStore();
    store.setBackupsActive(true);
    await vi.waitFor(() => expect(harness.count("/api/backups")).toBe(1));
    expect(store.backups).toEqual([backup]);
    expect(store.backupKeep).toBe(3);
    await store.createBackup();
    await vi.waitFor(() => expect(harness.count("/api/backups")).toBeGreaterThan(1));
    expect(mocks.showToast).toHaveBeenCalledWith(t("projects.backedUpTheCurrentData"), "success");

    harness.setResponder(({ url }) =>
      url.pathname === "/api/backups"
        ? jsonResponse({ code: "service_unavailable", error: "temporarily unavailable" }, 503)
        : resourceResponder({ url, method: "GET", body: undefined, signal: undefined }),
    );
    await store.loadBackups();
    expect(store.backupsError).toBe(t("format.theServiceIsTemporarilyUnavailable"));
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
    expect(mocks.showToast).toHaveBeenLastCalledWith(
      t("projects.deletedBackup", { fileName: "backup-1.sqlite" }),
      "success",
    );

    backupDeleteOutcome = "missing";
    await store.deleteBackup(backup as never);
    expect(mocks.showToast).toHaveBeenLastCalledWith(t("projects.backupNotFoundRefreshThe"), "danger");

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
    expect(mocks.showToast).toHaveBeenLastCalledWith(t("format.theServiceIsTemporarilyUnavailable"), "danger");
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
    expect(mocks.showToast).toHaveBeenCalledWith(t("graph.theGraphFinishedLoading"));
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
    expect(store.handoffDecisionLabel({ decision: "already_imported" } as never)).toBe(t("projects.imported"));
    expect(store.handoffDecisionLabel({ decision: "excluded", reason: "excluded_by_user" } as never)).toBe(
      t("projects.excludedByYou"),
    );
    expect(store.handoffDecisionLabel({ decision: "excluded", reason: "blocked" } as never)).toBe(
      t("projects.blockedSkipped"),
    );
    expect(store.handoffDecisionLabel({ decision: "excluded", reason: "pending" } as never)).toBe(
      t("projects.pendingSkipped"),
    );
    expect(store.handoffDecisionLabel({ decision: "excluded", reason: "planning_only" } as never)).toBe(
      t("projects.planningOnlySkipped"),
    );
    expect(store.handoffDecisionLabel({ decision: "excluded", reason: "not_regular_file" } as never)).toBe(
      t("projects.notRegularFileSkipped"),
    );
    expect(store.handoffDecisionLabel({ decision: "error" } as never)).toBe(t("projects.readFailed"));
    expect(store.handoffDecisionLabel({ decision: "excluded", reason: "missing_status" } as never)).toBe(
      t("projects.completionStatusMissing"),
    );
    store.selectAllHandoffs();
    await store.applyHandoffImport();
    expect(harness.count("/api/imports/handoffs", "POST")).toBe(1);
    expect(store.handoffImportPreview).toBeNull();
    expect(store.handoffImportApplying).toBe(false);
    expect(mocks.showToast).toHaveBeenCalledWith(
      t("projects.importedHandoffsSkippedFailed", { length: 1, length2: 0, length3: 0 }),
    );
  });

  it("loads Knowledge, history, and candidates, then refreshes the active list after an edit", async () => {
    const store = useKnowledgeStore();
    await store.loadKnowledge();
    await vi.waitFor(() => expect(store.knowledgeItems[0]?.title).toBe("Pattern"));
    await store.loadKnowledgeHistory("knowledge-1", "/projects/alpha");
    expect(store.knowledgeHistory).toHaveLength(1);
    expect(store.knowledgeFeedback).toEqual([{ id: "feedback-1", kind: "applied" }]);
    await store.loadCandidates("/projects/alpha");
    await vi.waitFor(() => expect(store.candidates).toHaveLength(1));
    expect(store.candidatesLoading).toBe(false);
    expect(store.candidateBacklog).toEqual({ uncoveredSessions: 9, highValueSessions: 3 });

    await store.updateKnowledge({ knowledgeId: "knowledge-1", title: "Updated" } as never);
    await vi.waitFor(() => expect(harness.count("/api/knowledge")).toBeGreaterThan(1));
    expect(harness.count("/api/knowledge/knowledge-1", "PATCH")).toBe(1);
  });

  it("reports Knowledge query outcomes and refreshes matching candidate queries after decisions", async () => {
    const store = useKnowledgeStore();
    knowledgeListMode = "skipped";
    await store.loadKnowledge();
    await vi.waitFor(() => expect(store.knowledgeError).toBe("Knowledge 已暫停。"));
    knowledgeListMode = "error";
    await store.retryKnowledge();
    expect(store.knowledgeError).toBe(t("format.theServiceIsTemporarilyUnavailable"));

    knowledgeHistoryMode = "missing";
    await store.loadKnowledgeHistory("knowledge-1", "/projects/alpha");
    expect(store.knowledgeHistoryError).toBe(t("knowledge.knowledgeGone"));
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

  it("keeps an exact project/request query instead of applying the global-only scope", async () => {
    const store = useMetadataBackfillStore();
    store.projectId = "project-1";
    store.requestId = "exact-request";
    await store.loadMetadataBackfillRequest();
    const call = harness.calls.find(({ url }) => url.pathname === "/api/backfill/metadata-requests");
    expect(Object.fromEntries(call?.url.searchParams ?? [])).toEqual({
      scopeType: "project",
      limit: "1",
      projectId: "project-1",
      requestId: "exact-request",
    });
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
    expect(store.metadataBackfillError).toBe(t("format.theServiceIsTemporarilyUnavailable"));
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

  describe("staged project import", () => {
    function exportFile(name = "work.json", size = 500): File {
      const file = new File(["{}"], name, { type: "application/json" });
      Object.defineProperty(file, "size", { value: size });
      return file;
    }

    function pathsOf(method: string, prefix = "/api/import/staged"): string[] {
      return harness.calls
        .filter((call) => call.method === method && call.url.pathname.startsWith(prefix))
        .map((call) => call.url.pathname);
    }

    it("refuses files over 256 MiB before sending anything", async () => {
      const store = useProjectDataTransferStore();
      await store.loadImportFile(undefined);
      await store.loadImportFile(exportFile("large.json", 256 * 1024 * 1024 + 1));
      expect(store.importError).toBe(t("projects.importFilesCannotExceedLimit", { value: 256 }));
      expect(harness.fetchMock).not.toHaveBeenCalled();
    });

    it("streams the File to the API without reading it and seeds the first preview", async () => {
      const store = useProjectDataTransferStore();
      const file = exportFile();
      const text = vi.spyOn(file, "text");
      const parse = vi.spyOn(JSON, "parse");
      await store.loadImportFile(file);
      const stage = harness.calls.find((call) => call.url.pathname === "/api/import/staged");
      expect(stage?.rawBody).toBe(file);
      expect(stage?.url.searchParams.get("strategy")).toBe("newer-wins");
      expect(text).not.toHaveBeenCalled();
      expect(parse.mock.calls.some(([value]) => value === "{}")).toBe(false);
      expect(store.importError).toBe("");
      expect(store.importFileName).toBe("work.json");
      expect(store.importProjects).toEqual(stagedHeader.projects);
      expect(store.importPreview?.outcome).toBe("project_data_import_preview");
      expect(store.importPreview?.additions).toEqual({ projects: 1 });
      await nextTick();
      // The seeded preview needs no second request, and the default scope change does not trigger one.
      expect(harness.count("/api/import/staged/stage-1/preview", "POST")).toBe(0);
      expect(store.importUploading).toBe(false);
      expect(store.importLoading).toBe(false);
    });

    it("defaults the scope to the project of a single-project export", async () => {
      const store = useProjectDataTransferStore();
      harness.setResponder((request) =>
        request.url.pathname === "/api/import/staged" && request.method === "POST"
          ? jsonResponse(
              {
                stagingId: "stage-1",
                expiresAt: "2026-09-27T00:30:00.000Z",
                header: { ...stagedHeader, scope: { type: "project", projectId: "project-2" } },
                preview: importPreview,
              },
              201,
            )
          : resourceResponder(request),
      );
      await store.loadImportFile(exportFile());
      await nextTick();
      expect(store.importProjectId).toBe("project-2");
      expect(harness.count("/api/import/staged/stage-1/preview", "POST")).toBe(0);
    });

    it("shows an uploading state and shows the server message when staging fails", async () => {
      const store = useProjectDataTransferStore();
      let release: () => void = () => undefined;
      harness.setResponder(async (request) => {
        if (request.url.pathname === "/api/import/staged") {
          await new Promise<void>((resolve) => (release = resolve));
          return jsonResponse({ error: "匯入檔格式錯誤：缺少 tables。", code: "invalid_input" }, 400);
        }
        return resourceResponder(request);
      });
      const pending = store.loadImportFile(exportFile());
      expect(store.importUploading).toBe(true);
      expect(store.importLoading).toBe(true);
      release();
      await pending;
      expect(store.importUploading).toBe(false);
      expect(store.importError).toBe("匯入檔格式錯誤：缺少 tables。");
      expect(store.importFileName).toBe("");
      expect(store.importPreview).toBeNull();
    });

    it("re-previews through the staged endpoint when the choices change", async () => {
      const store = useProjectDataTransferStore();
      await store.loadImportFile(exportFile());
      store.importProjectId = "project-2";
      await vi.waitFor(() => expect(harness.count("/api/import/staged/stage-1/preview", "POST")).toBe(1));
      await vi.waitFor(() => expect(store.importPreview?.additions).toEqual({ projects: 5 }));
      expect(harness.calls.find((call) => call.url.pathname.endsWith("/preview"))?.body).toEqual({
        projectId: "project-2",
        strategy: "newer-wins",
      });
      store.importStrategy = "merge";
      await vi.waitFor(() => expect(harness.count("/api/import/staged/stage-1/preview", "POST")).toBe(2));
      expect(harness.calls.filter((call) => call.url.pathname.endsWith("/preview")).at(-1)?.body).toEqual({
        projectId: "project-2",
        strategy: "merge",
      });
      expect(harness.count("/api/import/preview", "POST")).toBe(0);
    });

    it("applies the staged import with the current choices, invalidates, and resets", async () => {
      const store = useProjectDataTransferStore();
      await store.loadImportFile(exportFile());
      mocks.confirmAction.mockResolvedValueOnce(false);
      await store.applyProjectDataImport();
      expect(harness.count("/api/import/staged/stage-1", "POST")).toBe(0);

      const invalidate = vi.spyOn(useQueryCache(), "invalidateQueries");
      await store.applyProjectDataImport();
      expect(mocks.confirmAction).toHaveBeenLastCalledWith(
        expect.objectContaining({
          message: t("projects.recordsWillBeAddedAnd", {
            additions: 1,
            updates: 2,
            keptLocal: 1,
            skipped: 0,
            conflicts: 0,
          }),
        }),
      );
      expect(harness.calls.find((call) => call.url.pathname === "/api/import/staged/stage-1")?.body).toEqual({
        strategy: "newer-wins",
      });
      expect(harness.count("/api/import", "POST")).toBe(0);
      await vi.waitFor(() => expect(invalidate).toHaveBeenCalledWith({ key: ["projects"], exact: true }));
      expect(mocks.showToast).toHaveBeenLastCalledWith(
        t("projects.importFinishedAddedSkippedIn", { value: 1, updates: 2, value2: 0, value3: 0 }),
        "success",
      );
      expect(store.importFileName).toBe("");
      expect(store.importProjects).toEqual([]);
      expect(store.importPreview).toBeNull();
      expect(store.importLoading).toBe(false);
      // The server removed the staged file itself, so no cancel request is sent.
      expect(pathsOf("DELETE")).toEqual([]);

      importChanged = false;
      await store.loadImportFile(exportFile());
      await store.applyProjectDataImport();
      expect(mocks.showToast).toHaveBeenLastCalledWith(t("projects.importFinishedNothingChanged"), "success");
    });

    it("discards the previous staging when another file replaces it", async () => {
      const store = useProjectDataTransferStore();
      await store.loadImportFile(exportFile("first.json"));
      await store.loadImportFile(exportFile("second.json"));
      await vi.waitFor(() => expect(pathsOf("DELETE")).toEqual(["/api/import/staged/stage-1"]));
      expect(harness.calls.find((call) => call.method === "DELETE")?.body).toEqual({});
      expect(store.importFileName).toBe("second.json");

      await store.loadImportFile(undefined);
      await vi.waitFor(() => expect(pathsOf("DELETE")).toHaveLength(2));
      expect(store.importFileName).toBe("");
      expect(store.importPreview).toBeNull();
    });

    it("ignores a failing discard request", async () => {
      const store = useProjectDataTransferStore();
      harness.setResponder((request) =>
        request.method === "DELETE"
          ? jsonResponse({ error: "boom", code: "internal_error" }, 500)
          : resourceResponder(request),
      );
      await store.loadImportFile(exportFile());
      await store.loadImportFile(undefined);
      await vi.waitFor(() => expect(pathsOf("DELETE")).toHaveLength(1));
      expect(store.importError).toBe("");
    });

    it("resets and shows the server message when the staged file expired during preview", async () => {
      const store = useProjectDataTransferStore();
      await store.loadImportFile(exportFile());
      stagedGone = true;
      await store.previewProjectDataImport();
      expect(store.importError).toBe("暫存的匯入檔已過期或不存在；請重新選擇檔案。");
      expect(store.importFileName).toBe("");
      expect(store.importProjects).toEqual([]);
      expect(store.importPreview).toBeNull();
      // Nothing is left to cancel on the server.
      expect(pathsOf("DELETE")).toEqual([]);
    });

    it("resets and shows the server message when the staged file expired before import", async () => {
      const store = useProjectDataTransferStore();
      await store.loadImportFile(exportFile());
      stagedGone = true;
      await store.applyProjectDataImport();
      expect(store.importError).toBe("暫存的匯入檔已過期或不存在；請重新選擇檔案。");
      expect(store.importFileName).toBe("");
      expect(store.importPreview).toBeNull();
      expect(store.importLoading).toBe(false);
    });
  });

  it("exports project data and reports a failed export", async () => {
    const store = useProjectDataTransferStore();
    exportFailure = true;
    await store.exportProjectData({ type: "all" });
    expect(store.transferError).toBe(t("format.theServiceIsTemporarilyUnavailable"));
    expect(store.portableExporting).toBe(false);
  });
});
