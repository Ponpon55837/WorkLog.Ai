<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useClipboard } from "./composables/useClipboard";
import { useApiRequest } from "./composables/useApiRequest";
import GraphNodeModal from "./components/GraphNodeModal.vue";
import HandoffImportModal from "./components/HandoffImportModal.vue";
import KnowledgeEditorModal from "./components/KnowledgeEditorModal.vue";
import KnowledgeHistoryModal from "./components/KnowledgeHistoryModal.vue";
import SessionDetailModal from "./components/SessionDetailModal.vue";
import VirtualList from "./components/VirtualList.vue";
import DashboardView from "./views/DashboardView.vue";
import GraphView from "./views/GraphView.vue";
import KnowledgeView from "./views/KnowledgeView.vue";
import ProjectsView from "./views/ProjectsView.vue";
import ReportsView from "./views/ReportsView.vue";
import WorklogView from "./views/WorklogView.vue";
import type {
  ChangedFileChangeStatus,
  ChangedFileSource,
  CancelMetadataBackfillRequestResult,
  CancelReportSynthesisRequestResult,
  CreateMetadataBackfillRequestResult,
  CreateReportSynthesisRequestResult,
  DashboardSummary,
  DeleteReportSummaryResult,
  GraphEdge,
  HandoffImportBatchResult,
  HandoffImportPreview,
  HandoffImportPreviewItem,
  HandoffImportPreviewResult,
  GraphNode,
  GraphQueryResult,
  KnowledgeAuditAction,
  KnowledgeAuditRecord,
  KnowledgeKind,
  KnowledgeHistoryResult,
  KnowledgeSearchResult,
  KnowledgeRecord,
  KnowledgeStatus,
  MetadataBackfillItem,
  MetadataBackfillPreview,
  MetadataBackfillPreviewResult,
  MetadataBackfillRequest,
  MetadataBackfillRequestListQueryResult,
  PageInfo,
  ProjectRecord,
  ProjectStatus,
  ReportExportFormat,
  ReportExportResult,
  ReportEvidence,
  ReportMetricComparison,
  ReportPeriod,
  ReportQueryResult,
  ReportSynthesisRequest,
  ReportSynthesisRequestListQueryResult,
  ReportSynthesisRequestListResult,
  RetryReportSynthesisRequestResult,
  ReportSummary,
  ReportSummaryQueryResult,
  ReportVerificationStatus,
  SessionDetail,
  SessionListResult,
  UpdateKnowledgeResult,
  WorkSummarySections,
  WorkReport,
  WorkSessionRecord
} from "@work-intelligence/core";

type ViewName = "dashboard" | "projects" | "reports" | "knowledge" | "graph" | "worklog";
type ReportTab = "overview" | "work" | "trend" | "risks" | "raw" | "evidence";
const viewTitles: Record<ViewName, string> = {
  dashboard: "工作總覽",
  projects: "專案記錄管理",
  reports: "工作報告",
  knowledge: "工作知識",
  graph: "工作圖譜",
  worklog: "工作歷程"
};
const listPageSizeOptions = [
  { value: 10, label: "10" },
  { value: 20, label: "20" },
  { value: 50, label: "50" },
  { value: 100, label: "100" },
  { value: "all", label: "All" }
] as const;
type ListPageSize = (typeof listPageSizeOptions)[number]["value"];

const reportTabOptions: Array<{ id: ReportTab; label: string; shortLabel: string }> = [
  { id: "overview", label: "報告總覽", shortLabel: "總覽" },
  { id: "work", label: "完成與驗證", shortLabel: "工作" },
  { id: "trend", label: "趨勢與專案", shortLabel: "趨勢" },
  { id: "risks", label: "風險與決策", shortLabel: "風險" },
  { id: "raw", label: "原始工作紀錄", shortLabel: "原始紀錄" },
  { id: "evidence", label: "來源證據", shortLabel: "證據" }
];

const workSummarySectionLabels: Array<{ key: keyof WorkSummarySections; label: string }> = [
  { key: "outcomes", label: "成果" },
  { key: "scope", label: "範圍" },
  { key: "decisions", label: "決策" },
  { key: "verification", label: "驗證" },
  { key: "nextSteps", label: "狀態／未結項" }
];

const emptyPageInfo: PageInfo = {
  page: 1,
  pageSize: 20,
  total: 0,
  totalPages: 1,
  from: 0,
  to: 0,
  hasPrevious: false,
  hasNext: false,
  truncated: false
};

const emptyDashboard: DashboardSummary = {
  trackedProjects: 0,
  activeProjects: 0,
  finalizedSessions: 0,
  recordedEvents: 0,
  recentSessions: []
};

const statusLabels: Record<ProjectStatus, string> = {
  unregistered: "未註冊",
  tracked: "記錄中",
  paused: "已暫停",
  ignored: "已忽略"
};

const statusDescriptions: Record<ProjectStatus, string> = {
  unregistered: "尚未授權，所有 ingest 都會略過。",
  tracked: "明確授權；可讀取 handoff 並保存工作紀錄。",
  paused: "暫停記錄，既有資料保留。",
  ignored: "明確排除，不會建立新的工作資料。"
};

const changedFileSourceLabels: Record<ChangedFileSource, string> = {
  agent: "Agent",
  handoff: "Handoff",
  git: "Git",
  worktree: "工作樹"
};

const changedFileChangeStatusLabels: Record<ChangedFileChangeStatus, string> = {
  added: "新增",
  modified: "修改",
  deleted: "刪除",
  renamed: "重新命名"
};

const reportPeriodLabels: Record<ReportPeriod, string> = {
  day: "今日",
  week: "本週",
  month: "本月",
  quarter: "本季",
  year: "本年"
};

const reportSynthesisStatusLabels: Record<ReportSynthesisRequest["status"], string> = {
  pending: "等待 Agent 處理",
  processing: "Agent 處理中",
  completed: "提煉完成",
  failed: "處理失敗／可重試",
  cancelled: "已取消／可重試"
};

const metadataBackfillStatusLabels: Record<MetadataBackfillRequest["status"], string> = {
  pending: "等待 Agent 處理",
  processing: "Agent 處理中",
  completed: "回補完成",
  failed: "處理失敗",
  cancelled: "已取消／可重建"
};

const reportSynthesisIsActive = computed(() => {
  const status = reportSynthesisRequest.value?.status;
  return status === "pending" || status === "processing";
});

const reportSynthesisCanRetry = computed(() => {
  const status = reportSynthesisRequest.value?.status;
  return status === "failed" || status === "cancelled";
});

const metadataBackfillRequestIsActive = computed(() => {
  const status = metadataBackfillRequest.value?.status;
  return status === "pending" || status === "processing";
});

const verificationLabels: Record<ReportVerificationStatus, string> = {
  passed: "Passed",
  failed: "Failed",
  not_run: "未執行",
  not_supplied: "待 Agent 回報"
};

const executionStatusLabels: Record<WorkSessionRecord["executionStatus"], string> = {
  completed: "已完成"
};

const insightKindLabels: Record<"verification" | "metadata" | "event", string> = {
  verification: "Verification",
  metadata: "Metadata",
  event: "Event"
};

const evidenceKindLabels: Record<ReportEvidence["kind"], string> = {
  handoff: "Handoff",
  verification: "Verification",
  "changed-files": "Changed files",
  event: "Event",
  attached: "Attached evidence"
};

const knowledgeKindLabels: Record<KnowledgeKind, string> = {
  decision: "技術決策",
  pattern: "可重用模式",
  gotcha: "注意事項",
  procedure: "操作流程",
  skill: "技能"
};

const knowledgeStatusLabels: Record<KnowledgeStatus, string> = {
  active: "使用中",
  archived: "已封存"
};

const knowledgeAuditActionLabels: Record<KnowledgeAuditAction, string> = {
  created: "建立",
  updated: "更新",
  archived: "封存",
  restored: "恢復"
};

const graphNodeKindLabels: Record<GraphNode["kind"], string> = {
  project: "專案",
  session: "工作 Session",
  knowledge: "工作知識",
  evidence: "證據",
  file: "變更檔案"
};

const graphEdgeKindLabels = {
  contains: "包含",
  changed_file: "變更檔案",
  has_knowledge: "關聯知識",
  has_evidence: "附加證據"
} as const;

const route = useRoute();
const router = useRouter();
const routeView = computed<ViewName>(() => {
  const view = route.meta.view;
  return typeof view === "string" && view in viewTitles ? view as ViewName : "dashboard";
});
const activeView = ref<ViewName>(routeView.value);
watch(routeView, (view) => {
  activeView.value = view;
});
const dashboard = ref<DashboardSummary>(emptyDashboard);
const projects = ref<ProjectRecord[]>([]);
const sessions = ref<WorkSessionRecord[]>([]);
const report = ref<WorkReport | null>(null);
const reportPeriod = ref<ReportPeriod>("week");
const reportDate = ref("");
const reportProjectId = ref("");
const reportTab = ref<ReportTab>("overview");
const reportLoading = ref(false);
const reportError = ref("");
const reportExportLoading = ref<ReportExportFormat | null>(null);
const reportEvidenceLoading = ref(false);
const reportEvidencePage = ref(1);
const reportEvidencePageSize = ref<ListPageSize>(10);
const reportEvidenceKind = ref<ReportEvidence["kind"] | "">("");
const reportEvidenceQuery = ref("");
const reportSessionItems = ref<WorkSessionRecord[]>([]);
const reportSessionPage = ref(1);
const reportSessionPageSize = ref<ListPageSize>(10);
const reportSessionPageInfo = ref<PageInfo>({ ...emptyPageInfo, pageSize: 10 });
const reportSessionLoading = ref(false);
const reportSynthesisRequest = ref<ReportSynthesisRequest | null>(null);
const reportSynthesisSummary = ref<ReportSummary | null>(null);
const reportSynthesisHistory = ref<ReportSummary[]>([]);
const reportSynthesisExpanded = ref(false);
const reportSynthesisLoading = ref(false);
const reportSynthesisCreating = ref(false);
const reportSynthesisRetrying = ref(false);
const reportSynthesisCancelling = ref(false);
const reportSynthesisError = ref("");
const reportSynthesisInstruction = "請處理我剛在 Work Intelligence 建立的報告提煉請求。";
const knowledgeItems = ref<KnowledgeRecord[]>([]);
const knowledgeProjects = ref<ProjectRecord[]>([]);
const knowledgePage = ref(1);
const knowledgePageSize = ref<ListPageSize>(10);
const knowledgePageInfo = ref<PageInfo>({ ...emptyPageInfo, pageSize: 10 });
const knowledgeQuery = ref("");
const knowledgeKind = ref<KnowledgeKind | "">("");
const knowledgeProjectId = ref("");
const knowledgeStatus = ref<KnowledgeStatus>("active");
const knowledgeLoading = ref(false);
const knowledgeError = ref("");
const knowledgeEditor = ref<KnowledgeRecord | null>(null);
const knowledgeEditorForm = ref({
  kind: "pattern" as KnowledgeKind,
  title: "",
  body: "",
  tags: "",
  references: "",
  status: "active" as KnowledgeStatus
});
const knowledgeEditorSaving = ref(false);
const knowledgeEditorError = ref("");
const knowledgeHistoryItem = ref<KnowledgeRecord | null>(null);
const knowledgeHistory = ref<KnowledgeAuditRecord[]>([]);
const knowledgeHistoryLoading = ref(false);
const knowledgeHistoryError = ref("");
const graph = ref<Extract<GraphQueryResult, { outcome: "graph" }> | null>(null);
const graphProjectId = ref("");
type GraphNodeFilter = GraphNode["kind"] | "all";
const graphNodeFilter = ref<GraphNodeFilter>("all");
const graphPreviewLimit = ref(120);
const graphLoadPreset = ref("180");
const graphLoadPresetOptions = [
  { value: "180", label: "180 節點 / 360 關係", maxNodes: 180, maxEdges: 360 },
  { value: "300", label: "300 節點 / 720 關係", maxNodes: 300, maxEdges: 720 },
  { value: "500", label: "500 節點 / 1,000 關係", maxNodes: 500, maxEdges: 1_000 }
] as const;
const graphLoading = ref(false);
const graphError = ref("");
const selectedGraphNode = ref<GraphNode | null>(null);
const selectedDetail = ref<SessionDetail | null>(null);
const detailModalContent = ref<HTMLElement | null>(null);
const searchTerm = ref("");
const selectedProjectId = ref("");
const sessionPage = ref(1);
const sessionPageSize = ref<ListPageSize>(10);
const sessionPageInfo = ref<PageInfo>({ ...emptyPageInfo, pageSize: 10 });
const dateFrom = ref("");
const dateTo = ref("");
const sessionFilterError = ref("");
type DatePickerTarget = "from" | "to";
const activeDatePicker = ref<DatePickerTarget | null>(null);
const pickerMonth = ref(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
const dateFromTrigger = ref<HTMLButtonElement | null>(null);
const dateToTrigger = ref<HTMLButtonElement | null>(null);
const datePickerStyle = ref<Record<string, string>>({});
const loading = ref(true);
const errorMessage = ref("");
const toastMessage = ref("");
const projectName = ref("");
const projectRoot = ref("");
const addingProject = ref(false);
const handoffImportPreview = ref<HandoffImportPreview | null>(null);
const handoffImportProjectId = ref("");
const handoffImportSelection = ref<string[]>([]);
const handoffImportLoading = ref(false);
const handoffImportApplying = ref(false);
const handoffImportError = ref("");
const metadataBackfillPreview = ref<MetadataBackfillPreview | null>(null);
const metadataBackfillLoading = ref(false);
const metadataBackfillError = ref("");
const metadataBackfillRequest = ref<MetadataBackfillRequest | null>(null);
const metadataBackfillRequestLoading = ref(false);
const metadataBackfillRequestCreating = ref(false);
const metadataBackfillRequestError = ref("");
const metadataBackfillInstruction = "請處理我剛在 Work Intelligence 掃描出的 metadata 缺口。";

const apiBase = import.meta.env.VITE_API_URL ?? "";
const apiRequest = useApiRequest(apiBase);
const { client, beginRequest, isCurrentRequest, finishRequest, isAbortError } = apiRequest;
const { copyText } = useClipboard();

async function loadDashboard(): Promise<void> {
  const key = "dashboard";
  const controller = beginRequest(key);
  try {
    dashboard.value = await client.getDashboard(controller.signal);
  } catch (error) {
    if (!isAbortError(error)) {
      throw error;
    }
  } finally {
    finishRequest(key, controller);
  }
}

async function loadProjects(): Promise<void> {
  const key = "projects";
  const controller = beginRequest(key);
  try {
    projects.value = await client.listProjects(controller.signal);
  } catch (error) {
    if (!isAbortError(error)) {
      throw error;
    }
  } finally {
    finishRequest(key, controller);
  }
}

function pageSizeToQuery(value: ListPageSize): number {
  return value === "all" ? 0 : value;
}

function normalizePageSize(value: string): ListPageSize {
  const option = listPageSizeOptions.find((candidate) => String(candidate.value) === value);
  return option?.value ?? 10;
}

async function loadKnowledge(resetPage = false): Promise<void> {
  const requestKey = "knowledge";
  const controller = beginRequest(requestKey);
  if (resetPage) {
    knowledgePage.value = 1;
  }
  knowledgeLoading.value = true;
  knowledgeError.value = "";
  try {
    const result = await client.searchKnowledge({
      q: knowledgeQuery.value.trim() || undefined,
      kind: knowledgeKind.value || undefined,
      projectId: knowledgeProjectId.value || undefined,
      status: knowledgeStatus.value,
      page: knowledgePage.value,
      pageSize: knowledgePageSize.value
    }, controller.signal);
    if (result.outcome === "knowledge") {
      knowledgeItems.value = result.items;
      knowledgeProjects.value = result.projects;
      knowledgePage.value = result.pageInfo.page;
      knowledgePageInfo.value = result.pageInfo;
    } else {
      knowledgeItems.value = [];
      knowledgeProjects.value = [];
      knowledgePageInfo.value = { ...emptyPageInfo, pageSize: pageSizeToQuery(knowledgePageSize.value) };
      knowledgeError.value = result.reason;
    }
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }
    knowledgeItems.value = [];
    knowledgeProjects.value = [];
    knowledgePageInfo.value = { ...emptyPageInfo, pageSize: pageSizeToQuery(knowledgePageSize.value) };
    knowledgeError.value = error instanceof Error ? error.message : "無法載入 Knowledge。";
  } finally {
    if (isCurrentRequest(requestKey, controller)) {
      knowledgeLoading.value = false;
    }
    finishRequest(requestKey, controller);
  }
}

async function changeKnowledgePage(page: number): Promise<void> {
  if (page < 1 || page > knowledgePageInfo.value.totalPages || page === knowledgePage.value) {
    return;
  }
  knowledgePage.value = page;
  await loadKnowledge();
}

async function changeKnowledgePageSize(event: Event): Promise<void> {
  knowledgePageSize.value = normalizePageSize((event.target as HTMLSelectElement).value);
  knowledgePage.value = 1;
  await loadKnowledge();
}

async function loadGraph(cursor?: string): Promise<void> {
  const requestKey = "graph";
  const controller = beginRequest(requestKey);
  graphLoading.value = true;
  graphError.value = "";
  const loadPreset = graphLoadPresetOptions.find((preset) => preset.value === graphLoadPreset.value) ?? graphLoadPresetOptions[0];
  try {
    const result = await client.getGraph({
      projectId: graphProjectId.value || undefined,
      limit: 200,
      maxNodes: loadPreset.maxNodes,
      maxEdges: loadPreset.maxEdges,
      pageSize: loadPreset.maxNodes,
      cursor
    }, controller.signal);
    if (result.outcome === "graph") {
      if (cursor && graph.value?.outcome === "graph") {
        const nodes = [...graph.value.nodes, ...result.nodes].filter((node, index, items) => items.findIndex((candidate) => candidate.id === node.id) === index);
        const edges = [...graph.value.edges, ...result.edges].filter((edge, index, items) => items.findIndex((candidate) => candidate.id === edge.id) === index);
        graph.value = {
          ...result,
          nodes,
          edges,
          projects: graph.value.projects,
          sourceProjectIds: [...new Set([...graph.value.sourceProjectIds, ...result.sourceProjectIds])],
          sourceSessionIds: [...new Set([...graph.value.sourceSessionIds, ...result.sourceSessionIds])]
        };
      } else {
        graph.value = result;
      }
    } else {
      graph.value = null;
      graphError.value = result.reason;
    }
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }
    graph.value = null;
    graphError.value = error instanceof Error ? error.message : "無法載入工作圖譜。";
  } finally {
    if (isCurrentRequest(requestKey, controller)) {
      graphLoading.value = false;
    }
    finishRequest(requestKey, controller);
  }
}

async function loadMoreGraph(): Promise<void> {
  const cursor = graph.value?.nextCursor;
  if (!cursor) {
    toastMessage.value = "圖譜已載入完成。";
    return;
  }
  await loadGraph(cursor);
}

async function loadSessions(resetPage = false): Promise<void> {
  if (resetPage) {
    sessionPage.value = 1;
  }
  activeDatePicker.value = null;
  if (dateFrom.value && dateTo.value && dateFrom.value > dateTo.value) {
    sessionFilterError.value = "起始日期必須早於或等於結束日期。";
    return;
  }

  const requestKey = "worklog-sessions";
  const controller = beginRequest(requestKey);
  sessionFilterError.value = "";
  try {
    const result = await client.listSessions({
      q: searchTerm.value.trim() || undefined,
      projectId: selectedProjectId.value || undefined,
      from: dateFrom.value || undefined,
      to: dateTo.value || undefined,
      page: sessionPage.value,
      pageSize: sessionPageSize.value
    }, controller.signal);
    sessions.value = result.items;
    sessionPage.value = result.pageInfo.page;
    sessionPageInfo.value = result.pageInfo;
  } catch (error) {
    if (!isAbortError(error)) {
      throw error;
    }
  } finally {
    finishRequest(requestKey, controller);
  }
}

async function clearSessionFilters(): Promise<void> {
  activeDatePicker.value = null;
  searchTerm.value = "";
  selectedProjectId.value = "";
  dateFrom.value = "";
  dateTo.value = "";
  await loadSessions(true);
}

async function changeSessionPage(page: number): Promise<void> {
  if (page < 1 || page > sessionPageInfo.value.totalPages || page === sessionPage.value) {
    return;
  }
  sessionPage.value = page;
  await loadSessions();
}

async function changeSessionPageSize(event: Event): Promise<void> {
  sessionPageSize.value = normalizePageSize((event.target as HTMLSelectElement).value);
  sessionPage.value = 1;
  await loadSessions();
}

async function loadReportSynthesis(): Promise<void> {
  const requestKey = "report-synthesis";
  const controller = beginRequest(requestKey);
  reportSynthesisLoading.value = true;
  reportSynthesisError.value = "";
  try {
    const [requests, summaries] = await Promise.all([
      client.listReportSynthesisRequests({
        period: reportPeriod.value,
        date: reportDate.value || undefined,
        projectId: reportProjectId.value || undefined,
        limit: 10
      }, controller.signal),
      client.listReportSummaries({
        period: reportPeriod.value,
        date: reportDate.value || undefined,
        projectId: reportProjectId.value || undefined,
        currentOnly: false
      }, controller.signal)
    ]);
    if (requests.outcome === "report_synthesis_requests") {
      reportSynthesisRequest.value = requests.requests[0] ?? null;
    } else {
      reportSynthesisRequest.value = null;
      reportSynthesisError.value = requests.reason;
    }
    if (summaries.outcome === "report_summaries") {
      reportSynthesisHistory.value = summaries.summaries;
      reportSynthesisSummary.value = summaries.summaries.find((summary) => summary.isCurrent) ?? summaries.summaries[0] ?? null;
    } else {
      reportSynthesisHistory.value = [];
      reportSynthesisSummary.value = null;
      reportSynthesisError.value ||= summaries.reason;
    }
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }
    reportSynthesisRequest.value = null;
    reportSynthesisHistory.value = [];
    reportSynthesisSummary.value = null;
    reportSynthesisError.value = error instanceof Error ? error.message : "無法載入報告提煉狀態。";
  } finally {
    if (isCurrentRequest(requestKey, controller)) {
      reportSynthesisLoading.value = false;
    }
    finishRequest(requestKey, controller);
  }
}

function selectReportSynthesisVersion(summary: ReportSummary): void {
  reportSynthesisSummary.value = summary;
}

async function createReportSynthesisRequest(): Promise<void> {
  if (!report.value || reportSynthesisCreating.value) {
    return;
  }

  reportSynthesisCreating.value = true;
  reportSynthesisError.value = "";
  try {
    const result = await client.createReportSynthesisRequest({
      period: reportPeriod.value,
      date: reportDate.value || undefined,
      projectId: reportProjectId.value || undefined,
      idempotencyKey: crypto.randomUUID()
    });
    if (result.outcome !== "report_synthesis_request") {
      reportSynthesisError.value = result.reason;
      return;
    }
    reportSynthesisRequest.value = result.request;
    toastMessage.value = reportSynthesisSummary.value
      ? "已建立重新提煉請求。上一版摘要會先保留，新的 Agent 摘要完成後才會替換。"
      : "報告請求已建立。請在目前的 Agent 對話中說：「請處理我剛在 Work Intelligence 建立的報告提煉請求。」";
  } catch (error) {
    reportSynthesisError.value = error instanceof Error ? error.message : "建立報告提煉請求失敗。";
  } finally {
    reportSynthesisCreating.value = false;
  }
}

async function retryReportSynthesisRequest(): Promise<void> {
  const requestToRetry = reportSynthesisRequest.value;
  if (!requestToRetry || !reportSynthesisCanRetry.value || reportSynthesisRetrying.value) {
    return;
  }

  reportSynthesisRetrying.value = true;
  reportSynthesisError.value = "";
  try {
    const result = await client.retryReportSynthesisRequest(requestToRetry.id);
    if (result.outcome !== "report_synthesis_request_retried") {
      reportSynthesisError.value = "reason" in result ? result.reason : "這份報告目前無法重試。";
      return;
    }
    reportSynthesisRequest.value = result.request;
    toastMessage.value = "已重新建立提煉請求。請在目前的 Agent 對話中處理它。";
  } catch (error) {
    reportSynthesisError.value = error instanceof Error ? error.message : "重新建立報告提煉請求失敗。";
  } finally {
    reportSynthesisRetrying.value = false;
  }
}

async function cancelReportSynthesisRequest(): Promise<void> {
  const requestToCancel = reportSynthesisRequest.value;
  if (!requestToCancel || !reportSynthesisIsActive.value || reportSynthesisCancelling.value) {
    return;
  }
  if (!window.confirm("確定取消這次報告提煉嗎？既有報告與歷史版本會保留。")) {
    return;
  }

  reportSynthesisCancelling.value = true;
  reportSynthesisError.value = "";
  try {
    const result = await client.cancelReportSynthesisRequest(requestToCancel.id);
    if (result.outcome !== "report_synthesis_request_cancelled") {
      reportSynthesisError.value = "reason" in result ? result.reason : "這份報告目前無法取消。";
      return;
    }
    reportSynthesisRequest.value = result.request;
    toastMessage.value = "已取消這次報告提煉；既有報告與歷史版本仍然保留。";
  } catch (error) {
    reportSynthesisError.value = error instanceof Error ? error.message : "取消報告提煉失敗。";
  } finally {
    reportSynthesisCancelling.value = false;
  }
}

async function copyInstruction(instruction: string, successMessage: string): Promise<void> {
  try {
    await copyText(instruction);
    toastMessage.value = successMessage;
  } catch (error) {
    toastMessage.value = error instanceof Error ? error.message : "無法使用剪貼簿，請手動複製文字。";
  }
}

function copyReportSynthesisInstruction(): Promise<void> {
  return copyInstruction(reportSynthesisInstruction, "已複製自然語言提煉指令。");
}

async function deleteReportSynthesisVersion(summary: ReportSummary): Promise<void> {
  if (summary.isCurrent) {
    return;
  }
  if (!window.confirm(`確定移除「${summary.title}」這個歷史版本嗎？此操作無法復原。`)) {
    return;
  }

  reportSynthesisError.value = "";
  try {
    const result = await client.deleteReportSummary(summary.id);
    if (result.outcome !== "report_summary_deleted") {
      reportSynthesisError.value = "reason" in result ? result.reason : "這個報告版本目前無法移除。";
      return;
    }
    toastMessage.value = "已移除報告歷史版本。";
    await loadReportSynthesis();
  } catch (error) {
    reportSynthesisError.value = error instanceof Error ? error.message : "移除報告歷史版本失敗。";
  }
}

async function loadReportSessions(resetPage = false): Promise<void> {
  if (!report.value) {
    reportSessionItems.value = [];
    reportSessionPageInfo.value = { ...emptyPageInfo, pageSize: pageSizeToQuery(reportSessionPageSize.value) };
    return;
  }
  if (resetPage) {
    reportSessionPage.value = 1;
  }
  const requestKey = "report-sessions";
  const controller = beginRequest(requestKey);
  reportSessionLoading.value = true;
  try {
    const result = await client.listSessions({
      from: report.value.range.from,
      to: report.value.range.to,
      projectId: reportProjectId.value || undefined,
      page: reportSessionPage.value,
      pageSize: reportSessionPageSize.value
    }, controller.signal);
    reportSessionItems.value = result.items;
    reportSessionPage.value = result.pageInfo.page;
    reportSessionPageInfo.value = result.pageInfo;
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }
    reportSessionItems.value = [];
    reportSessionPageInfo.value = { ...emptyPageInfo, pageSize: pageSizeToQuery(reportSessionPageSize.value) };
    reportSynthesisError.value ||= error instanceof Error ? error.message : "無法載入報告原始 Session。";
  } finally {
    if (isCurrentRequest(requestKey, controller)) {
      reportSessionLoading.value = false;
    }
    finishRequest(requestKey, controller);
  }
}

async function changeReportSessionPageSize(): Promise<void> {
  reportSessionPage.value = 1;
  await loadReportSessions();
}

async function changeReportSessionPage(page: number): Promise<void> {
  if (page < 1 || page > reportSessionPageInfo.value.totalPages || page === reportSessionPage.value) {
    return;
  }
  reportSessionPage.value = page;
  await loadReportSessions();
}

async function loadReportEvidence(resetPage = false): Promise<void> {
  if (!report.value || reportEvidenceLoading.value) {
    return;
  }
  if (resetPage) {
    reportEvidencePage.value = 1;
  }

  const requestKey = "report-evidence";
  const controller = beginRequest(requestKey);
  reportEvidenceLoading.value = true;
  reportError.value = "";
  try {
    const result = await client.getReport({
      period: reportPeriod.value,
      date: reportDate.value || undefined,
      projectId: reportProjectId.value || undefined,
      evidencePage: reportEvidencePage.value,
      evidencePageSize: reportEvidencePageSize.value,
      evidenceKind: reportEvidenceKind.value || undefined,
      evidenceQuery: reportEvidenceQuery.value.trim() || undefined
    }, controller.signal);
    if (result.outcome !== "report") {
      reportError.value = result.reason;
      return;
    }
    report.value = {
      ...report.value,
      evidence: result.evidence,
      evidencePageInfo: result.evidencePageInfo
    };
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }
    reportError.value = error instanceof Error ? error.message : "無法更新來源證據。";
  } finally {
    if (isCurrentRequest(requestKey, controller)) {
      reportEvidenceLoading.value = false;
    }
    finishRequest(requestKey, controller);
  }
}

async function loadReport(resetEvidencePage = false): Promise<void> {
  if (resetEvidencePage) {
    reportEvidencePage.value = 1;
    reportTab.value = "overview";
  }
  const requestKey = "report";
  const controller = beginRequest(requestKey);
  reportLoading.value = true;
  reportError.value = "";
  try {
    const result = await client.getReport({
      period: reportPeriod.value,
      date: reportDate.value || undefined,
      projectId: reportProjectId.value || undefined,
      evidencePage: reportEvidencePage.value,
      evidencePageSize: reportEvidencePageSize.value,
      evidenceKind: reportEvidenceKind.value || undefined,
      evidenceQuery: reportEvidenceQuery.value.trim() || undefined
    }, controller.signal);
    if (result.outcome === "report") {
      report.value = result;
      await Promise.all([loadReportSynthesis(), loadReportSessions(resetEvidencePage)]);
    } else {
      report.value = null;
      reportSynthesisRequest.value = null;
      reportSynthesisSummary.value = null;
      reportError.value = result.reason;
    }
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }
    report.value = null;
    reportError.value = error instanceof Error ? error.message : "無法載入工作報告。";
  } finally {
    if (isCurrentRequest(requestKey, controller)) {
      reportLoading.value = false;
    }
    finishRequest(requestKey, controller);
  }
}

async function changeReportEvidencePage(page: number): Promise<void> {
  if (!report.value || page < 1 || page > report.value.evidencePageInfo.totalPages || page === reportEvidencePage.value) {
    return;
  }
  reportEvidencePage.value = page;
  await loadReportEvidence();
}

async function changeReportEvidencePageSize(): Promise<void> {
  reportEvidencePage.value = 1;
  await loadReportEvidence();
}

async function exportReport(format: ReportExportFormat): Promise<void> {
  if (!report.value) {
    toastMessage.value = "請先載入一份報告，再進行匯出。";
    return;
  }

  reportExportLoading.value = format;
  try {
    const result = await client.exportReport({
      period: reportPeriod.value,
      format,
      date: reportDate.value || undefined,
      projectId: reportProjectId.value || undefined,
      evidenceKind: reportEvidenceKind.value || undefined,
      evidenceQuery: reportEvidenceQuery.value.trim() || undefined
    });
    if (result.outcome !== "report_export") {
      toastMessage.value = result.reason;
      return;
    }

    const blob = new Blob([result.content], { type: result.contentType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = result.filename;
    anchor.style.display = "none";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    toastMessage.value = "已下載 " + (format === "markdown" ? "Markdown" : "JSON") + " 報告。";
  } catch (error) {
    toastMessage.value = error instanceof Error ? error.message : "報告匯出失敗。";
  } finally {
    reportExportLoading.value = null;
  }
}

function toDateInputValue(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateInputValue(value: string): Date {
  const [year = "1970", month = "1", day = "1"] = value.split("-");
  return new Date(Number(year), Number(month) - 1, Number(day));
}

function startOfMonth(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), 1);
}

function displayDate(value: string): string {
  if (!value) {
    return "選擇日期";
  }

  const [year, month, day] = value.split("-");
  return `${year}/${month}/${day}`;
}

function toggleDatePicker(target: DatePickerTarget, trigger?: HTMLButtonElement | null): void {
  if (trigger) {
    if (target === "from") {
      dateFromTrigger.value = trigger;
    } else {
      dateToTrigger.value = trigger;
    }
  }

  if (activeDatePicker.value === target) {
    activeDatePicker.value = null;
    return;
  }

  activeDatePicker.value = target;
  const selectedValue = target === "from" ? dateFrom.value : dateTo.value;
  pickerMonth.value = startOfMonth(selectedValue ? parseDateInputValue(selectedValue) : new Date());
  void nextTick(updateDatePickerPosition);
}

function updateDatePickerPosition(): void {
  if (!activeDatePicker.value || typeof window === "undefined") {
    return;
  }

  const trigger = activeDatePicker.value === "from" ? dateFromTrigger.value : dateToTrigger.value;
  if (!trigger) {
    return;
  }

  const rect = trigger.getBoundingClientRect();
  const gutter = 12;
  const menuWidth = Math.min(286, window.innerWidth - gutter * 2);
  const menuHeight = 340;
  const left = Math.min(Math.max(gutter, rect.left), window.innerWidth - menuWidth - gutter);
  const top = rect.bottom + 8 + menuHeight <= window.innerHeight - gutter ? rect.bottom + 8 : Math.max(gutter, rect.top - menuHeight - 8);
  datePickerStyle.value = { left: `${left}px`, top: `${top}px` };
}

function shiftPickerMonth(offset: number): void {
  pickerMonth.value = new Date(pickerMonth.value.getFullYear(), pickerMonth.value.getMonth() + offset, 1);
}

function selectCalendarDate(value: string): void {
  if (activeDatePicker.value === "from") {
    dateFrom.value = value;
  } else if (activeDatePicker.value === "to") {
    dateTo.value = value;
  }

  sessionFilterError.value = "";
  activeDatePicker.value = null;
}

function clearCalendarDate(): void {
  if (activeDatePicker.value === "from") {
    dateFrom.value = "";
  } else if (activeDatePicker.value === "to") {
    dateTo.value = "";
  }

  sessionFilterError.value = "";
  activeDatePicker.value = null;
}

const pickerMonthLabel = computed(() =>
  new Intl.DateTimeFormat("zh-TW", { year: "numeric", month: "long" }).format(pickerMonth.value)
);
const pickerSelectedValue = computed(() => {
  if (activeDatePicker.value === "from") {
    return dateFrom.value;
  }
  if (activeDatePicker.value === "to") {
    return dateTo.value;
  }
  return "";
});
const calendarDays = computed(() => {
  const monthStart = startOfMonth(pickerMonth.value);
  const calendarStart = new Date(monthStart);
  calendarStart.setDate(monthStart.getDate() - monthStart.getDay());
  const today = toDateInputValue(new Date());

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(calendarStart);
    date.setDate(calendarStart.getDate() + index);
    const value = toDateInputValue(date);
    return {
      value,
      label: date.getDate(),
      inCurrentMonth: date.getMonth() === monthStart.getMonth(),
      isToday: value === today,
      isSelected: value === pickerSelectedValue.value
    };
  });
});

watch([selectedDetail, handoffImportPreview, knowledgeEditor, knowledgeHistoryItem, selectedGraphNode], async ([detail, importPreview, editor, historyItem, graphNode]) => {
  document.body.classList.toggle("modal-open", Boolean(detail || importPreview || editor || historyItem || graphNode));
  if (detail) {
    await nextTick();
    detailModalContent.value?.scrollTo({ top: 0, behavior: "auto" });
  }
});

onBeforeUnmount(() => {
  apiRequest.abortAll();
  window.removeEventListener("resize", updateDatePickerPosition);
  window.removeEventListener("scroll", updateDatePickerPosition, true);
  document.body.classList.remove("modal-open");
});

async function refresh(): Promise<void> {
  loading.value = true;
  errorMessage.value = "";
  try {
    await Promise.all([loadDashboard(), loadProjects(), loadSessions(), loadKnowledge()]);
    if (activeView.value === "reports") {
      await loadReport();
    }
    if (activeView.value === "projects") {
      await loadMetadataBackfillRequest();
    }
    if (activeView.value === "graph") {
      await loadGraph();
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "無法載入 Work Intelligence。";
  } finally {
    loading.value = false;
  }
}

async function changeView(view: ViewName): Promise<void> {
  activeView.value = view;
  if (route.name !== view) {
    await router.push({ name: view });
  }
  if (view === "worklog") {
    await loadSessions();
  }
  if (view === "reports") {
    await loadReport();
  }
  if (view === "projects") {
    await Promise.all([loadProjects(), loadMetadataBackfillRequest()]);
  }
  if (view === "knowledge") {
    await loadKnowledge();
  }
  if (view === "graph") {
    await loadGraph();
  }
}

async function addProject(): Promise<void> {
  if (!projectName.value.trim() || !projectRoot.value.trim()) {
    toastMessage.value = "請填寫專案名稱與根目錄。";
    return;
  }

  addingProject.value = true;
  try {
    await client.createProject({ name: projectName.value, rootPath: projectRoot.value });
    projectName.value = "";
    projectRoot.value = "";
    toastMessage.value = "專案已加入 registry；目前仍是未註冊狀態。請明確切換為記錄中。";
    await Promise.all([loadProjects(), loadDashboard()]);
  } catch (error) {
    toastMessage.value = error instanceof Error ? error.message : "加入專案失敗。";
  } finally {
    addingProject.value = false;
  }
}

async function updateProjectStatus(project: ProjectRecord, status: ProjectStatus): Promise<void> {
  try {
    const updated = await client.updateProject(project.id, { status });
    const index = projects.value.findIndex((item) => item.id === updated.id);
    if (index >= 0) {
      projects.value[index] = updated;
    }
    toastMessage.value = `${updated.name}：${statusLabels[updated.status]}`;
    await loadDashboard();
  } catch (error) {
    toastMessage.value = error instanceof Error ? error.message : "更新專案狀態失敗。";
  }
}

async function loadMetadataBackfillRequest(): Promise<void> {
  const requestKey = "metadata-backfill-request";
  const controller = beginRequest(requestKey);
  metadataBackfillRequestLoading.value = true;
  metadataBackfillRequestError.value = "";
  try {
    const result = await client.listMetadataBackfillRequests(controller.signal);
    if (result.outcome === "metadata_backfill_requests") {
      metadataBackfillRequest.value = result.requests[0] ?? null;
    } else {
      metadataBackfillRequest.value = null;
      metadataBackfillRequestError.value = result.reason;
    }
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }
    metadataBackfillRequest.value = null;
    metadataBackfillRequestError.value = error instanceof Error ? error.message : "無法載入 metadata 回補請求狀態。";
  } finally {
    if (isCurrentRequest(requestKey, controller)) {
      metadataBackfillRequestLoading.value = false;
    }
    finishRequest(requestKey, controller);
  }
}

async function createMetadataBackfillRequest(): Promise<void> {
  const preview = metadataBackfillPreview.value;
  if (!preview?.items.length || metadataBackfillRequestCreating.value) {
    return;
  }

  metadataBackfillRequestCreating.value = true;
  metadataBackfillRequestError.value = "";
  try {
    const result = await client.createMetadataBackfillRequest(preview.project?.id);
    if (result.outcome === "metadata_backfill_request") {
      metadataBackfillRequest.value = result.request;
      toastMessage.value = result.duplicate
        ? "已有待處理的 metadata 回補請求；請在目前的 Agent 對話中處理。"
        : "已建立 metadata 回補請求；請在目前的 Agent 對話中說：「請處理我剛在 Work Intelligence 掃描出的 metadata 缺口。」";
    } else if (result.outcome === "metadata_backfill_not_needed") {
      metadataBackfillRequest.value = null;
      toastMessage.value = result.reason;
    } else {
      metadataBackfillRequestError.value = result.reason;
    }
  } catch (error) {
    metadataBackfillRequestError.value = error instanceof Error ? error.message : "建立 metadata 回補請求失敗。";
  } finally {
    metadataBackfillRequestCreating.value = false;
  }
}

async function cancelMetadataBackfillRequest(): Promise<void> {
  const requestToCancel = metadataBackfillRequest.value;
  if (!requestToCancel || !metadataBackfillRequestIsActive.value || metadataBackfillRequestLoading.value) {
    return;
  }
  if (!window.confirm("確定取消這批 metadata 回補嗎？既有 Session 資料不會被刪除。")) {
    return;
  }

  metadataBackfillRequestLoading.value = true;
  metadataBackfillRequestError.value = "";
  try {
    const result = await client.cancelMetadataBackfillRequest(requestToCancel.id);
    if (result.outcome !== "metadata_backfill_request_cancelled") {
      metadataBackfillRequestError.value = "reason" in result ? result.reason : "這批 metadata 回補目前無法取消。";
      return;
    }
    metadataBackfillRequest.value = result.request;
    toastMessage.value = "已取消這批 metadata 回補；既有 Session 資料仍然保留。";
  } catch (error) {
    metadataBackfillRequestError.value = error instanceof Error ? error.message : "取消 metadata 回補失敗。";
  } finally {
    metadataBackfillRequestLoading.value = false;
  }
}

function copyMetadataBackfillInstruction(): Promise<void> {
  return copyInstruction(metadataBackfillInstruction, "已複製自然語言 metadata 回補指令。");
}

async function previewMetadataBackfill(): Promise<void> {
  const requestKey = "metadata-backfill-preview";
  const controller = beginRequest(requestKey);
  metadataBackfillLoading.value = true;
  metadataBackfillError.value = "";
  metadataBackfillRequestError.value = "";
  try {
    const result = await client.previewMetadataBackfill(50, controller.signal);
    if (result.outcome !== "backfill_preview") {
      metadataBackfillPreview.value = null;
      metadataBackfillError.value = result.reason;
      return;
    }
    metadataBackfillPreview.value = result;
    if (result.items.length > 0) {
      await createMetadataBackfillRequest();
    } else {
      await loadMetadataBackfillRequest();
    }
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }
    metadataBackfillError.value = error instanceof Error ? error.message : "無法掃描 metadata 缺口。";
  } finally {
    if (isCurrentRequest(requestKey, controller)) {
      metadataBackfillLoading.value = false;
    }
    finishRequest(requestKey, controller);
  }
}

function metadataGapLabel(gap: MetadataBackfillItem["gaps"][number]): string {
  return gap === "changed_files" ? "Changed files 待確認" : "Verification 待確認";
}

async function openMetadataBackfillSession(item: MetadataBackfillItem): Promise<void> {
  const session = sessions.value.find((candidate) => candidate.id === item.sessionId);
  if (session) {
    await openSession(session);
    return;
  }

  await openSessionDetail(item.sessionId, "無法載入待回補的 Session。");
}

const importableHandoffs = computed(() =>
  handoffImportPreview.value?.items.filter((item) => item.decision === "eligible") ?? []
);

const selectedHandoffCount = computed(() => handoffImportSelection.value.length);

function isHandoffSelected(sourcePath: string): boolean {
  return handoffImportSelection.value.includes(sourcePath);
}

function toggleHandoffSelection(item: HandoffImportPreviewItem): void {
  if (item.decision !== "eligible") {
    return;
  }
  if (isHandoffSelected(item.sourcePath)) {
    handoffImportSelection.value = handoffImportSelection.value.filter((path) => path !== item.sourcePath);
  } else {
    handoffImportSelection.value = [...handoffImportSelection.value, item.sourcePath];
  }
}

function selectAllHandoffs(): void {
  handoffImportSelection.value = importableHandoffs.value.map((item) => item.sourcePath);
}

function clearHandoffSelection(): void {
  handoffImportSelection.value = [];
}

function handoffDecisionLabel(item: HandoffImportPreviewItem): string {
  if (item.decision === "eligible") {
    return "可匯入";
  }
  if (item.decision === "already_imported") {
    return "已匯入";
  }
  if (item.reason === "excluded_by_user") {
    return "使用者排除";
  }
  if (item.reason === "blocked") {
    return "Blocked，略過";
  }
  if (item.reason === "pending") {
    return "Pending，略過";
  }
  if (item.reason === "planning_only") {
    return "僅規劃，略過";
  }
  if (item.decision === "error") {
    return "讀取失敗";
  }
  return "缺少完成狀態";
}

async function previewHandoffs(project: ProjectRecord): Promise<void> {
  const requestKey = "handoff-preview";
  const controller = beginRequest(requestKey);
  handoffImportLoading.value = true;
  handoffImportError.value = "";
  handoffImportProjectId.value = project.id;
  try {
    const result = await client.previewHandoffs(project.rootPath, undefined, controller.signal);
    if (result.outcome !== "preview") {
      toastMessage.value = result.reason;
      return;
    }
    handoffImportPreview.value = result;
    handoffImportSelection.value = [];
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }
    handoffImportError.value = error instanceof Error ? error.message : "無法建立 handoff 匯入預覽。";
    toastMessage.value = handoffImportError.value;
  } finally {
    if (isCurrentRequest(requestKey, controller)) {
      handoffImportLoading.value = false;
    }
    finishRequest(requestKey, controller);
  }
}

function closeHandoffImport(): void {
  handoffImportPreview.value = null;
  handoffImportProjectId.value = "";
  handoffImportSelection.value = [];
  handoffImportError.value = "";
}

async function applyHandoffImport(): Promise<void> {
  const preview = handoffImportPreview.value;
  if (!preview || handoffImportSelection.value.length === 0) {
    return;
  }

  handoffImportApplying.value = true;
  handoffImportError.value = "";
  try {
    const result = await client.importHandoffs({
      projectRoot: preview.project.rootPath,
      handoffDirectory: preview.handoffDirectory,
      sourcePaths: handoffImportSelection.value
    });
    if (result.outcome !== "imported") {
      handoffImportError.value = result.reason;
      return;
    }
    toastMessage.value = `已匯入 ${result.imported.length} 個 handoff；略過 ${result.skipped.length} 個，失敗 ${result.failures.length} 個。`;
    closeHandoffImport();
    await Promise.all([loadDashboard(), loadProjects(), loadSessions()]);
    if (activeView.value === "reports") {
      await loadReport();
    }
  } catch (error) {
    handoffImportError.value = error instanceof Error ? error.message : "套用 handoff 匯入失敗。";
  } finally {
    handoffImportApplying.value = false;
  }
}

async function openSessionDetail(sessionId: string, errorMessage: string): Promise<void> {
  const requestKey = "session-detail";
  const controller = beginRequest(requestKey);
  try {
    selectedDetail.value = await client.getSessionDetail(sessionId, controller.signal);
  } catch (error) {
    if (!isAbortError(error)) {
      toastMessage.value = error instanceof Error ? error.message : errorMessage;
    }
  } finally {
    finishRequest(requestKey, controller);
  }
}

async function openSession(session: WorkSessionRecord): Promise<void> {
  await openSessionDetail(session.id, "無法載入 Session detail。");
}

async function openKnowledgeSession(item: KnowledgeRecord): Promise<void> {
  if (!item.sessionId) {
    return;
  }

  const session = sessions.value.find((candidate) => candidate.id === item.sessionId);
  if (session) {
    await openSession(session);
    return;
  }

  await openSessionDetail(item.sessionId, "無法載入 Knowledge 的來源 Session。");
}

function splitKnowledgeValues(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}

function openKnowledgeEditor(item: KnowledgeRecord): void {
  knowledgeEditor.value = item;
  knowledgeEditorForm.value = {
    kind: item.kind,
    title: item.title,
    body: item.body,
    tags: item.tags.join(", "),
    references: item.references.join("\n"),
    status: item.status
  };
  knowledgeEditorError.value = "";
}

function closeKnowledgeEditor(): void {
  if (knowledgeEditorSaving.value) {
    return;
  }
  knowledgeEditor.value = null;
  knowledgeEditorError.value = "";
}

async function openKnowledgeHistory(item: KnowledgeRecord): Promise<void> {
  const project = knowledgeProject(item);
  if (!project) {
    toastMessage.value = "找不到這筆 Knowledge 所屬的 tracked project。";
    return;
  }

  knowledgeHistoryItem.value = item;
  knowledgeHistory.value = [];
  knowledgeHistoryError.value = "";
  const requestKey = "knowledge-history";
  const controller = beginRequest(requestKey);
  knowledgeHistoryLoading.value = true;
  try {
    const result = await client.getKnowledgeHistory(item.id, { projectRoot: project.rootPath, limit: 100 }, controller.signal);
    if (result.outcome === "knowledge_history") {
      knowledgeHistory.value = result.history;
    } else if (result.outcome === "skipped") {
      knowledgeHistoryError.value = result.reason;
    } else {
      knowledgeHistoryError.value = "這筆 Knowledge 已不存在。";
    }
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }
    knowledgeHistoryError.value = error instanceof Error ? error.message : "無法載入 Knowledge 變更紀錄。";
  } finally {
    if (isCurrentRequest(requestKey, controller)) {
      knowledgeHistoryLoading.value = false;
    }
    finishRequest(requestKey, controller);
  }
}

function closeKnowledgeHistory(): void {
  knowledgeHistoryItem.value = null;
  knowledgeHistory.value = [];
  knowledgeHistoryError.value = "";
}

function knowledgeAuditFields(entry: KnowledgeAuditRecord): string {
  const labels: Record<string, string> = {
    kind: "類型",
    title: "標題",
    body: "內容",
    tags: "標籤",
    references: "參考資料",
    status: "狀態"
  };
  const fields = entry.changedFields.map((field) => labels[field] ?? field);
  return fields.length ? fields.join("、") : "狀態快照";
}

function knowledgeProject(item: KnowledgeRecord): ProjectRecord | undefined {
  return projects.value.find((project) => project.id === item.projectId) ??
    knowledgeProjects.value.find((project) => project.id === item.projectId);
}

async function patchKnowledge(
  item: KnowledgeRecord,
  changes: Partial<Pick<KnowledgeRecord, "kind" | "title" | "body" | "tags" | "references" | "status">>
): Promise<boolean> {
  const project = knowledgeProject(item);
  if (!project) {
    toastMessage.value = "找不到這筆 Knowledge 所屬的 tracked project。";
    return false;
  }

  try {
    const result = await client.updateKnowledge(item.id, { projectRoot: project.rootPath, ...changes });
    if (result.outcome !== "knowledge_updated") {
      toastMessage.value = result.outcome === "skipped" ? result.reason : "Knowledge 已不存在。";
      return false;
    }
    return true;
  } catch (error) {
    toastMessage.value = error instanceof Error ? error.message : "更新 Knowledge 失敗。";
    return false;
  }
}

async function saveKnowledge(): Promise<void> {
  const item = knowledgeEditor.value;
  if (!item) {
    return;
  }

  const form = knowledgeEditorForm.value;
  if (!form.title.trim() || !form.body.trim()) {
    knowledgeEditorError.value = "標題與內容不能留白。";
    return;
  }

  knowledgeEditorSaving.value = true;
  knowledgeEditorError.value = "";
  const saved = await patchKnowledge(item, {
    kind: form.kind,
    title: form.title.trim(),
    body: form.body.trim(),
    tags: splitKnowledgeValues(form.tags),
    references: splitKnowledgeValues(form.references),
    status: form.status
  });
  if (saved) {
    toastMessage.value = form.status === "archived" ? "Knowledge 已更新並封存。" : "Knowledge 已更新。";
    knowledgeEditorSaving.value = false;
    closeKnowledgeEditor();
    await loadKnowledge();
    return;
  }
  knowledgeEditorSaving.value = false;
}

async function setKnowledgeStatus(item: KnowledgeRecord, status: KnowledgeStatus): Promise<void> {
  const updated = await patchKnowledge(item, { status });
  if (!updated) {
    return;
  }
  toastMessage.value = status === "archived" ? "Knowledge 已封存。" : "Knowledge 已恢復使用。";
  await loadKnowledge();
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-TW", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function verificationLabel(value: unknown): string {
  const status = typeof value === "string" && value in verificationLabels ? (value as ReportVerificationStatus) : "not_supplied";
  return verificationLabels[status];
}

function evidenceKindLabel(value: unknown): string {
  return typeof value === "string" && value in evidenceKindLabels ? evidenceKindLabels[value as ReportEvidence["kind"]] : "Evidence";
}

function knowledgeKindLabel(value: unknown): string {
  return typeof value === "string" && value in knowledgeKindLabels ? knowledgeKindLabels[value as KnowledgeKind] : "Knowledge";
}

function knowledgeStatusLabel(value: unknown): string {
  return typeof value === "string" && value in knowledgeStatusLabels ? knowledgeStatusLabels[value as KnowledgeStatus] : "未知狀態";
}

function eventDetails(value: Record<string, unknown> | undefined): string {
  return value ? JSON.stringify(value) : "";
}

function formatKnowledgeTags(tags: string[]): string {
  return tags.map((tag) => `#${tag}`).join(" · ");
}

function changedFileSourceLabel(session: WorkSessionRecord, file: string): string {
  const provenance = session.changedFilesProvenance?.find((item) => item.path === file);
  if (!provenance?.sources.length) {
    return "來源未提供";
  }
  return provenance.sources.map((source) => changedFileSourceLabels[source]).join(" · ");
}

function formatReadableSummary(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (!normalized) {
    return "";
  }

  return normalized
    .replace(/\s+Status signals\s*:/i, "\n\nStatus signals:\n")
    .replace(/\s*\|\s*/g, "\n")
    .replace(/(pending-backend-contract|pendingbackend|Reverted|blocked|completed|complete|pending)(?=[A-Za-z#])/gi, "$1\n")
    .replace(/(^|\n)\s*#{1,6}\s*/gm, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const trackedProjects = computed(() => projects.value.filter((project) => project.status === "tracked"));
const recentSessions = computed(() => dashboard.value.recentSessions);
const hasSessionFilters = computed(() => Boolean(searchTerm.value || selectedProjectId.value || dateFrom.value || dateTo.value));
const reportComparisons = computed(() => {
  if (!report.value) {
    return [];
  }

  return [
    { key: "sessions", label: "完成 Sessions", comparison: report.value.comparison.sessions, foot: "與上一期比較" },
    { key: "events", label: "Recorded Events", comparison: report.value.comparison.events, foot: "可追溯事件" },
    { key: "changedFiles", label: "Changed Files", comparison: report.value.comparison.changedFiles, foot: "不等同 Git commit" }
  ];
});
const reportVerification = computed(() => {
  if (!report.value) {
    return [];
  }

  const total = Math.max(report.value.totals.sessions, 1);
  return (["passed", "failed", "not_supplied", "not_run"] as const).map((status) => ({
    status,
    label: verificationLabels[status],
    count: report.value?.totals.verification[status] ?? 0,
    percent: Math.round(((report.value?.totals.verification[status] ?? 0) / total) * 100)
  }));
});

function formatReportDelta(comparison: ReportMetricComparison): string {
  if (comparison.direction === "flat") {
    return "與上一期相同";
  }
  return `${comparison.delta > 0 ? "+" : ""}${comparison.delta} · 上期 ${comparison.previous}`;
}

function formatReportDay(value: string): string {
  const [, month = "", day = ""] = value.split("-");
  return `${month}/${day}`;
}

function formatReportTrendLabel(value: string, granularity: WorkReport["trendGranularity"]): string {
  if (granularity === "month") {
    const [year = "", month = ""] = value.split("-");
    return `${year}/${month}`;
  }
  return formatReportDay(value);
}

function reportTrendHeight(value: number, reportValue: WorkReport): string {
  const max = Math.max(
    1,
    ...reportValue.trends.map((point) => Math.max(point.sessions, point.events))
  );
  return `${value ? Math.max(12, Math.round((value / max) * 100)) : 4}%`;
}

function shouldShowTrendLabel(index: number, total: number): boolean {
  return total <= 14 || index === 0 || index === total - 1 || index % Math.ceil(total / 7) === 0;
}

async function openReportSession(sessionId: string | undefined): Promise<void> {
  const session = report.value?.sessions.find((item) => item.id === sessionId);
  if (session) {
    await openSession(session);
    return;
  }
  if (!sessionId) {
    return;
  }
  await openSessionDetail(sessionId, "無法載入來源 Session。");
}

function openReportEvidence(evidence: ReportEvidence): void {
  openReportSession(evidence.sessionId);
}

type GraphVisualNode = {
  node: GraphNode;
  x: number;
  y: number;
};

type GraphVisualEdge = {
  edge: GraphEdge;
  from: GraphVisualNode;
  to: GraphVisualNode;
};

const graphNodeKindOrder = ["project", "session", "knowledge", "evidence", "file"] as const;
const graphVisualBaseQuotas: Record<GraphNode["kind"], number> = {
  project: 8,
  session: 24,
  knowledge: 18,
  evidence: 18,
  file: 48
};
const graphVisualQuotas = computed<Record<GraphNode["kind"], number>>(() => {
  const baseTotal = Object.values(graphVisualBaseQuotas).reduce((total, quota) => total + quota, 0);
  const quotas = {} as Record<GraphNode["kind"], number>;
  let allocated = 0;
  graphNodeKindOrder.forEach((kind, index) => {
    if (index === graphNodeKindOrder.length - 1) {
      quotas[kind] = Math.max(1, graphPreviewLimit.value - allocated);
      return;
    }
    const quota = Math.max(1, Math.floor((graphVisualBaseQuotas[kind] / baseTotal) * graphPreviewLimit.value));
    quotas[kind] = quota;
    allocated += quota;
  });
  return quotas;
});
const graphVisual = computed(() => {
  if (!graph.value) {
    return {
      width: 1_120,
      height: 560,
      nodes: [] as GraphVisualNode[],
      edges: [] as GraphVisualEdge[],
      hiddenNodes: 0,
      hiddenEdges: 0
    };
  }

  const filteredNodes = graphNodeFilter.value === "all"
    ? graph.value.nodes
    : graph.value.nodes.filter((node) => node.kind === graphNodeFilter.value);
  const visibleNodes = graphNodeFilter.value === "all"
    ? graphNodeKindOrder.flatMap((kind) => filteredNodes.filter((node) => node.kind === kind).slice(0, graphVisualQuotas.value[kind]))
    : filteredNodes.slice(0, graphPreviewLimit.value);
  const hiddenNodeIds = new Set(filteredNodes.map((node) => node.id));
  visibleNodes.forEach((node) => hiddenNodeIds.delete(node.id));
  const laneIndex = new Map<GraphNode["kind"], number>(graphNodeKindOrder.map((kind, index) => [kind, index]));
  const laneNodes = new Map<GraphNode["kind"], GraphNode[]>(
    graphNodeKindOrder.map((kind) => [kind, visibleNodes.filter((node) => node.kind === kind)])
  );
  const positions = new Map<string, GraphVisualNode>();
  const laneTop = 48;
  const rowHeight = 58;
  graphNodeKindOrder.forEach((kind) => {
    const nodes = laneNodes.get(kind) ?? [];
    nodes.forEach((node, index) => {
      positions.set(node.id, {
        node,
        x: 110 + (laneIndex.get(kind) ?? 0) * 220,
        y: laneTop + index * rowHeight
      });
    });
  });

  const graphEdges = graph.value.edges.reduce<GraphVisualEdge[]>((items, edge) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (from && to) {
      items.push({ edge, from, to });
    }
    return items;
  }, []);
  const rows = Math.max(...graphNodeKindOrder.map((kind) => laneNodes.get(kind)?.length ?? 0), 1);
  return {
    width: 1_120,
    height: Math.max(560, laneTop + rows * rowHeight + 55),
    nodes: visibleNodes.map((node) => positions.get(node.id)).filter((node): node is GraphVisualNode => Boolean(node)),
    edges: graphEdges,
    hiddenNodes: hiddenNodeIds.size,
    hiddenEdges: graph.value.edges.length - graphEdges.length
  };
});

const graphFilteredTotalNodes = computed(() => {
  if (!graph.value) {
    return 0;
  }
  return graphNodeFilter.value === "all" ? graph.value.totalNodes : graph.value.totalNodesByKind[graphNodeFilter.value];
});

const graphCanLoadMore = computed(() => {
  return Boolean(graph.value?.nextCursor);
});

const graphNodeCounts = computed(() => {
  const totals = graph.value?.totalNodesByKind ?? { project: 0, session: 0, knowledge: 0, evidence: 0, file: 0 };
  return graphNodeKindOrder.map((kind) => ({
    kind,
    label: graphNodeKindLabels[kind],
    count: totals[kind]
  }));
});

const graphEdgeCounts = computed(() => {
  const edges = graph.value?.edges ?? [];
  return Object.keys(graphEdgeKindLabels).map((kind) => ({
    kind: kind as keyof typeof graphEdgeKindLabels,
    label: graphEdgeKindLabels[kind as keyof typeof graphEdgeKindLabels],
    count: edges.filter((edge) => edge.kind === kind).length
  }));
});

function graphNodeLabel(value: string): string {
  const maxDisplayUnits = 25;
  let displayUnits = 0;
  let label = "";
  for (const character of value) {
    // The null-to-extended-ASCII range is intentional: it estimates display width for graph labels.
    // eslint-disable-next-line no-control-regex
    const characterUnits = /[^\u0000-\u00ff]/u.test(character) ? 2 : 1;
    if (displayUnits + characterUnits > maxDisplayUnits) {
      return `${label}…`;
    }
    label += character;
    displayUnits += characterUnits;
  }
  return label;
}

function graphNodeFilterLabel(): string {
  return graphNodeFilter.value === "all" ? "節點" : graphNodeKindLabels[graphNodeFilter.value];
}

function graphNodeClipId(value: string): string {
  return `graph-node-clip-${encodeURIComponent(value).replace(/%/g, "_")}`;
}

function graphNodeDescription(node: GraphNode): string {
  if (node.kind === "session") {
    return `${String(node.metadata.verification ?? "not_supplied")} · ${String(node.metadata.changedFilesCount ?? 0)} files`;
  }
  if (node.kind === "knowledge") {
    return String(node.metadata.kind ?? "knowledge");
  }
  if (node.kind === "evidence") {
    return String(node.metadata.kind ?? "evidence");
  }
  if (node.kind === "file") {
    return "changed file";
  }
  return String(node.metadata.status ?? "tracked");
}

const graphMetadataLabels: Record<string, string> = {
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

type GraphNodeRelation = {
  edge: GraphEdge;
  direction: "incoming" | "outgoing";
  relatedNode: GraphNode;
};

const selectedGraphNodeMetadata = computed(() => {
  if (!selectedGraphNode.value) {
    return [];
  }

  return Object.entries(selectedGraphNode.value.metadata).map(([key, value]) => ({
    key,
    label: graphMetadataLabels[key] ?? key,
    value: formatGraphMetadataValue(key, value)
  }));
});

const selectedGraphNodeRelations = computed<GraphNodeRelation[]>(() => {
  const node = selectedGraphNode.value;
  if (!node || !graph.value) {
    return [];
  }

  const nodesById = new Map(graph.value.nodes.map((candidate) => [candidate.id, candidate]));
  return graph.value.edges.flatMap((edge) => {
    const isOutgoing = edge.from === node.id;
    const relatedNode = nodesById.get(isOutgoing ? edge.to : edge.from);
    if (!isOutgoing && edge.to !== node.id) {
      return [];
    }
    if (!relatedNode) {
      return [];
    }
    return [{ edge, direction: isOutgoing ? "outgoing" : "incoming", relatedNode }];
  });
});

function formatGraphMetadataValue(key: string, value: string | number | boolean): string {
  if (key === "status" && typeof value === "string" && value in statusLabels) {
    return statusLabels[value as ProjectStatus];
  }
  if (key === "verification" && typeof value === "string" && value in verificationLabels) {
    return verificationLabels[value as ReportVerificationStatus];
  }
  if ((key === "completedAt" || key === "capturedAt") && typeof value === "string") {
    return formatDate(value);
  }
  if (key === "changedFilesCount") {
    return `${value} 個檔案`;
  }
  if (key === "tagsCount") {
    return `${value} 個標籤`;
  }
  if (typeof value === "boolean") {
    return value ? "是" : "否";
  }
  return String(value);
}

function graphNodeProjectName(node: GraphNode): string {
  if (!node.projectId) {
    return "—";
  }
  return graph.value?.projects.find((project) => project.id === node.projectId)?.name ?? "記錄中專案";
}

function selectGraphRelatedNode(node: GraphNode): void {
  selectedGraphNode.value = node;
}

function openGraphSession(node: GraphNode): void {
  if (!node.sessionId) {
    return;
  }

  selectedGraphNode.value = null;
  const session = sessions.value.find((item) => item.id === node.sessionId);
  if (session) {
    void openSession(session);
    return;
  }

  void openSessionDetail(node.sessionId, "無法載入 Graph 對應的 Session。");
}

function openGraphKnowledge(node: GraphNode): void {
  const knowledgeId = node.id.replace(/^knowledge:/, "");
  selectedGraphNode.value = null;
  const item = knowledgeItems.value.find((candidate) => candidate.id === knowledgeId);
  if (item) {
    openKnowledgeEditor(item);
    return;
  }
  void changeView("knowledge");
}

function openGraphProject(): void {
  selectedGraphNode.value = null;
  void changeView("projects");
}

function openGraphNode(node: GraphNode): void {
  selectedGraphNode.value = node;
}

onMounted(() => {
  window.addEventListener("resize", updateDatePickerPosition);
  window.addEventListener("scroll", updateDatePickerPosition, true);
  reportDate.value = toDateInputValue(new Date());
  refresh();
});
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">WI</div>
        <div>
          <div class="brand-name">Work Intelligence</div>
          <div class="brand-subtitle">Local-first work memory</div>
        </div>
      </div>

      <nav class="navigation" aria-label="主選單">
        <button :class="['nav-item', { active: activeView === 'dashboard' }]" type="button" :aria-current="activeView === 'dashboard' ? 'page' : undefined" @click="changeView('dashboard')">
          <span class="nav-icon">⌂</span>
          <span class="nav-copy"><strong>工作總覽</strong><small>Dashboard</small></span>
        </button>
        <button :class="['nav-item', { active: activeView === 'projects' }]" type="button" :aria-current="activeView === 'projects' ? 'page' : undefined" @click="changeView('projects')">
          <span class="nav-icon">◈</span>
          <span class="nav-copy"><strong>專案與記錄</strong><small>Projects / Tracking</small></span>
        </button>
        <button :class="['nav-item', { active: activeView === 'reports' }]" type="button" :aria-current="activeView === 'reports' ? 'page' : undefined" @click="changeView('reports')">
          <span class="nav-icon">▥</span>
          <span class="nav-copy"><strong>工作報告</strong><small>Reports</small></span>
        </button>
        <button :class="['nav-item', { active: activeView === 'knowledge' }]" type="button" :aria-current="activeView === 'knowledge' ? 'page' : undefined" @click="changeView('knowledge')">
          <span class="nav-icon">✦</span>
          <span class="nav-copy"><strong>工作知識</strong><small>Knowledge</small></span>
        </button>
        <button :class="['nav-item', { active: activeView === 'graph' }]" type="button" :aria-current="activeView === 'graph' ? 'page' : undefined" @click="changeView('graph')">
          <span class="nav-icon">◎</span>
          <span class="nav-copy"><strong>工作圖譜</strong><small>Graph</small></span>
        </button>
        <button :class="['nav-item', { active: activeView === 'worklog' }]" type="button" :aria-current="activeView === 'worklog' ? 'page' : undefined" @click="changeView('worklog')">
          <span class="nav-icon">≡</span>
          <span class="nav-copy"><strong>工作歷程</strong><small>Worklog</small></span>
        </button>
      </nav>

      <div class="sidebar-note">
        <span class="pulse-dot"></span>
        <div>
          <strong>Policy gate enabled</strong>
          <p>未明確加入的專案，不讀取、不保存。</p>
        </div>
      </div>
    </aside>

    <main class="main-content">
      <header class="topbar">
        <div>
          <div class="eyebrow">WORK MEMORY / MVP</div>
          <h1>{{ activeView === 'dashboard' ? '工作總覽' : activeView === 'projects' ? '專案記錄管理' : activeView === 'reports' ? '工作報告' : activeView === 'knowledge' ? '工作知識' : activeView === 'graph' ? '工作圖譜' : '工作歷程' }}</h1>
        </div>
        <div class="topbar-actions">
          <span class="local-badge"><span class="status-dot"></span>Local-first</span>
          <button class="refresh-button" type="button" aria-label="重新整理" @click="refresh">↻</button>
        </div>
      </header>

      <div v-if="errorMessage" class="alert error-alert">{{ errorMessage }}</div>
      <div v-if="toastMessage" class="toast" @click="toastMessage = ''">{{ toastMessage }}</div>

      <section v-if="loading" class="loading-state">
        <div class="spinner"></div>
        <p>正在載入本機工作資料…</p>
      </section>

      <template v-else>
        <DashboardView v-if="activeView === 'dashboard'">
          <div class="hero-panel">
            <div>
              <div class="eyebrow warm">TODAY'S SIGNAL</div>
              <h2>把完成的工作，<br /><em>變成可搜尋的記憶。</em></h2>
              <p>Agent 完成 closing handoff 後提交 session。只有「記錄中」的專案會通過 policy gate。</p>
            </div>
            <div class="hero-orbit" aria-hidden="true">
              <div class="orbit orbit-one"></div>
              <div class="orbit orbit-two"></div>
              <div class="orbit-core">WI</div>
            </div>
          </div>

          <div class="metric-grid">
            <article class="metric-card accent-blue">
              <div class="metric-label">記錄中專案</div>
              <div class="metric-value">{{ dashboard.trackedProjects }}</div>
              <div class="metric-foot">explicit opt-in</div>
            </article>
            <article class="metric-card accent-green">
              <div class="metric-label">完成 Sessions</div>
              <div class="metric-value">{{ dashboard.finalizedSessions }}</div>
              <div class="metric-foot">不等同 Git commit</div>
            </article>
            <article class="metric-card accent-amber">
              <div class="metric-label">Recorded Events</div>
              <div class="metric-value">{{ dashboard.recordedEvents }}</div>
              <div class="metric-foot">planning → closing</div>
            </article>
          </div>

          <div class="content-grid">
            <section class="panel recent-panel">
              <div class="panel-heading">
                <div>
                  <div class="eyebrow">LATEST MEMORY</div>
                  <h3>最近完成的工作</h3>
                </div>
                <button class="text-button" type="button" @click="changeView('worklog')">查看全部 →</button>
              </div>
              <div v-if="recentSessions.length === 0" class="empty-state">
                <div class="empty-icon">∿</div>
                <strong>還沒有工作紀錄</strong>
                <p>先到 Projects / Tracking 加入一個專案，再切換為「記錄中」。</p>
              </div>
              <template v-else>
                <button v-for="session in recentSessions" :key="session.id" class="session-row" type="button" @click="openSession(session)">
                  <div class="session-marker"></div>
                  <div class="session-main">
                    <strong>{{ session.title }}</strong>
                    <span>{{ session.projectName }} · {{ formatDate(session.completedAt) }} · {{ session.changedFiles.length }} 個檔案</span>
                  </div>
                  <span class="session-arrow">↗</span>
                </button>
              </template>
            </section>

            <section class="panel policy-panel">
              <div class="panel-heading">
                <div>
                  <div class="eyebrow">RECORDING POLICY</div>
                  <h3>Default deny</h3>
                </div>
                <span class="shield">◇</span>
              </div>
              <p class="policy-lead">任何 handoff、Git 或 source 讀取，都必須先通過 project policy gate。</p>
              <div class="policy-flow">
                <div><span class="flow-number">01</span><span>Project discovered</span></div>
                <div class="flow-line"></div>
                <div><span class="flow-number">02</span><span>User opts in</span></div>
                <div class="flow-line"></div>
                <div><span class="flow-number">03</span><span>Agent may finalize</span></div>
              </div>
              <button class="outline-button" type="button" @click="changeView('projects')">管理 tracking 狀態</button>
            </section>
          </div>
        </DashboardView>

        <ProjectsView
          v-else-if="activeView === 'projects'"
          :tracked-projects="trackedProjects"
          :projects="projects"
          :project-name="projectName"
          :project-root="projectRoot"
          :adding-project="addingProject"
          :metadata-backfill-preview="metadataBackfillPreview"
          :metadata-backfill-loading="metadataBackfillLoading"
          :metadata-backfill-error="metadataBackfillError"
          :metadata-backfill-request="metadataBackfillRequest"
          :metadata-backfill-request-is-active="metadataBackfillRequestIsActive"
          :metadata-backfill-status-labels="metadataBackfillStatusLabels"
          :metadata-backfill-request-loading="metadataBackfillRequestLoading"
          :metadata-backfill-request-creating="metadataBackfillRequestCreating"
          :metadata-backfill-request-error="metadataBackfillRequestError"
          :metadata-backfill-instruction="metadataBackfillInstruction"
          :handoff-import-loading="handoffImportLoading"
          :handoff-import-project-id="handoffImportProjectId"
          :status-labels="statusLabels"
          :status-descriptions="statusDescriptions"
          :verification-labels="verificationLabels"
          :format-date="formatDate"
          :metadata-gap-label="metadataGapLabel"
          @update:project-name="projectName = $event"
          @update:project-root="projectRoot = $event"
          @add-project="addProject"
          @preview-metadata-backfill="previewMetadataBackfill"
          @open-metadata-backfill-session="openMetadataBackfillSession"
          @copy-metadata-backfill-instruction="copyMetadataBackfillInstruction"
          @cancel-metadata-backfill-request="cancelMetadataBackfillRequest"
          @load-metadata-backfill-request="loadMetadataBackfillRequest"
          @create-metadata-backfill-request="createMetadataBackfillRequest"
          @preview-handoffs="previewHandoffs"
          @update-project-status="updateProjectStatus"
        />

        <ReportsView
          v-else-if="activeView === 'reports'"
          :tracked-projects="trackedProjects"
          :report="report"
          :report-period="reportPeriod"
          :report-date="reportDate"
          :report-project-id="reportProjectId"
          :report-tab="reportTab"
          :report-loading="reportLoading"
          :report-error="reportError"
          :report-export-loading="reportExportLoading"
          :report-evidence-loading="reportEvidenceLoading"
          :report-evidence-page-size="reportEvidencePageSize"
          :report-evidence-kind="reportEvidenceKind"
          :report-evidence-query="reportEvidenceQuery"
          :report-session-items="reportSessionItems"
          :report-session-page-size="reportSessionPageSize"
          :report-session-page-info="reportSessionPageInfo"
          :report-session-loading="reportSessionLoading"
          :report-synthesis-request="reportSynthesisRequest"
          :report-synthesis-summary="reportSynthesisSummary"
          :report-synthesis-history="reportSynthesisHistory"
          :report-synthesis-expanded="reportSynthesisExpanded"
          :report-synthesis-loading="reportSynthesisLoading"
          :report-synthesis-creating="reportSynthesisCreating"
          :report-synthesis-retrying="reportSynthesisRetrying"
          :report-synthesis-cancelling="reportSynthesisCancelling"
          :report-synthesis-error="reportSynthesisError"
          :report-synthesis-status-labels="reportSynthesisStatusLabels"
          :report-period-labels="reportPeriodLabels"
          :report-tab-options="reportTabOptions"
          :report-synthesis-is-active="reportSynthesisIsActive"
          :report-synthesis-can-retry="reportSynthesisCanRetry"
          :report-comparisons="reportComparisons"
          :report-verification="reportVerification"
          :verification-labels="verificationLabels"
          :evidence-kind-labels="evidenceKindLabels"
          :insight-kind-labels="insightKindLabels"
          :list-page-size-options="listPageSizeOptions"
          :format-date="formatDate"
          :format-readable-summary="formatReadableSummary"
          :format-report-delta="formatReportDelta"
          :format-report-trend-label="formatReportTrendLabel"
          :report-trend-height="reportTrendHeight"
          :should-show-trend-label="shouldShowTrendLabel"
          :verification-label="verificationLabel"
          :evidence-kind-label="evidenceKindLabel"
          @update:report-period="reportPeriod = $event"
          @update:report-date="reportDate = $event"
          @update:report-project-id="reportProjectId = $event"
          @update:report-tab="reportTab = $event"
          @update:report-evidence-page-size="reportEvidencePageSize = $event"
          @update:report-evidence-kind="reportEvidenceKind = $event"
          @update:report-evidence-query="reportEvidenceQuery = $event"
          @update:report-session-page-size="reportSessionPageSize = $event"
          @update:report-synthesis-expanded="reportSynthesisExpanded = $event"
          @load="loadReport"
          @export="exportReport"
          @load-report-synthesis="loadReportSynthesis"
          @retry-report-synthesis="retryReportSynthesisRequest"
          @create-report-synthesis="createReportSynthesisRequest"
          @cancel-report-synthesis="cancelReportSynthesisRequest"
          @select-report-synthesis-version="selectReportSynthesisVersion"
          @delete-report-synthesis-version="deleteReportSynthesisVersion"
          @copy-report-synthesis-instruction="copyReportSynthesisInstruction"
          @open-session="openSession"
          @open-report-session="openReportSession"
          @open-report-evidence="openReportEvidence"
          @change-report-session-page="changeReportSessionPage"
          @change-report-session-page-size="changeReportSessionPageSize"
          @load-report-evidence="loadReportEvidence"
          @change-report-evidence-page="changeReportEvidencePage"
          @change-report-evidence-page-size="changeReportEvidencePageSize"
        />

        <KnowledgeView
          v-else-if="activeView === 'knowledge'"
          :knowledge-items="knowledgeItems"
          :knowledge-projects="knowledgeProjects"
          :knowledge-page-info="knowledgePageInfo"
          :knowledge-query="knowledgeQuery"
          :knowledge-kind="knowledgeKind"
          :knowledge-project-id="knowledgeProjectId"
          :knowledge-status="knowledgeStatus"
          :knowledge-loading="knowledgeLoading"
          :knowledge-error="knowledgeError"
          :knowledge-kind-labels="knowledgeKindLabels"
          :knowledge-status-labels="knowledgeStatusLabels"
          :knowledge-page-size="knowledgePageSize"
          :list-page-size-options="listPageSizeOptions"
          :format-date="formatDate"
          :knowledge-kind-label="knowledgeKindLabel"
          :knowledge-status-label="knowledgeStatusLabel"
          @update:knowledge-query="knowledgeQuery = $event"
          @update:knowledge-kind="knowledgeKind = $event"
          @update:knowledge-project-id="knowledgeProjectId = $event"
          @update:knowledge-status="knowledgeStatus = $event"
          @update:knowledge-page-size="knowledgePageSize = $event"
          @load="loadKnowledge"
          @open-knowledge-session="openKnowledgeSession"
          @open-knowledge-history="openKnowledgeHistory"
          @open-knowledge-editor="openKnowledgeEditor"
          @set-knowledge-status="setKnowledgeStatus"
          @change-knowledge-page="changeKnowledgePage"
          @change-knowledge-page-size="changeKnowledgePageSize"
        />

        <GraphView
          v-else-if="activeView === 'graph'"
          :tracked-projects="trackedProjects"
          :graph="graph"
          :graph-project-id="graphProjectId"
          :graph-node-filter="graphNodeFilter"
          :graph-preview-limit="graphPreviewLimit"
          :graph-load-preset="graphLoadPreset"
          :graph-load-preset-options="graphLoadPresetOptions"
          :graph-loading="graphLoading"
          :graph-error="graphError"
          :graph-node-kind-order="graphNodeKindOrder"
          :graph-node-kind-labels="graphNodeKindLabels"
          :graph-edge-kind-labels="graphEdgeKindLabels"
          :graph-visual="graphVisual"
          :graph-filtered-total-nodes="graphFilteredTotalNodes"
          :graph-node-counts="graphNodeCounts"
          :graph-edge-counts="graphEdgeCounts"
          :graph-can-load-more="graphCanLoadMore"
          :graph-node-filter-label="graphNodeFilterLabel()"
          :graph-node-label="graphNodeLabel"
          :graph-node-description="graphNodeDescription"
          @update:graph-project-id="graphProjectId = $event"
          @update:graph-node-filter="graphNodeFilter = $event"
          @update:graph-preview-limit="graphPreviewLimit = $event"
          @update:graph-load-preset="graphLoadPreset = $event"
          @load="loadGraph"
          @load-more="loadMoreGraph"
          @select-node="openGraphNode"
        />

        <WorklogView
          v-else
          :projects="projects"
          :sessions="sessions"
          :session-page-info="sessionPageInfo"
          :search-term="searchTerm"
          :selected-project-id="selectedProjectId"
          :session-page-size="sessionPageSize"
          :date-from="dateFrom"
          :date-to="dateTo"
          :session-filter-error="sessionFilterError"
          :has-session-filters="hasSessionFilters"
          :active-date-picker="activeDatePicker"
          :date-picker-style="datePickerStyle"
          :picker-month-label="pickerMonthLabel"
          :calendar-days="calendarDays"
          :list-page-size-options="listPageSizeOptions"
          :format-date="formatDate"
          :format-readable-summary="formatReadableSummary"
          :display-date="displayDate"
          :to-date-input-value="toDateInputValue"
          :verification-label="verificationLabel"
          @update:search-term="searchTerm = $event"
          @update:selected-project-id="selectedProjectId = $event"
          @update:session-page-size="sessionPageSize = $event"
          @update:date-from="dateFrom = $event"
          @update:date-to="dateTo = $event"
          @load="loadSessions"
          @clear-session-filters="clearSessionFilters"
          @toggle-date-picker="toggleDatePicker"
          @shift-picker-month="shiftPickerMonth"
          @select-calendar-date="selectCalendarDate"
          @clear-calendar-date="clearCalendarDate"
          @open-session="openSession"
          @change-session-page="changeSessionPage"
          @change-session-page-size="changeSessionPageSize"
        />
      </template>
    </main>

    <HandoffImportModal v-if="handoffImportPreview" :open="Boolean(handoffImportPreview)" @close="closeHandoffImport">
        <header class="detail-modal-header">
          <div>
            <div class="eyebrow">HANDOFF IMPORT / PREVIEW</div>
            <h2>歷史 handoff 匯入預覽</h2>
            <p class="import-project-label">{{ handoffImportPreview.project.name }} · {{ handoffImportPreview.handoffDirectory }}</p>
          </div>
          <button class="close-button" type="button" aria-label="關閉匯入預覽" :disabled="handoffImportApplying" @click="closeHandoffImport">×</button>
        </header>
        <div class="detail-modal-content">
          <p class="import-description">先檢查系統找到的 handoff，再勾選要保存的項目。只有明確標示完成的文件可匯入；blocked、pending、僅規劃與缺少完成狀態的文件會保留在預覽中但不會自動建立 Session。</p>
          <div v-if="handoffImportError" class="alert error-alert" role="alert">{{ handoffImportError }}</div>
          <div class="import-summary-grid">
            <div><span>發現</span><strong>{{ handoffImportPreview.totals.discovered }}</strong></div>
            <div><span>可匯入</span><strong class="import-count-good">{{ handoffImportPreview.totals.eligible }}</strong></div>
            <div><span>已匯入</span><strong>{{ handoffImportPreview.totals.alreadyImported }}</strong></div>
            <div><span>略過／錯誤</span><strong>{{ handoffImportPreview.totals.excluded + handoffImportPreview.totals.errors }}</strong></div>
          </div>
          <div v-if="!handoffImportPreview.directoryFound" class="empty-state import-empty"><strong>找不到 handoff 目錄</strong><p>{{ handoffImportPreview.handoffDirectory }} 目前不存在或沒有可讀取的 Markdown 文件。</p></div>
          <div v-else class="import-list">
            <label v-for="item in handoffImportPreview.items" :key="item.sourcePath" :class="['import-item', `import-item-${item.decision}`]">
              <input type="checkbox" :checked="isHandoffSelected(item.sourcePath)" :disabled="item.decision !== 'eligible' || handoffImportApplying" @change="toggleHandoffSelection(item)" />
              <div class="import-item-copy">
                <div class="import-item-heading"><strong>{{ item.title }}</strong><span>{{ handoffDecisionLabel(item) }}</span></div>
                <code>{{ item.sourcePath }}</code>
                <p v-if="item.summaryPreview">{{ item.summaryPreview }}</p>
                <small>
                  <span v-if="item.recordedDate">記錄日期 {{ item.recordedDate }} · </span>
                  <span v-if="item.verificationStatus">Verification {{ verificationLabels[item.verificationStatus] }} · </span>
                  {{ item.changedFilesStatus === 'detected' ? `${item.changedFiles.length} 個檔案` : item.changedFilesStatus === 'not_found' ? '尚未找到檔案 metadata' : '未讀取檔案 metadata' }}
                  <span v-if="item.detail"> · {{ item.detail }}</span>
                </small>
              </div>
            </label>
          </div>
        </div>
        <footer class="import-modal-footer">
          <span>已選取 {{ selectedHandoffCount }} 個 handoff<span v-if="handoffImportPreview.truncated"> · 已達檔案上限，預覽被截斷</span></span>
          <div>
            <button class="text-button" type="button" :disabled="handoffImportApplying || importableHandoffs.length === 0" @click="selectAllHandoffs">全選可匯入</button>
            <button class="text-button" type="button" :disabled="handoffImportApplying || selectedHandoffCount === 0" @click="clearHandoffSelection">清除選取</button>
            <button class="primary-button" type="button" :disabled="handoffImportApplying || selectedHandoffCount === 0" @click="applyHandoffImport">{{ handoffImportApplying ? '匯入中…' : '套用選取' }}</button>
          </div>
        </footer>
    </HandoffImportModal>

    <GraphNodeModal v-if="selectedGraphNode" :open="Boolean(selectedGraphNode)" @close="selectedGraphNode = null">
        <header class="detail-modal-header">
          <div>
            <div class="eyebrow">GRAPH NODE DETAIL</div>
            <span :class="['graph-node-type-chip', `graph-node-type-${selectedGraphNode.kind}`]">{{ graphNodeKindLabels[selectedGraphNode.kind] }}</span>
          </div>
          <button class="close-button" type="button" aria-label="關閉 Graph 節點詳細資料" @click="selectedGraphNode = null">×</button>
        </header>
        <div class="detail-modal-content graph-node-modal-content">
          <div class="graph-node-detail-heading">
            <span :class="['graph-node-detail-icon', `graph-node-detail-icon-${selectedGraphNode.kind}`]" aria-hidden="true">{{ selectedGraphNode.kind.slice(0, 1).toUpperCase() }}</span>
            <div>
              <h2>{{ selectedGraphNode.label }}</h2>
              <code>{{ selectedGraphNode.id }}</code>
            </div>
          </div>

          <div class="detail-facts graph-node-facts">
            <div><span>節點類型</span><strong>{{ graphNodeKindLabels[selectedGraphNode.kind] }}</strong></div>
            <div><span>來源專案</span><strong>{{ graphNodeProjectName(selectedGraphNode) }}</strong></div>
            <div><span>關係數</span><strong>{{ selectedGraphNodeRelations.length }}</strong></div>
          </div>

          <div v-if="selectedGraphNodeMetadata.length" class="detail-section">
            <div class="eyebrow">STORED METADATA</div>
            <dl class="graph-node-metadata">
              <div v-for="item in selectedGraphNodeMetadata" :key="item.key">
                <dt>{{ item.label }}</dt>
                <dd>{{ item.value }}</dd>
              </div>
            </dl>
          </div>

          <div class="detail-section">
            <div class="eyebrow">RELATED RECORDS</div>
            <div v-if="selectedGraphNodeRelations.length" class="graph-node-relations">
              <button
                v-for="relation in selectedGraphNodeRelations"
                :key="relation.edge.id"
                class="graph-node-relation"
                type="button"
                @click="selectGraphRelatedNode(relation.relatedNode)"
              >
                <span class="graph-relation-direction" aria-hidden="true">{{ relation.direction === 'outgoing' ? '→' : '←' }}</span>
                <span class="graph-node-relation-copy">
                  <strong>{{ graphNodeLabel(relation.relatedNode.label) }}</strong>
                  <small>{{ graphEdgeKindLabels[relation.edge.kind] }} · {{ graphNodeKindLabels[relation.relatedNode.kind] }}</small>
                </span>
                <span class="graph-relation-open" aria-hidden="true">↗</span>
              </button>
            </div>
            <div v-else class="graph-node-no-relations">這個節點目前沒有其他已保存的關係。</div>
          </div>

          <footer class="graph-node-actions">
            <button v-if="selectedGraphNode.sessionId" class="outline-button" type="button" @click="openGraphSession(selectedGraphNode)">查看 Session 詳情</button>
            <button v-if="selectedGraphNode.kind === 'knowledge'" class="outline-button" type="button" @click="openGraphKnowledge(selectedGraphNode)">維護 Knowledge</button>
            <button v-if="selectedGraphNode.kind === 'project'" class="outline-button" type="button" @click="openGraphProject">管理專案</button>
          </footer>
        </div>
    </GraphNodeModal>

    <SessionDetailModal v-if="selectedDetail" :open="Boolean(selectedDetail)" @close="selectedDetail = null">
        <header class="detail-modal-header">
          <div class="eyebrow">SESSION DETAIL / {{ selectedDetail.session.status.toUpperCase() }}</div>
          <button class="close-button" type="button" aria-label="關閉" @click="selectedDetail = null">×</button>
        </header>
        <div ref="detailModalContent" class="detail-modal-content">
          <h2>{{ selectedDetail.session.title }}</h2>
          <div class="detail-project"><span class="project-avatar small">{{ selectedDetail.project.name.slice(0, 1).toUpperCase() }}</span><div><strong>{{ selectedDetail.project.name }}</strong><span>{{ selectedDetail.project.rootPath }}</span></div></div>
          <p class="detail-summary">{{ formatReadableSummary(selectedDetail.session.summary) }}</p>
          <div v-if="selectedDetail.session.workSummary" class="detail-section structured-work-summary">
            <div class="eyebrow">WORK SUMMARY</div>
            <div class="work-summary-grid">
              <article v-for="section in workSummarySectionLabels" :key="section.key" class="work-summary-section">
                <span>{{ section.label }}</span>
                <ul v-if="selectedDetail.session.workSummary[section.key].length">
                  <li v-for="item in selectedDetail.session.workSummary[section.key]" :key="item">{{ item }}</li>
                </ul>
                <em v-else>—</em>
              </article>
            </div>
          </div>
          <div class="detail-facts">
            <div><span>執行狀態 Execution</span><strong>{{ executionStatusLabels[selectedDetail.session.executionStatus] }}</strong></div>
            <div><span>完成時間 Completed</span><strong>{{ formatDate(selectedDetail.session.completedAt) }}</strong></div>
            <div><span>Git commit（可選）</span><strong>{{ selectedDetail.session.commitSha ? selectedDetail.session.commitSha.slice(0, 8) : '未要求' }}</strong></div>
            <div><span>驗證 Verification</span><strong :class="['detail-verification', `verification-${selectedDetail.session.verification?.status ?? 'not_supplied'}`]">{{ verificationLabels[selectedDetail.session.verification?.status ?? 'not_supplied'] }}</strong></div>
          </div>
          <div class="detail-section"><div class="eyebrow">EVENT TIMELINE</div><div v-for="event in selectedDetail.events" :key="event.id" class="detail-event"><span class="event-type">{{ event.type }}</span><div><strong>{{ event.summary }}</strong><small>{{ formatDate(event.occurredAt) }} <span v-if="event.details">· {{ eventDetails(event.details) }}</span></small></div></div></div>
          <div v-if="selectedDetail.evidence.length" class="detail-section"><div class="eyebrow">ATTACHED EVIDENCE</div><div class="detail-evidence-list"><div v-for="item in selectedDetail.evidence" :key="item.id" class="detail-evidence-item"><div><strong>{{ item.kind }}</strong><small>{{ formatDate(item.capturedAt) }}</small></div><p v-if="item.summary">{{ item.summary }}</p><code>{{ item.reference }}</code></div></div></div>
          <div v-if="selectedDetail.knowledge.length" class="detail-section"><div class="eyebrow">LINKED KNOWLEDGE</div><div class="detail-knowledge-list"><article v-for="item in selectedDetail.knowledge" :key="item.id" class="detail-knowledge-item"><div class="detail-knowledge-heading"><strong>{{ item.title }}</strong><span>{{ knowledgeKindLabels[item.kind] }}</span></div><p>{{ item.body }}</p><small v-if="item.tags.length">{{ formatKnowledgeTags(item.tags) }}</small></article></div></div>
          <div v-if="selectedDetail.rawSnapshots.length" class="detail-section"><div class="eyebrow">RAW HANDOFF SNAPSHOT</div><pre class="snapshot">{{ selectedDetail.rawSnapshots[0]?.content }}</pre></div>
          <div class="detail-section">
            <div class="eyebrow">CHANGED FILES</div>
            <div class="file-list">
              <div v-for="file in selectedDetail.session.changedFiles" :key="file" class="file-list-item"><code>{{ file }}</code><span class="file-source">來源：{{ changedFileSourceLabel(selectedDetail.session, file) }}</span></div>
              <span v-if="!selectedDetail.session.changedFiles.length" class="muted">尚未提供檔案 metadata</span>
            </div>
            <div v-if="selectedDetail.session.changedFileChanges.length" class="file-change-history">
              <div class="eyebrow">FILE HISTORY</div>
              <div class="file-list">
                <div v-for="change in selectedDetail.session.changedFileChanges" :key="`${change.status}-${change.previousPath ?? ''}-${change.path}`" class="file-list-item file-change-history-item"><code>{{ change.status === 'renamed' ? `${change.previousPath} → ${change.path}` : change.path }}</code><span class="file-source">{{ changedFileChangeStatusLabels[change.status] }}</span></div>
              </div>
            </div>
          </div>
        </div>
    </SessionDetailModal>

    <KnowledgeHistoryModal v-if="knowledgeHistoryItem" :open="Boolean(knowledgeHistoryItem)" @close="closeKnowledgeHistory">
        <header class="detail-modal-header">
          <div>
            <div class="eyebrow">KNOWLEDGE AUDIT HISTORY</div>
            <h2>變更紀錄</h2>
            <p class="knowledge-editor-project">{{ knowledgeHistoryItem.title }}</p>
          </div>
          <button class="close-button" type="button" aria-label="關閉 Knowledge 變更紀錄" @click="closeKnowledgeHistory">×</button>
        </header>
        <div class="detail-modal-content knowledge-history-content">
          <p class="knowledge-editor-note">這裡顯示中央 registry 保存的前後狀態快照；不會讀取來源 repo，也不會重新推論內容。</p>
          <section v-if="knowledgeHistoryLoading" class="loading-state knowledge-history-loading"><div class="spinner"></div><p>正在載入變更紀錄…</p></section>
          <div v-else-if="knowledgeHistoryError" class="alert error-alert" role="alert">{{ knowledgeHistoryError }}</div>
          <div v-else-if="knowledgeHistory.length" class="knowledge-history-list">
            <article v-for="entry in knowledgeHistory" :key="entry.id" class="knowledge-history-entry">
              <div :class="['knowledge-history-marker', `knowledge-history-marker-${entry.action}`]">{{ knowledgeAuditActionLabels[entry.action].slice(0, 1) }}</div>
              <div class="knowledge-history-entry-body">
                <div class="knowledge-history-heading">
                  <div><strong>{{ knowledgeAuditActionLabels[entry.action] }} Knowledge</strong><span>{{ knowledgeAuditFields(entry) }}</span></div>
                  <time>{{ formatDate(entry.occurredAt) }}</time>
                </div>
                <div class="knowledge-history-snapshots">
                  <div v-if="entry.before" class="knowledge-history-snapshot">
                    <span>變更前</span>
                    <strong>{{ entry.before.title }}</strong>
                    <p>{{ entry.before.body }}</p>
                  </div>
                  <div class="knowledge-history-snapshot knowledge-history-snapshot-current">
                    <span>{{ entry.before ? '變更後' : '初始內容' }}</span>
                    <strong>{{ entry.after.title }}</strong>
                    <p>{{ entry.after.body }}</p>
                  </div>
                </div>
              </div>
            </article>
          </div>
          <div v-else class="empty-state large-empty knowledge-history-empty"><div class="empty-icon">↺</div><strong>尚無變更紀錄</strong><p>這筆 Knowledge 可能是在 audit history 功能加入前建立，目前只會從下一次變更開始追蹤。</p></div>
        </div>
    </KnowledgeHistoryModal>

    <KnowledgeEditorModal v-if="knowledgeEditor" :open="Boolean(knowledgeEditor)" @close="closeKnowledgeEditor">
        <header class="detail-modal-header">
          <div>
            <div class="eyebrow">KNOWLEDGE MAINTENANCE</div>
            <p class="knowledge-editor-project">{{ knowledgeEditor.projectName ?? 'Tracked project' }}</p>
          </div>
          <button class="close-button" type="button" aria-label="關閉 Knowledge 編輯器" :disabled="knowledgeEditorSaving" @click="closeKnowledgeEditor">×</button>
        </header>
        <form class="detail-modal-content knowledge-editor-content" @submit.prevent="saveKnowledge">
          <h2>維護已確認的 Knowledge</h2>
          <p class="knowledge-editor-note">這裡只修改中央 registry 中的明確 Knowledge，不會讀取或修改來源 repo。</p>
          <div v-if="knowledgeEditorError" class="alert error-alert" role="alert">{{ knowledgeEditorError }}</div>
          <div class="knowledge-editor-grid">
            <label class="knowledge-editor-field knowledge-editor-title-field">
              <span>標題</span>
              <input v-model="knowledgeEditorForm.title" type="text" maxlength="300" required />
            </label>
            <label class="knowledge-editor-field">
              <span>類型</span>
              <select v-model="knowledgeEditorForm.kind">
                <option v-for="(label, kind) in knowledgeKindLabels" :key="kind" :value="kind">{{ label }}</option>
              </select>
            </label>
            <label class="knowledge-editor-field">
              <span>狀態</span>
              <select v-model="knowledgeEditorForm.status">
                <option v-for="(label, status) in knowledgeStatusLabels" :key="status" :value="status">{{ label }}</option>
              </select>
            </label>
          </div>
          <label class="knowledge-editor-field">
            <span>內容</span>
            <textarea v-model="knowledgeEditorForm.body" rows="8" maxlength="20000" required></textarea>
          </label>
          <div class="knowledge-editor-grid">
            <label class="knowledge-editor-field">
              <span>標籤</span>
              <input v-model="knowledgeEditorForm.tags" type="text" placeholder="以逗號分隔，例如：architecture, registry" />
            </label>
            <label class="knowledge-editor-field">
              <span>參考資料</span>
              <textarea v-model="knowledgeEditorForm.references" rows="3" placeholder="每行一個 reference"></textarea>
            </label>
          </div>
          <footer class="knowledge-editor-footer">
            <span>封存不會刪除記錄，只會從預設搜尋與 Graph 隱藏。</span>
            <div>
              <button class="text-button" type="button" :disabled="knowledgeEditorSaving" @click="closeKnowledgeEditor">取消</button>
              <button class="primary-button" type="submit" :disabled="knowledgeEditorSaving">{{ knowledgeEditorSaving ? '儲存中…' : '儲存變更' }}</button>
            </div>
          </footer>
        </form>
    </KnowledgeEditorModal>
  </div>
</template>
