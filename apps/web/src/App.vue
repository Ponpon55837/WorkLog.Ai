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
  { key: "nextSteps", label: "後續" }
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

async function loadGraph(): Promise<void> {
  const requestKey = "graph";
  const controller = beginRequest(requestKey);
  graphLoading.value = true;
  graphError.value = "";
  const loadPreset = graphLoadPresetOptions.find((preset) => preset.value === graphLoadPreset.value) ?? graphLoadPresetOptions[0];
  try {
    const result = await client.getGraph({
      projectId: graphProjectId.value || undefined,
      limit: 40,
      maxNodes: loadPreset.maxNodes,
      maxEdges: loadPreset.maxEdges
    }, controller.signal);
    if (result.outcome === "graph") {
      graph.value = result;
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
  const currentIndex = graphLoadPresetOptions.findIndex((preset) => preset.value === graphLoadPreset.value);
  const nextPreset = graphLoadPresetOptions[Math.min(currentIndex + 1, graphLoadPresetOptions.length - 1)];
  if (!nextPreset || nextPreset.value === graphLoadPreset.value) {
    toastMessage.value = "圖譜已達目前可載入上限。";
    return;
  }
  graphLoadPreset.value = nextPreset.value;
  await loadGraph();
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

function toggleDatePicker(target: DatePickerTarget): void {
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
  if (!graph.value) {
    return false;
  }
  const currentIndex = graphLoadPresetOptions.findIndex((preset) => preset.value === graphLoadPreset.value);
  return (graph.value.truncation.nodesTruncated || graph.value.truncation.edgesTruncated) && currentIndex < graphLoadPresetOptions.length - 1;
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

        <ProjectsView v-else-if="activeView === 'projects'">
          <div class="section-intro projects-intro">
            <div>
              <div class="eyebrow">PROJECT REGISTRY</div>
              <h2>你決定哪些專案值得被記住。</h2>
              <p>Registry 只存在中央 SQLite，不會把設定檔寫進任何專案 repo。</p>
            </div>
            <div class="tracked-summary"><strong>{{ trackedProjects.length }}</strong><span>個專案正在記錄</span></div>
          </div>

          <section class="panel add-project-panel">
            <div class="panel-heading compact">
              <div>
                <div class="eyebrow">ADD PROJECT</div>
                <h3>加入 registry</h3>
              </div>
              <span class="opt-in-label">加入後預設為未註冊</span>
            </div>
            <form class="project-form" @submit.prevent="addProject">
              <label>
                <span>專案名稱</span>
                <input v-model="projectName" type="text" placeholder="例如：Assistant Console" />
              </label>
              <label class="path-field">
                <span>Workspace 根目錄</span>
                <input v-model="projectRoot" type="text" placeholder="C:\\Users\\you\\project" />
              </label>
              <button class="primary-button" type="submit" :disabled="addingProject">{{ addingProject ? '加入中…' : '加入專案' }}</button>
            </form>
          </section>

          <section class="panel metadata-backfill-panel">
            <div class="metadata-backfill-heading">
              <div>
                <div class="eyebrow">AGENT FOLLOW-UPS</div>
                <h3>需要 Agent 回補的 Session</h3>
                <p>只列出已完成但缺少 Verification 或 changed-files metadata 的 tracked Session。這裡不會猜測，也不會自動寫回。</p>
              </div>
              <button class="outline-button" type="button" :disabled="metadataBackfillLoading" @click="previewMetadataBackfill">{{ metadataBackfillLoading ? '掃描中…' : '掃描 metadata 缺口' }}</button>
            </div>
            <div v-if="metadataBackfillError" class="alert error-alert metadata-backfill-alert" role="alert">{{ metadataBackfillError }}</div>
            <template v-if="metadataBackfillPreview">
              <div class="metadata-backfill-summary">
                <div><span>需要回補</span><strong>{{ metadataBackfillPreview.totals.needsBackfill }}</strong></div>
                <div><span>檔案 metadata</span><strong>{{ metadataBackfillPreview.totals.changedFilesMissing }}</strong></div>
                <div><span>Verification 缺漏</span><strong>{{ metadataBackfillPreview.totals.verificationMissing }}</strong></div>
                <div><span>明確未執行</span><strong>{{ metadataBackfillPreview.totals.verificationNotRun }}</strong></div>
              </div>
              <div v-if="metadataBackfillPreview.items.length" class="metadata-backfill-list">
                <article v-for="item in metadataBackfillPreview.items" :key="item.sessionId" class="metadata-backfill-item">
                  <div class="metadata-backfill-item-copy">
                    <strong>{{ item.title }}</strong>
                    <span>{{ item.projectName }} · {{ formatDate(item.completedAt) }}</span>
                    <small>{{ item.changedFilesCount }} 個檔案 · {{ item.changedFileChangesCount }} 筆生命週期紀錄 · {{ item.rawSnapshotCount }} 份 handoff snapshot</small>
                  </div>
                  <div class="metadata-backfill-gaps">
                    <span v-for="gap in item.gaps" :key="gap" class="metadata-gap-chip">{{ metadataGapLabel(gap) }}</span>
                    <span class="metadata-verification-chip">{{ verificationLabels[item.verificationStatus] }}</span>
                  </div>
                  <button class="text-button" type="button" @click="openMetadataBackfillSession(item)">查看 Session</button>
                </article>
              </div>
              <div v-else class="metadata-backfill-empty"><strong>目前沒有待回補資料</strong><p>所有 tracked Session 都已提供必要的結構化 metadata。</p></div>
              <p v-if="metadataBackfillPreview.truncated" class="metadata-backfill-note">結果已達顯示上限，請由 Agent 使用 MCP preview 的 limit 分頁檢查其餘 Session。</p>
            </template>
              <div v-else class="metadata-backfill-empty metadata-backfill-empty-initial"><strong>尚未掃描</strong><p>按下掃描後，系統只會讀取中央 SQLite 中已保存的 Session metadata。</p></div>

            <div v-if="metadataBackfillRequest" class="metadata-backfill-agent-card">
              <div class="metadata-backfill-agent-heading">
                <div>
                  <div class="eyebrow">AGENT REQUEST</div>
                  <h4>請 Agent 回補 metadata</h4>
                  <p v-if="metadataBackfillRequestIsActive">請在目前的 Codex 或 Claude 對話中輸入：「{{ metadataBackfillInstruction }}」Agent 會自行取得待回補清單、檢查 tracked 專案的 worktree／handoff，再只寫回已確認的 metadata。</p>
                  <p v-else-if="metadataBackfillRequest.status === 'completed'">這批 metadata 已完成回補。重新掃描後，若仍有缺口會建立新的待處理請求。</p>
                  <p v-else>這批 metadata 回補尚未完成，請重新整理狀態或再次請 Agent 處理。</p>
                </div>
                <span :class="['synthesis-status', `synthesis-status-${metadataBackfillRequest.status}`]">{{ metadataBackfillStatusLabels[metadataBackfillRequest.status] }}</span>
              </div>
              <div class="metadata-backfill-agent-actions">
                <button class="primary-button" type="button" :disabled="metadataBackfillRequestLoading" @click="copyMetadataBackfillInstruction">複製 Agent 指令</button>
                <button v-if="metadataBackfillRequestIsActive" class="text-button cancel-button" type="button" :disabled="metadataBackfillRequestLoading" @click="cancelMetadataBackfillRequest">{{ metadataBackfillRequestLoading ? '取消中…' : '取消回補' }}</button>
                <button class="icon-button report-icon-button" type="button" :disabled="metadataBackfillRequestLoading" aria-label="重新整理 metadata 回補狀態" title="重新整理 metadata 回補狀態" @click="loadMetadataBackfillRequest"><span aria-hidden="true">↻</span></button>
                <button v-if="!metadataBackfillRequestIsActive && metadataBackfillPreview?.items.length" class="text-button" type="button" :disabled="metadataBackfillRequestCreating" @click="createMetadataBackfillRequest">重新建立回補請求</button>
              </div>
            </div>
            <div v-else-if="metadataBackfillPreview?.items.length" class="metadata-backfill-agent-card metadata-backfill-agent-card-warning">
              <div class="metadata-backfill-agent-heading">
                <div>
                  <div class="eyebrow">ACTION REQUIRED</div>
                  <h4>這些缺口需要 Agent 確認</h4>
                  <p>掃描結果不會自行猜測檔案或驗證狀態；建立請求後，Agent 才能在目前對話中檢查並回寫。</p>
                </div>
              </div>
              <div class="metadata-backfill-agent-actions">
                <button class="primary-button" type="button" :disabled="metadataBackfillRequestCreating" @click="createMetadataBackfillRequest">{{ metadataBackfillRequestCreating ? '建立中…' : '請 Agent 回補 metadata' }}</button>
              </div>
            </div>
            <div v-if="metadataBackfillRequestError" class="alert error-alert metadata-backfill-alert" role="alert">{{ metadataBackfillRequestError }}</div>
          </section>

          <section class="project-list">
            <div class="list-heading"><span>所有專案</span><span>記錄狀態</span></div>
            <article v-for="project in projects" :key="project.id" class="project-row">
              <div class="project-avatar">{{ project.name.slice(0, 1).toUpperCase() }}</div>
              <div class="project-info">
                <strong>{{ project.name }}</strong>
                <span>{{ project.rootPath }}</span>
              </div>
              <div class="project-status-copy">
                <span :class="['status-chip', `status-${project.status}`]"><span class="chip-dot"></span>{{ statusLabels[project.status] }}</span>
                <small>{{ statusDescriptions[project.status] }}</small>
                <button v-if="project.status === 'tracked'" class="text-button import-trigger" type="button" :disabled="handoffImportLoading && handoffImportProjectId === project.id" @click.stop="previewHandoffs(project)">{{ handoffImportLoading && handoffImportProjectId === project.id ? '預覽中…' : '預覽 handoff' }}</button>
              </div>
              <select :value="project.status" :aria-label="`更新 ${project.name} 的專案記錄狀態`" @change="updateProjectStatus(project, ($event.target as HTMLSelectElement).value as ProjectStatus)">
                <option value="unregistered">未註冊</option>
                <option value="tracked">記錄中</option>
                <option value="paused">已暫停</option>
                <option value="ignored">已忽略</option>
              </select>
            </article>
            <div v-if="projects.length === 0" class="empty-state large-empty"><div class="empty-icon">◈</div><strong>還沒有專案</strong><p>加入第一個 workspace，建立你的中央 project registry。</p></div>
          </section>
        </ProjectsView>

        <ReportsView v-else-if="activeView === 'reports'">
          <div class="section-intro reports-intro">
            <div>
              <div class="eyebrow">WORK REPORTS</div>
              <h2>把已完成的工作，整理成可讀的節奏。</h2>
              <p>報告只聚合「記錄中」的專案，並保留每筆來源 Session。</p>
            </div>
            <form class="report-tools" @submit.prevent="loadReport(true)">
              <label class="report-control">
                <span>報表區間</span>
                <select v-model="reportPeriod" aria-label="選擇報表區間" @change="loadReport(true)">
                  <option value="day">今日</option>
                  <option value="week">本週</option>
                  <option value="month">本月</option>
                  <option value="quarter">本季</option>
                  <option value="year">本年</option>
                </select>
              </label>
              <label class="report-control report-date-control">
                <span>報告日期</span>
                <input v-model="reportDate" type="date" aria-label="選擇報告日期" @change="loadReport(true)" />
              </label>
              <label class="report-control">
                <span>專案範圍</span>
                <select v-model="reportProjectId" aria-label="選擇報表專案" @change="loadReport(true)">
                  <option value="">所有記錄中專案</option>
                  <option v-for="project in trackedProjects" :key="project.id" :value="project.id">{{ project.name }}</option>
                </select>
              </label>
              <button class="filter-button report-refresh report-refresh-icon" type="submit" :disabled="reportLoading" :aria-busy="reportLoading" aria-label="重新整理報告" title="重新整理報告"><span class="refresh-icon" aria-hidden="true">{{ reportLoading ? '…' : '↻' }}</span><span class="sr-only">{{ reportLoading ? '整理中' : '重新整理報告' }}</span></button>
              <div class="report-export-actions" aria-label="匯出報告">
                <button class="text-button report-export-button" type="button" :disabled="reportLoading || !report || reportExportLoading !== null" @click="exportReport('markdown')">{{ reportExportLoading === 'markdown' ? '產生中…' : '下載 Markdown' }}</button>
                <button class="text-button report-export-button" type="button" :disabled="reportLoading || !report || reportExportLoading !== null" @click="exportReport('json')">{{ reportExportLoading === 'json' ? '產生中…' : '匯出 JSON' }}</button>
              </div>
            </form>
          </div>

          <div v-if="reportError" class="alert error-alert report-error" role="alert">{{ reportError }}</div>
          <section v-if="reportLoading" class="loading-state report-loading">
            <div class="spinner"></div>
            <p>正在整理本機工作報告…</p>
          </section>
          <template v-else-if="report">
            <div class="report-range-note">
              <div><span>{{ reportPeriodLabels[report.period] }}</span><strong>{{ report.range.from }} — {{ report.range.to }}</strong></div>
              <small>資料時區 {{ report.timezone }} · {{ report.sourceSessionIds.length }} 筆來源 Session</small>
            </div>

            <nav class="report-tabs" role="tablist" aria-label="工作報告內容分頁">
              <button
                v-for="tab in reportTabOptions"
                :id="`report-tab-${tab.id}`"
                :key="tab.id"
                class="report-tab"
                :class="{ 'report-tab-active': reportTab === tab.id }"
                type="button"
                role="tab"
                :aria-selected="reportTab === tab.id"
                :aria-controls="`report-tab-panel-${tab.id}`"
                :title="tab.label"
                @click="reportTab = tab.id"
              >
                <span>{{ tab.shortLabel }}</span>
              </button>
            </nav>

            <div class="report-tab-panels">
              <section id="report-tab-panel-overview" class="report-tab-panel" role="tabpanel" aria-labelledby="report-tab-overview" v-show="reportTab === 'overview'">

            <details class="report-synthesis-card" :open="reportSynthesisExpanded || !reportSynthesisSummary" @toggle="reportSynthesisExpanded = ($event.currentTarget as HTMLDetailsElement).open">
              <summary class="report-synthesis-summary">
                <div class="report-synthesis-heading">
                <div>
                  <div class="eyebrow">AGENT SYNTHESIS</div>
                  <h3>{{ reportSynthesisSummary?.title ?? '管理層摘要' }}</h3>
                </div>
                <span v-if="reportSynthesisRequest" :class="['synthesis-status', `synthesis-status-${reportSynthesisRequest.status}`]">{{ reportSynthesisStatusLabels[reportSynthesisRequest.status] }}</span>
                </div>
              </summary>
              <div v-if="reportSynthesisLoading" class="report-synthesis-loading"><span class="spinner small-spinner"></span><span>正在讀取提煉狀態…</span></div>
              <template v-else-if="reportSynthesisSummary && !reportSynthesisIsActive">
                <p class="report-synthesis-executive">{{ reportSynthesisSummary.executiveSummary }}</p>
                <div class="report-synthesis-block-grid">
                  <section v-if="reportSynthesisSummary.themes.length" class="report-synthesis-block">
                    <div class="eyebrow">WORKSTREAMS</div>
                    <article v-for="block in reportSynthesisSummary.themes" :key="`${block.title}-${block.detail}`" class="synthesis-block-item">
                      <strong>{{ block.title }}</strong><p>{{ block.detail }}</p>
                      <div class="synthesis-sources"><button v-for="sourceId in block.sourceSessionIds" :key="sourceId" type="button" @click="openReportSession(sourceId)">來源 Session · {{ sourceId.slice(0, 8) }} ↗</button><span v-if="!block.sourceSessionIds.length">資料不足，未提供來源 Session</span></div>
                    </article>
                  </section>
                  <section v-if="reportSynthesisSummary.highlights.length" class="report-synthesis-block">
                    <div class="eyebrow">HIGHLIGHTS</div>
                    <article v-for="block in reportSynthesisSummary.highlights" :key="`${block.title}-${block.detail}`" class="synthesis-block-item">
                      <strong>{{ block.title }}</strong><p>{{ block.detail }}</p>
                      <div class="synthesis-sources"><button v-for="sourceId in block.sourceSessionIds" :key="sourceId" type="button" @click="openReportSession(sourceId)">來源 Session · {{ sourceId.slice(0, 8) }} ↗</button><span v-if="!block.sourceSessionIds.length">資料不足，未提供來源 Session</span></div>
                    </article>
                  </section>
                  <section v-if="reportSynthesisSummary.risks.length" class="report-synthesis-block">
                    <div class="eyebrow">RISKS</div>
                    <article v-for="block in reportSynthesisSummary.risks" :key="`${block.title}-${block.detail}`" class="synthesis-block-item synthesis-risk-item">
                      <strong>{{ block.title }}</strong><p>{{ block.detail }}</p>
                      <div class="synthesis-sources"><button v-for="sourceId in block.sourceSessionIds" :key="sourceId" type="button" @click="openReportSession(sourceId)">來源 Session · {{ sourceId.slice(0, 8) }} ↗</button><span v-if="!block.sourceSessionIds.length">資料不足，未提供來源 Session</span></div>
                    </article>
                  </section>
                  <section v-if="reportSynthesisSummary.decisions.length" class="report-synthesis-block">
                    <div class="eyebrow">DECISIONS</div>
                    <article v-for="block in reportSynthesisSummary.decisions" :key="`${block.title}-${block.detail}`" class="synthesis-block-item">
                      <strong>{{ block.title }}</strong><p>{{ block.detail }}</p>
                      <div class="synthesis-sources"><button v-for="sourceId in block.sourceSessionIds" :key="sourceId" type="button" @click="openReportSession(sourceId)">來源 Session · {{ sourceId.slice(0, 8) }} ↗</button><span v-if="!block.sourceSessionIds.length">資料不足，未提供來源 Session</span></div>
                    </article>
                  </section>
                  <section v-if="reportSynthesisSummary.nextSteps.length" class="report-synthesis-block">
                    <div class="eyebrow">NEXT STEPS</div>
                    <article v-for="block in reportSynthesisSummary.nextSteps" :key="`${block.title}-${block.detail}`" class="synthesis-block-item">
                      <strong>{{ block.title }}</strong><p>{{ block.detail }}</p>
                      <div class="synthesis-sources"><button v-for="sourceId in block.sourceSessionIds" :key="sourceId" type="button" @click="openReportSession(sourceId)">來源 Session · {{ sourceId.slice(0, 8) }} ↗</button><span v-if="!block.sourceSessionIds.length">資料不足，未提供來源 Session</span></div>
                    </article>
                  </section>
                  <section v-if="reportSynthesisSummary.verification.length" class="report-synthesis-block">
                    <div class="eyebrow">VERIFICATION</div>
                    <article v-for="block in reportSynthesisSummary.verification" :key="`${block.title}-${block.detail}`" class="synthesis-block-item">
                      <strong>{{ block.title }}</strong><p>{{ block.detail }}</p>
                      <div class="synthesis-sources"><button v-for="sourceId in block.sourceSessionIds" :key="sourceId" type="button" @click="openReportSession(sourceId)">來源 Session · {{ sourceId.slice(0, 8) }} ↗</button><span v-if="!block.sourceSessionIds.length">資料不足，未提供來源 Session</span></div>
                    </article>
                  </section>
                  <section v-if="reportSynthesisSummary.comparison.length" class="report-synthesis-block">
                    <div class="eyebrow">COMPARISON</div>
                    <article v-for="block in reportSynthesisSummary.comparison" :key="`${block.title}-${block.detail}`" class="synthesis-block-item">
                      <strong>{{ block.title }}</strong><p>{{ block.detail }}</p>
                      <div class="synthesis-sources"><button v-for="sourceId in block.sourceSessionIds" :key="sourceId" type="button" @click="openReportSession(sourceId)">來源 Session · {{ sourceId.slice(0, 8) }} ↗</button><span v-if="!block.sourceSessionIds.length">資料不足，未提供來源 Session</span></div>
                    </article>
                  </section>
                </div>
                <div class="report-synthesis-footer"><span>由 {{ reportSynthesisSummary.generatedByAgent }} 產生 · Prompt {{ reportSynthesisSummary.promptVersion }} · {{ formatDate(reportSynthesisSummary.createdAt) }}</span><span v-if="reportSynthesisRequest?.failureReason" class="report-synthesis-failure">{{ reportSynthesisRequest.failureReason }}</span><div class="report-synthesis-footer-actions"><button class="icon-button report-icon-button" type="button" :disabled="reportSynthesisLoading" aria-label="重新整理提煉狀態" title="重新整理提煉狀態" @click="loadReportSynthesis"><span aria-hidden="true">↻</span></button><button class="text-button" type="button" :disabled="reportSynthesisCreating || reportSynthesisRetrying" @click="reportSynthesisCanRetry ? retryReportSynthesisRequest() : createReportSynthesisRequest()">{{ reportSynthesisCanRetry ? (reportSynthesisRetrying ? '重試中…' : '重試這次提煉') : '重新提煉' }}</button></div></div>
                <details v-if="reportSynthesisHistory.length > 1" class="report-synthesis-history">
                  <summary><span>歷史版本</span><span>{{ reportSynthesisHistory.length }} 個版本</span></summary>
                  <div class="report-synthesis-history-list">
                    <div
                      v-for="summary in reportSynthesisHistory"
                      :key="summary.id"
                      :class="['report-synthesis-history-item', { 'report-synthesis-history-item-current': reportSynthesisSummary.id === summary.id }]"
                    >
                      <button class="report-synthesis-history-select" type="button" :aria-pressed="reportSynthesisSummary.id === summary.id" @click="selectReportSynthesisVersion(summary)">
                        <span class="report-synthesis-history-item-copy"><strong>{{ summary.title }}</strong><small>{{ formatDate(summary.createdAt) }} · {{ summary.generatedByAgent }}</small></span>
                        <span class="report-synthesis-history-item-status">{{ summary.isCurrent ? '目前版本' : '歷史版本' }}</span>
                      </button>
                      <button v-if="!summary.isCurrent" class="icon-button report-synthesis-history-delete" type="button" :aria-label="`移除歷史版本 ${summary.title}`" :title="`移除歷史版本 ${summary.title}`" @click.stop="deleteReportSynthesisVersion(summary)"><span aria-hidden="true">×</span></button>
                    </div>
                  </div>
                </details>
              </template>
              <div v-else class="report-synthesis-empty">
                <div class="report-synthesis-message">
                  <p v-if="reportSynthesisRequest">{{ reportSynthesisRequest.status === 'pending' ? '請在目前的 Codex 或 Claude 對話中用自然語言請 Agent 處理這份報告。' : reportSynthesisRequest.status === 'processing' ? 'Agent 已開始處理；完成後可重新整理狀態。' : reportSynthesisRequest.status === 'failed' || reportSynthesisRequest.status === 'cancelled' ? '這次提煉沒有完成，可以重新建立一次安全的提煉請求。' : '目前沒有可顯示的提煉內容。' }}</p>
                  <p v-if="reportSynthesisRequest?.failureReason" class="report-synthesis-error">{{ reportSynthesisRequest.failureReason }}</p>
                  <p v-if="reportSynthesisSummary && reportSynthesisIsActive" class="report-synthesis-previous-note">上一版摘要仍保留在資料庫；新的提煉完成後才會替換，期間不會遺失早上的報告。</p>
                  <p v-if="!reportSynthesisRequest">這份 deterministic report 尚未建立 Agent 提煉請求。按下按鈕後，WorkLog 只會建立待處理請求，不會反向呼叫任何 Agent。</p>
                </div>
                <div class="report-synthesis-actions">
                  <button v-if="reportSynthesisCanRetry" class="primary-button" type="button" :disabled="reportSynthesisRetrying" @click="retryReportSynthesisRequest">{{ reportSynthesisRetrying ? '重試中…' : '重試這次提煉' }}</button>
                  <button v-else class="primary-button" type="button" :disabled="reportSynthesisCreating || reportSynthesisIsActive" @click="createReportSynthesisRequest">{{ reportSynthesisCreating ? '建立中…' : reportSynthesisIsActive ? '等待 Agent 處理中…' : reportSynthesisRequest ? '重新提煉本報告' : '請 Agent 提煉本報告' }}</button>
                  <button v-if="reportSynthesisRequest" class="text-button" type="button" @click="copyReportSynthesisInstruction">複製提煉指令</button>
                  <button v-if="reportSynthesisIsActive" class="text-button cancel-button" type="button" :disabled="reportSynthesisCancelling" @click="cancelReportSynthesisRequest">{{ reportSynthesisCancelling ? '取消中…' : '取消這次提煉' }}</button>
                  <button class="icon-button report-icon-button" type="button" :disabled="reportSynthesisLoading" aria-label="重新整理提煉狀態" title="重新整理提煉狀態" @click="loadReportSynthesis"><span aria-hidden="true">↻</span></button>
                </div>
              </div>
              <p v-if="reportSynthesisError" class="report-synthesis-error" role="alert">{{ reportSynthesisError }}</p>
            </details>

            <section class="report-summary-card">
              <div class="report-summary-copy">
                <div class="eyebrow">PERIOD SUMMARY</div>
                <h3>這段時間發生了什麼</h3>
                <p>{{ formatReadableSummary(report.periodSummary) }}</p>
              </div>
              <div class="report-period-meta">
                <div><span>比較期間</span><strong>{{ report.previousRange.from }} — {{ report.previousRange.to }}</strong></div>
                <div><span>報告範圍</span><strong>{{ report.project?.name ?? '所有記錄中專案' }}</strong></div>
              </div>
            </section>

            <div class="report-comparison-grid">
              <article v-for="item in reportComparisons" :key="item.key" :class="['report-comparison-card', `comparison-${item.comparison.direction}`]">
                <div class="report-comparison-heading"><span>{{ item.label }}</span><span class="comparison-arrow">{{ item.comparison.direction === 'up' ? '↗' : item.comparison.direction === 'down' ? '↘' : '→' }}</span></div>
                <strong>{{ item.comparison.current }}</strong>
                <span class="report-comparison-delta">{{ formatReportDelta(item.comparison) }}</span>
                <small>{{ item.foot }}</small>
              </article>
            </div>

              </section>

              <section id="report-tab-panel-work" class="report-tab-panel" role="tabpanel" aria-labelledby="report-tab-work" v-show="reportTab === 'work'">

            <div class="content-grid report-grid report-primary-grid">
              <section class="panel report-panel report-work-panel">
                <div class="panel-heading">
                  <div>
                    <div class="eyebrow">COMPLETED WORK</div>
                    <h3>主要完成事項</h3>
                  </div>
                  <span class="report-count">{{ report.totals.sessions }} 個 Session</span>
                </div>
                <div v-if="report.completedWork.length === 0" class="empty-state report-empty">
                  <strong>這段期間沒有完成工作</strong>
                  <p>選擇其他區間，或先讓記錄中的專案完成一次 session。</p>
                </div>
                <button v-for="session in report.completedWork" :key="session.id" class="report-completed-row" type="button" @click="openSession(session)">
                  <div class="session-marker"></div>
                  <div class="session-main"><strong>{{ session.title }}</strong><p class="report-summary-preview">{{ formatReadableSummary(session.summary) }}</p><span>{{ session.projectName }} · {{ formatDate(session.completedAt) }}</span></div>
                  <span :class="['verification-badge', `verification-${session.verification?.status ?? 'not_supplied'}`]">{{ verificationLabels[session.verification?.status ?? 'not_supplied'] }}</span>
                  <span class="session-arrow">↗</span>
                </button>
              </section>

              <section class="panel report-panel report-verification-panel">
                <div class="panel-heading">
                  <div>
                    <div class="eyebrow">VERIFICATION STATUS</div>
                    <h3>Verification 狀態</h3>
                  </div>
                  <span class="report-count">{{ report.totals.sessions }} 個 Session</span>
                </div>
                <div class="report-verification-list">
                  <div v-for="item in reportVerification" :key="item.status" class="report-verification-row">
                    <div class="report-progress-label"><span>{{ item.label }}</span><strong>{{ item.count }}</strong></div>
                    <div class="report-progress"><span :class="`verification-fill-${item.status}`" :style="{ width: `${item.percent}%` }"></span></div>
                  </div>
                </div>
                <p class="report-panel-note">待 Agent 回報代表沒有結構化 verification；未執行則代表 Agent 明確表示尚未驗證。報告不會替 Agent 推測驗證結果。</p>
              </section>
            </div>

              </section>

              <section id="report-tab-panel-trend" class="report-tab-panel" role="tabpanel" aria-labelledby="report-tab-trend" v-show="reportTab === 'trend'">

            <div class="content-grid report-grid report-secondary-grid">
              <section class="panel report-panel report-trend-panel">
                <div class="panel-heading">
                  <div>
                    <div class="eyebrow">ACTIVITY TREND</div>
                    <h3>工作節奏</h3>
                  </div>
                  <span class="report-count">{{ report.trends.length }} {{ report.trendGranularity === 'month' ? '個月' : '天' }}</span>
                </div>
                <div class="report-trend-legend"><span><i class="trend-legend-sessions"></i>工作 Session</span><span><i class="trend-legend-events"></i>事件</span></div>
                <div class="report-trend-chart">
                  <div v-for="(point, index) in report.trends" :key="point.date" class="report-trend-column" :title="`${point.date} · ${point.sessions} 個 Session · ${point.events} 個事件`">
                    <div class="report-trend-bars"><span class="trend-bar trend-bar-sessions" :style="{ height: reportTrendHeight(point.sessions, report) }"></span><span class="trend-bar trend-bar-events" :style="{ height: reportTrendHeight(point.events, report) }"></span></div>
                    <small v-if="shouldShowTrendLabel(index, report.trends.length)">{{ formatReportTrendLabel(point.date, report.trendGranularity) }}</small>
                  </div>
                </div>
                <p v-if="report.trends.every((point) => point.sessions === 0)" class="report-panel-note">這段期間尚未有工作活動，趨勢會在新的 Session 完成後出現。</p>
              </section>

              <section class="panel report-panel report-project-panel">
                <div class="panel-heading">
                  <div>
                    <div class="eyebrow">PROJECT BREAKDOWN</div>
                    <h3>專案分布</h3>
                  </div>
                  <span class="report-count">{{ report.projects.length }}</span>
                </div>
                <div v-if="report.projects.length === 0" class="empty-state report-empty"><strong>沒有專案資料</strong><p>這段期間沒有可顯示的 tracked project。</p></div>
                <div v-for="project in report.projects" :key="project.projectId" class="report-project-row">
                  <div class="project-avatar">{{ project.projectName.slice(0, 1).toUpperCase() }}</div>
                  <div class="report-project-info"><strong>{{ project.projectName }}</strong><span>{{ project.sessionCount }} 個 Session · {{ project.eventCount }} 個事件</span></div>
                  <span class="report-source-count">{{ project.sourceSessionIds.length }} 個來源</span>
                </div>
              </section>
            </div>

              </section>

              <section id="report-tab-panel-risks" class="report-tab-panel" role="tabpanel" aria-labelledby="report-tab-risks" v-show="reportTab === 'risks'">

            <div class="report-insights-grid">
              <section class="panel report-panel report-insight-panel">
                <div class="panel-heading">
                  <div>
                    <div class="eyebrow">RISKS TO REVIEW</div>
                    <h3>風險與待確認事項</h3>
                  </div>
                  <span class="report-count">{{ report.risks.length }}</span>
                </div>
                <div v-if="report.risks.length === 0" class="empty-state report-empty"><strong>目前沒有資料型風險</strong><p>目前期間的報告資料沒有偵測到需要提醒的項目。</p></div>
                <button v-for="insight in report.risks" :key="`${insight.kind}-${insight.label}`" class="report-insight-row" type="button" @click="openReportSession(insight.sourceSessionIds[0])">
                  <div class="report-insight-heading"><span class="report-insight-kind">{{ insightKindLabels[insight.kind] }}</span><strong>{{ insight.label }}</strong></div>
                  <p>{{ insight.detail }}</p>
                  <small>{{ insight.sourceSessionIds.length }} 筆來源 Session · 查看第一筆 ↗</small>
                </button>
              </section>

              <section class="panel report-panel report-insight-panel">
                <div class="panel-heading">
                  <div>
                    <div class="eyebrow">DECISIONS &amp; CLOSING</div>
                    <h3>風險／決策</h3>
                  </div>
                  <span class="report-count">{{ report.decisions.length }}</span>
                </div>
                <div v-if="report.decisions.length === 0" class="empty-state report-empty"><strong>這段期間沒有決策事件</strong><p>Agent 提交 note 或 closing event 後，會在這裡保留來源。</p></div>
                <button v-for="decision in report.decisions" :key="`${decision.sessionId}-${decision.occurredAt}`" class="report-decision-row" type="button" @click="openReportSession(decision.sessionId)">
                  <div class="report-decision-copy"><strong>{{ decision.summary }}</strong><span>{{ decision.sessionTitle }} · {{ formatDate(decision.occurredAt) }}</span></div>
                  <span class="session-arrow">↗</span>
                </button>
              </section>
            </div>

              </section>

              <section id="report-tab-panel-raw" class="report-tab-panel" role="tabpanel" aria-labelledby="report-tab-raw" v-show="reportTab === 'raw'">

            <details class="report-raw-details" open>
              <summary><span><span class="eyebrow">RAW WORK RECORDS</span><strong>原始工作紀錄</strong></span><span class="report-count">{{ reportSessionPageInfo.total }} 個 Session</span></summary>
              <div v-if="reportSessionLoading" class="report-raw-loading"><span class="spinner small-spinner"></span><span>正在載入原始 Session…</span></div>
              <div v-else-if="reportSessionItems.length" class="report-raw-session-list">
                <VirtualList :items="reportSessionItems" :enabled="reportSessionPageSize === 'all'" aria-label="報告原始工作紀錄清單">
                  <template #default="{ item: session }">
                    <button class="report-raw-session-row" type="button" @click="openSession(session)">
                      <span class="session-marker"></span><span class="report-raw-session-copy"><strong>{{ session.title }}</strong><span>{{ session.projectName }} · {{ formatDate(session.completedAt) }}</span><small>{{ formatReadableSummary(session.summary) }}</small></span><span :class="['verification-badge', `verification-${session.verification?.status ?? 'not_supplied'}`]">{{ verificationLabel(session.verification?.status) }}</span><span class="session-arrow">↗</span>
                    </button>
                  </template>
                </VirtualList>
              </div>
              <div v-else class="report-empty report-empty-compact"><strong>這段期間沒有原始 Session</strong><p>請切換報告期間或專案範圍。</p></div>
              <div v-if="reportSessionPageInfo.total > 0" class="pagination-bar report-list-pagination-bar">
                <span class="pagination-summary">顯示 {{ reportSessionPageInfo.from }}–{{ reportSessionPageInfo.to }}，共 {{ reportSessionPageInfo.total }} 筆<span v-if="reportSessionPageInfo.truncated" class="pagination-truncated"> · All 已限制每頁 {{ reportSessionPageInfo.pageSize }} 筆</span></span>
                <label class="pagination-page-size"><span>每頁</span><select v-model="reportSessionPageSize" aria-label="報告原始工作紀錄每頁筆數" @change="changeReportSessionPageSize"><option v-for="option in listPageSizeOptions" :key="String(option.value)" :value="option.value">{{ option.label }}</option></select></label>
                <div v-if="reportSessionPageInfo.totalPages > 1" class="pagination-controls"><button class="pagination-button" type="button" :disabled="!reportSessionPageInfo.hasPrevious" @click="changeReportSessionPage(reportSessionPageInfo.page - 1)">上一頁</button><span>第 {{ reportSessionPageInfo.page }} / {{ reportSessionPageInfo.totalPages }} 頁</span><button class="pagination-button" type="button" :disabled="!reportSessionPageInfo.hasNext" @click="changeReportSessionPage(reportSessionPageInfo.page + 1)">下一頁</button></div>
                <span v-else class="pagination-current">共 {{ reportSessionPageInfo.total }} 筆</span>
              </div>
            </details>

              </section>

              <section id="report-tab-panel-evidence" class="report-tab-panel" role="tabpanel" aria-labelledby="report-tab-evidence" v-show="reportTab === 'evidence'">

            <section class="panel report-panel report-evidence-panel">
              <div class="panel-heading">
                <div>
                  <div class="eyebrow">SOURCE EVIDENCE</div>
                  <h3>來源證據</h3>
                </div>
                <span class="report-count">{{ report.evidencePageInfo.total }} 筆</span>
              </div>
              <form class="report-evidence-tools" @submit.prevent="loadReportEvidence(true)">
                <label class="report-evidence-search"><span>⌕</span><input v-model="reportEvidenceQuery" type="search" placeholder="搜尋 Session、來源或證據內容" /></label>
                <label class="report-evidence-kind"><span>類型</span><select v-model="reportEvidenceKind" aria-label="依 Evidence 類型篩選" @change="loadReportEvidence(true)"><option value="">所有類型</option><option v-for="(label, kind) in evidenceKindLabels" :key="kind" :value="kind">{{ label }}</option></select></label>
                <button class="text-button report-evidence-filter-button" type="submit" :disabled="reportEvidenceLoading">{{ reportEvidenceLoading ? '更新中…' : '套用篩選' }}</button>
              </form>
              <div v-if="reportEvidenceLoading" class="report-evidence-inline-loading"><span class="spinner small-spinner"></span><span>正在更新來源證據…</span></div>
              <div v-else-if="report.evidence.length === 0" class="empty-state report-empty"><strong>尚無可呈現的證據</strong><p>完成 session 時提供 handoff、verification、changed files 或 event，報告就能建立追溯線索。</p></div>
              <div v-else :class="['report-evidence-list', { 'report-evidence-list-virtualized': reportEvidencePageSize === 'all' }]">
                <VirtualList v-if="reportEvidencePageSize === 'all'" :items="report.evidence" :enabled="true" aria-label="報告來源證據清單" :estimate-item-height="94">
                  <template #default="{ item }">
                    <button class="report-evidence-row" type="button" @click="openReportEvidence(item)">
                      <span :class="['report-evidence-icon', `evidence-${item.kind}`]">{{ item.kind === 'handoff' ? 'H' : item.kind === 'verification' ? 'V' : item.kind === 'changed-files' ? 'F' : item.kind === 'attached' ? 'A' : 'E' }}</span>
                      <div class="report-evidence-copy"><div><span class="report-evidence-kind">{{ evidenceKindLabel(item.kind) }}</span><strong>{{ item.label }}</strong></div><p>{{ item.detail }}</p><small>{{ item.sessionTitle }}<span v-if="item.projectName"> · {{ item.projectName }}</span><span v-if="item.reference"> · {{ item.reference }}</span></small></div>
                      <span class="session-arrow">↗</span>
                    </button>
                  </template>
                </VirtualList>
                <template v-else>
                  <button v-for="item in report.evidence" :key="`${item.sessionId}-${item.kind}-${item.label}`" class="report-evidence-row" type="button" @click="openReportEvidence(item)">
                    <span :class="['report-evidence-icon', `evidence-${item.kind}`]">{{ item.kind === 'handoff' ? 'H' : item.kind === 'verification' ? 'V' : item.kind === 'changed-files' ? 'F' : item.kind === 'attached' ? 'A' : 'E' }}</span>
                    <div class="report-evidence-copy"><div><span class="report-evidence-kind">{{ evidenceKindLabels[item.kind] }}</span><strong>{{ item.label }}</strong></div><p>{{ item.detail }}</p><small>{{ item.sessionTitle }}<span v-if="item.projectName"> · {{ item.projectName }}</span><span v-if="item.reference"> · {{ item.reference }}</span></small></div>
                    <span class="session-arrow">↗</span>
                  </button>
                </template>
              </div>
              <div v-if="report.evidencePageInfo.total > 0" class="pagination-bar report-list-pagination-bar">
                <span class="pagination-summary">顯示 {{ report.evidencePageInfo.from }}–{{ report.evidencePageInfo.to }}，共 {{ report.evidencePageInfo.total }} 筆<span v-if="report.evidencePageInfo.truncated" class="pagination-truncated"> · All 已限制每頁 {{ report.evidencePageInfo.pageSize }} 筆</span></span>
                <label class="pagination-page-size"><span>每頁</span><select v-model="reportEvidencePageSize" aria-label="報告來源證據每頁筆數" @change="changeReportEvidencePageSize"><option v-for="option in listPageSizeOptions" :key="String(option.value)" :value="option.value">{{ option.label }}</option></select></label>
                <div v-if="report.evidencePageInfo.totalPages > 1" class="pagination-controls">
                  <button class="pagination-button" type="button" :disabled="!report.evidencePageInfo.hasPrevious" @click="changeReportEvidencePage(report.evidencePageInfo.page - 1)">上一頁</button>
                  <span>第 {{ report.evidencePageInfo.page }} / {{ report.evidencePageInfo.totalPages }} 頁</span>
                  <button class="pagination-button" type="button" :disabled="!report.evidencePageInfo.hasNext" @click="changeReportEvidencePage(report.evidencePageInfo.page + 1)">下一頁</button>
                </div>
                <span v-else class="pagination-current">共 {{ report.evidencePageInfo.total }} 筆</span>
              </div>
            </section>
              </section>
            </div>
          </template>
          <div v-else class="empty-state large-empty report-empty-state"><div class="empty-icon">▥</div><strong>尚未產生報告</strong><p>切換到報表後，系統會從已授權的工作紀錄建立摘要。</p></div>
        </ReportsView>

        <KnowledgeView v-else-if="activeView === 'knowledge'">
          <div class="section-intro knowledge-intro">
            <div>
              <div class="eyebrow">EXPLICIT KNOWLEDGE</div>
              <h2>把已確認的經驗，留給下一次工作。</h2>
              <p>Knowledge 只接受 Agent 明確提交的內容，不會自行讀取 source 或用猜測取代證據。</p>
            </div>
            <div class="tracked-summary"><strong>{{ knowledgePageInfo.total }}</strong><span>筆目前可用知識</span></div>
          </div>

          <form class="knowledge-tools" @submit.prevent="loadKnowledge(true)">
            <label class="search-box knowledge-search-box">
              <span>⌕</span>
              <input v-model="knowledgeQuery" type="search" placeholder="搜尋標題、內容、標籤或參考" />
            </label>
            <label class="filter-field">
              <span>專案</span>
              <select v-model="knowledgeProjectId" aria-label="依專案篩選 Knowledge">
                <option value="">所有記錄中專案</option>
                <option v-for="project in knowledgeProjects" :key="project.id" :value="project.id">{{ project.name }}</option>
              </select>
            </label>
            <label class="filter-field">
              <span>類型</span>
              <select v-model="knowledgeKind" aria-label="依類型篩選 Knowledge">
                <option value="">所有類型</option>
                <option v-for="(label, kind) in knowledgeKindLabels" :key="kind" :value="kind">{{ label }}</option>
              </select>
            </label>
            <label class="filter-field">
              <span>狀態</span>
              <select v-model="knowledgeStatus" aria-label="依狀態篩選 Knowledge">
                <option v-for="(label, status) in knowledgeStatusLabels" :key="status" :value="status">{{ label }}</option>
              </select>
            </label>
            <button class="filter-button" type="submit" :disabled="knowledgeLoading">{{ knowledgeLoading ? '整理中…' : '套用篩選' }}</button>
          </form>

          <div v-if="knowledgeError" class="alert error-alert" role="alert">{{ knowledgeError }}</div>
          <section v-if="knowledgeLoading" class="loading-state knowledge-loading">
            <div class="spinner"></div>
            <p>正在載入已確認的工作知識…</p>
          </section>
          <section v-else class="panel knowledge-panel">
            <div class="list-heading knowledge-heading"><span>{{ knowledgePageInfo.total }} 筆{{ knowledgeStatus === 'active' ? '目前使用中' : '已封存' }} Knowledge</span><span>維護</span></div>
            <VirtualList :items="knowledgeItems" :enabled="knowledgePageSize === 'all'" aria-label="工作知識清單">
              <template #default="{ item }">
                <article class="knowledge-row">
                  <div :class="['knowledge-kind-mark', `knowledge-kind-${item.kind}`]">{{ item.kind.slice(0, 1).toUpperCase() }}</div>
                  <div class="knowledge-body">
                    <div class="knowledge-title"><strong>{{ item.title }}</strong><span class="knowledge-kind-label">{{ knowledgeKindLabel(item.kind) }}</span><span :class="['knowledge-status-label', `knowledge-status-${item.status}`]">{{ knowledgeStatusLabel(item.status) }}</span></div>
                    <p>{{ item.body }}</p>
                    <div class="knowledge-meta">
                      <span v-if="item.projectName">{{ item.projectName }}</span>
                      <span v-for="tag in item.tags" :key="`${item.id}-${tag}`" class="knowledge-tag">#{{ tag }}</span>
                      <button v-if="item.sessionId" class="text-button knowledge-source-button" type="button" @click="openKnowledgeSession(item)">查看來源 Session ↗</button>
                    </div>
                    <div v-if="item.references.length" class="knowledge-references"><code v-for="reference in item.references" :key="`${item.id}-${reference}`">{{ reference }}</code></div>
                  </div>
                  <div class="knowledge-row-actions">
                    <time>{{ formatDate(item.updatedAt) }}</time>
                    <button class="text-button" type="button" @click="openKnowledgeHistory(item)">變更紀錄</button>
                    <button class="text-button" type="button" @click="openKnowledgeEditor(item)">編輯</button>
                    <button class="text-button knowledge-archive-button" type="button" @click="setKnowledgeStatus(item, item.status === 'active' ? 'archived' : 'active')">{{ item.status === 'active' ? '封存' : '恢復' }}</button>
                  </div>
                </article>
              </template>
            </VirtualList>
            <div v-if="knowledgeItems.length === 0" class="empty-state large-empty"><div class="empty-icon">✦</div><strong>{{ knowledgeStatus === 'active' ? '還沒有已確認的 Knowledge' : '沒有已封存的 Knowledge' }}</strong><p>{{ knowledgeStatus === 'active' ? 'Agent 使用 work_record_knowledge 提交 decision、pattern、gotcha、procedure 或 skill 後，內容會出現在這裡。' : '封存只會停止它出現在預設搜尋與 Graph 中，不會刪除原始記錄。' }}</p></div>
            <div class="pagination-bar list-pagination-bar">
              <span class="pagination-summary">顯示 {{ knowledgePageInfo.from }}–{{ knowledgePageInfo.to }}，共 {{ knowledgePageInfo.total }} 筆<span v-if="knowledgePageInfo.truncated" class="pagination-truncated"> · All 已限制每頁 {{ knowledgePageInfo.pageSize }} 筆</span></span>
              <label class="pagination-page-size"><span>每頁</span><select v-model="knowledgePageSize" aria-label="Knowledge 每頁筆數" @change="changeKnowledgePageSize"><option v-for="option in listPageSizeOptions" :key="String(option.value)" :value="option.value">{{ option.label }}</option></select></label>
              <div v-if="knowledgePageInfo.totalPages > 1" class="pagination-controls">
                <button class="pagination-button" type="button" :disabled="!knowledgePageInfo.hasPrevious" @click="changeKnowledgePage(knowledgePageInfo.page - 1)">上一頁</button>
                <span>第 {{ knowledgePageInfo.page }} / {{ knowledgePageInfo.totalPages }} 頁</span>
                <button class="pagination-button" type="button" :disabled="!knowledgePageInfo.hasNext" @click="changeKnowledgePage(knowledgePageInfo.page + 1)">下一頁</button>
              </div>
              <span v-else class="pagination-current">共 {{ knowledgePageInfo.total }} 筆</span>
            </div>
          </section>
        </KnowledgeView>

        <GraphView v-else-if="activeView === 'graph'">
          <div class="section-intro graph-intro">
            <div>
              <div class="eyebrow">DETERMINISTIC WORK GRAPH</div>
              <h2>把 Session、檔案、知識與證據連起來。</h2>
              <p>圖譜只使用已保存的結構化資料；不讀取 source、handoff 或 Git，也不替資料推測語意關係。</p>
            </div>
            <div class="tracked-summary"><strong>{{ graph?.totalNodes ?? 0 }}</strong><span>個圖譜節點</span></div>
          </div>

          <form class="graph-tools" @submit.prevent="loadGraph">
            <label class="filter-field">
              <span>專案範圍</span>
              <select v-model="graphProjectId" aria-label="選擇 Graph 專案範圍">
                <option value="">所有記錄中專案</option>
                <option v-for="project in trackedProjects" :key="project.id" :value="project.id">{{ project.name }}</option>
              </select>
            </label>
            <label class="filter-field">
              <span>節點類型</span>
              <select v-model="graphNodeFilter" aria-label="選擇 Graph 節點類型">
                <option value="all">全部類型</option>
                <option v-for="kind in graphNodeKindOrder" :key="kind" :value="kind">{{ graphNodeKindLabels[kind] }}</option>
              </select>
            </label>
            <label class="filter-field">
              <span>畫面預覽量</span>
              <select v-model.number="graphPreviewLimit" aria-label="選擇 Graph 畫面預覽量">
                <option :value="60">精簡（最多 60）</option>
                <option :value="120">標準（最多 120）</option>
                <option :value="180">展開（最多 180）</option>
              </select>
            </label>
            <label class="filter-field">
              <span>資料載入上限</span>
              <select v-model="graphLoadPreset" aria-label="選擇 Graph 資料載入上限">
                <option v-for="preset in graphLoadPresetOptions" :key="preset.value" :value="preset.value">{{ preset.label }}</option>
              </select>
            </label>
            <span class="graph-policy-note">只顯示「記錄中」專案；類型與預覽量可立即切換</span>
            <button class="filter-button" type="submit" :disabled="graphLoading">{{ graphLoading ? '整理中…' : '更新圖譜' }}</button>
            <button v-if="graphCanLoadMore" class="text-button graph-load-more-button" type="button" :disabled="graphLoading" @click="loadMoreGraph">載入更多資料</button>
          </form>

          <div v-if="graphError" class="alert error-alert" role="alert">{{ graphError }}</div>
          <section v-if="graphLoading" class="loading-state graph-loading">
            <div class="spinner"></div>
            <p>正在整理本機工作圖譜…</p>
          </section>
          <template v-else-if="graph">
            <div class="graph-stat-grid">
              <article class="graph-stat-card graph-stat-total"><span>節點總數</span><strong>{{ graph.totalNodes }}</strong><small>完整範圍總數</small></article>
              <article class="graph-stat-card graph-stat-total"><span>關係總數</span><strong>{{ graph.totalEdges }}</strong><small>完整範圍總數</small></article>
              <article v-for="item in graphNodeCounts" :key="item.kind" class="graph-stat-card"><span>{{ item.label }}</span><strong>{{ item.count }}</strong><small>圖譜節點</small></article>
            </div>

            <section class="panel graph-visual-panel">
              <div class="panel-heading">
                <div>
                  <div class="eyebrow">RELATIONSHIP MAP</div>
                  <h3>工作關係圖</h3>
                </div>
                <span class="report-count">顯示 {{ graphVisual.nodes.length }} / {{ graphFilteredTotalNodes }} 節點</span>
              </div>
              <div v-if="graph.nodes.length === 0" class="empty-state graph-empty"><div class="empty-icon">◎</div><strong>目前沒有可視化資料</strong><p>tracked project 完成 Session 後，這裡會出現工作關係。</p></div>
              <div v-else class="graph-viewport" role="img" aria-label="Work Intelligence 結構化工作關係圖">
                <div class="graph-lane-header" aria-hidden="true">
                  <span v-for="kind in graphNodeKindOrder" :key="kind">{{ graphNodeKindLabels[kind] }}</span>
                </div>
                <svg class="graph-svg" :viewBox="`0 0 ${graphVisual.width} ${graphVisual.height}`" preserveAspectRatio="xMinYMin meet">
                  <defs>
                    <marker id="graph-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="strokeWidth">
                      <path d="M0,0 L7,3.5 L0,7 z" fill="#6d92b3"></path>
                    </marker>
                    <clipPath
                      v-for="item in graphVisual.nodes"
                      :id="graphNodeClipId(item.node.id)"
                      :key="graphNodeClipId(item.node.id)"
                      clipPathUnits="userSpaceOnUse"
                    >
                      <rect x="-80" y="-17" width="160" height="34" rx="3"></rect>
                    </clipPath>
                  </defs>
                  <line v-for="item in graphVisual.edges" :key="item.edge.id" class="graph-edge" :x1="item.from.x + 92" :y1="item.from.y" :x2="item.to.x - 92" :y2="item.to.y" marker-end="url(#graph-arrow)">
                    <title>{{ graphEdgeKindLabels[item.edge.kind] }}</title>
                  </line>
                  <g
                    v-for="item in graphVisual.nodes"
                    :key="item.node.id"
                    :class="['graph-svg-node', `graph-svg-node-${item.node.kind}`, { clickable: true }]"
                    :transform="`translate(${item.x}, ${item.y})`"
                    role="button"
                    tabindex="0"
                    :aria-label="`查看${graphNodeKindLabels[item.node.kind]}：${item.node.label}`"
                    @click="openGraphNode(item.node)"
                    @keydown.enter="openGraphNode(item.node)"
                    @keydown.space.prevent="openGraphNode(item.node)"
                  >
                    <title>{{ item.node.label }} · {{ graphNodeKindLabels[item.node.kind] }}</title>
                    <rect x="-92" y="-20" width="184" height="40" rx="10"></rect>
                    <text class="graph-node-label" x="-78" y="-3" :clip-path="`url(#${graphNodeClipId(item.node.id)})`">{{ graphNodeLabel(item.node.label) }}</text>
                    <text class="graph-node-meta" x="-78" y="12" :clip-path="`url(#${graphNodeClipId(item.node.id)})`">{{ graphNodeDescription(item.node) }}</text>
                  </g>
                </svg>
              </div>
              <p class="graph-panel-note">目前顯示 {{ graphVisual.nodes.length }} / {{ graphFilteredTotalNodes }} 個{{ graphNodeFilterLabel() }}、{{ graphVisual.edges.length }} / {{ graph.totalEdges }} 條關係。{{ graph.truncation.nodesTruncated || graph.truncation.edgesTruncated ? '資料已依載入上限受控；可提高「資料載入上限」或按「載入更多資料」。' : '目前範圍的資料已完整載入。' }}<span v-if="graphVisual.hiddenNodes"> 畫面另省略 {{ graphVisual.hiddenNodes }} 個節點。</span><span v-if="graphVisual.hiddenEdges"> 另有 {{ graphVisual.hiddenEdges }} 條關係因端點被省略而未繪出。</span></p>
            </section>

            <div class="content-grid graph-secondary-grid">
              <section class="panel graph-breakdown-panel">
                <div class="panel-heading">
                  <div>
                    <div class="eyebrow">NODE BREAKDOWN</div>
                    <h3>節點分布</h3>
                  </div>
                  <span class="report-count">{{ graph.projects.length }} 個專案</span>
                </div>
                <div class="graph-breakdown-list">
                  <div v-for="item in graphNodeCounts" :key="item.kind" class="graph-breakdown-row">
                    <span :class="['graph-kind-dot', `graph-kind-${item.kind}`]"></span>
                    <strong>{{ item.label }}</strong>
                    <span>{{ item.count }} 個節點</span>
                  </div>
                </div>
                <p class="graph-panel-note">來源 Projects：{{ graph.sourceProjectIds.length }} · 來源 Sessions：{{ graph.sourceSessionIds.length }}</p>
              </section>

              <section class="panel graph-breakdown-panel">
                <div class="panel-heading">
                  <div>
                    <div class="eyebrow">EDGE LEGEND</div>
                    <h3>關係類型</h3>
                  </div>
                  <span class="report-count">{{ graph.edges.length }} 條關係</span>
                </div>
                <div class="graph-breakdown-list">
                  <div v-for="item in graphEdgeCounts" :key="item.kind" class="graph-breakdown-row">
                    <span class="graph-edge-mark">→</span>
                    <strong>{{ item.label }}</strong>
                    <span>{{ item.count }} 條關係</span>
                  </div>
                </div>
                <p class="graph-panel-note">目前關係皆可回溯到 Project Registry、Session、Knowledge、Evidence 或 changed-files metadata。</p>
              </section>
            </div>
      </template>
      <div v-else class="empty-state large-empty graph-empty-state"><div class="empty-icon">◎</div><strong>尚未載入工作圖譜</strong><p>切換到 Graph 後，系統會從已授權的工作紀錄建立結構化視圖。</p></div>
        </GraphView>

        <WorklogView v-else>
          <div class="section-intro worklog-intro">
            <div>
              <div class="eyebrow">SESSION ARCHIVE</div>
              <h2>每一次完成，都留下可追溯的脈絡。</h2>
            </div>
            <form class="worklog-tools" @submit.prevent="loadSessions(true)">
              <label class="search-box">
                <span>⌕</span>
                <input v-model="searchTerm" type="search" placeholder="搜尋 title、summary 或 event" />
              </label>
              <div class="filter-row">
                <label class="filter-field">
                  <span>專案</span>
                  <select v-model="selectedProjectId" aria-label="依專案篩選">
                    <option value="">所有專案</option>
                    <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option>
                  </select>
                </label>
                <div class="filter-field date-filter-field">
                  <span>從日期</span>
                  <button
                    ref="dateFromTrigger"
                    class="date-picker-trigger"
                    type="button"
                    :aria-expanded="activeDatePicker === 'from'"
                    aria-haspopup="dialog"
                    aria-label="選擇開始日期"
                    @click="toggleDatePicker('from')"
                  >
                    <span class="calendar-glyph" aria-hidden="true">▦</span>
                    <span :class="['date-picker-value', { placeholder: !dateFrom }]">{{ displayDate(dateFrom) }}</span>
                    <span class="date-picker-chevron" aria-hidden="true">⌄</span>
                  </button>
                  <Teleport to="body">
                    <div v-if="activeDatePicker === 'from'" class="date-picker-popover" :style="datePickerStyle" role="dialog" aria-label="選擇開始日期" @click.stop>
                    <div class="date-picker-toolbar">
                      <button type="button" aria-label="上一個月" @click="shiftPickerMonth(-1)">‹</button>
                      <strong>{{ pickerMonthLabel }}</strong>
                      <button type="button" aria-label="下一個月" @click="shiftPickerMonth(1)">›</button>
                    </div>
                    <div class="calendar-weekdays" aria-hidden="true"><span v-for="weekday in ['日', '一', '二', '三', '四', '五', '六']" :key="weekday">{{ weekday }}</span></div>
                    <div class="calendar-grid">
                      <button
                        v-for="day in calendarDays"
                        :key="day.value"
                        :class="['calendar-day', { muted: !day.inCurrentMonth, today: day.isToday, selected: day.isSelected }]"
                        type="button"
                        :aria-label="`${day.value}`"
                        @click="selectCalendarDate(day.value)"
                      >{{ day.label }}</button>
                    </div>
                    <div class="date-picker-footer">
                      <button type="button" class="date-today-button" @click="selectCalendarDate(toDateInputValue(new Date()))">今天</button>
                      <button type="button" class="date-clear-button" @click="clearCalendarDate">清除</button>
                    </div>
                    </div>
                  </Teleport>
                </div>
                <div class="filter-field date-filter-field">
                  <span>至日期</span>
                  <button
                    ref="dateToTrigger"
                    class="date-picker-trigger"
                    type="button"
                    :aria-expanded="activeDatePicker === 'to'"
                    aria-haspopup="dialog"
                    aria-label="選擇結束日期"
                    @click="toggleDatePicker('to')"
                  >
                    <span class="calendar-glyph" aria-hidden="true">▦</span>
                    <span :class="['date-picker-value', { placeholder: !dateTo }]">{{ displayDate(dateTo) }}</span>
                    <span class="date-picker-chevron" aria-hidden="true">⌄</span>
                  </button>
                  <Teleport to="body">
                    <div v-if="activeDatePicker === 'to'" class="date-picker-popover" :style="datePickerStyle" role="dialog" aria-label="選擇結束日期" @click.stop>
                    <div class="date-picker-toolbar">
                      <button type="button" aria-label="上一個月" @click="shiftPickerMonth(-1)">‹</button>
                      <strong>{{ pickerMonthLabel }}</strong>
                      <button type="button" aria-label="下一個月" @click="shiftPickerMonth(1)">›</button>
                    </div>
                    <div class="calendar-weekdays" aria-hidden="true"><span v-for="weekday in ['日', '一', '二', '三', '四', '五', '六']" :key="weekday">{{ weekday }}</span></div>
                    <div class="calendar-grid">
                      <button
                        v-for="day in calendarDays"
                        :key="day.value"
                        :class="['calendar-day', { muted: !day.inCurrentMonth, today: day.isToday, selected: day.isSelected }]"
                        type="button"
                        :aria-label="`${day.value}`"
                        @click="selectCalendarDate(day.value)"
                      >{{ day.label }}</button>
                    </div>
                    <div class="date-picker-footer">
                      <button type="button" class="date-today-button" @click="selectCalendarDate(toDateInputValue(new Date()))">今天</button>
                      <button type="button" class="date-clear-button" @click="clearCalendarDate">清除</button>
                    </div>
                    </div>
                  </Teleport>
                </div>
                <button class="filter-button" type="submit">套用篩選</button>
                <button class="filter-clear" type="button" :disabled="!hasSessionFilters" @click="clearSessionFilters">清除</button>
              </div>
              <p v-if="sessionFilterError" class="filter-error" role="alert">{{ sessionFilterError }}</p>
            </form>
          </div>

          <section class="panel worklog-panel">
            <div class="list-heading worklog-heading"><span>{{ sessionPageInfo.total }} 個工作 Session<span v-if="hasSessionFilters" class="filter-applied">已套用篩選</span></span><span>完成時間</span></div>
            <VirtualList :items="sessions" :enabled="sessionPageSize === 'all'" aria-label="工作歷程清單">
              <template #default="{ item: session }">
                <button class="worklog-row" type="button" @click="openSession(session)">
                  <div class="timeline-dot"></div>
                  <div class="worklog-body">
                    <div class="worklog-title"><strong>{{ session.title }}</strong><span class="finalized-label">已完成</span><span :class="['verification-badge', 'worklog-verification', `verification-${session.verification?.status ?? 'not_supplied'}`]">{{ verificationLabel(session.verification?.status) }}</span></div>
                    <p>{{ formatReadableSummary(session.summary) }}</p>
                    <div class="worklog-meta"><span>{{ session.projectName }}</span><span v-if="session.gitBranch">分支：{{ session.gitBranch }}</span><span>{{ session.changedFiles.length }} 個檔案</span></div>
                  </div>
                  <time>{{ formatDate(session.completedAt) }}</time>
                  <span class="session-arrow">↗</span>
                </button>
              </template>
            </VirtualList>
            <div v-if="sessions.length === 0" class="empty-state large-empty"><div class="empty-icon">≡</div><strong>找不到工作紀錄</strong><p>完成的 session 會在這裡依時間排列。</p></div>
            <div class="pagination-bar list-pagination-bar">
              <span class="pagination-summary">顯示 {{ sessionPageInfo.from }}–{{ sessionPageInfo.to }}，共 {{ sessionPageInfo.total }} 筆<span v-if="sessionPageInfo.truncated" class="pagination-truncated"> · All 已限制每頁 {{ sessionPageInfo.pageSize }} 筆</span></span>
              <label class="pagination-page-size"><span>每頁</span><select v-model="sessionPageSize" aria-label="工作歷程每頁筆數" @change="changeSessionPageSize"><option v-for="option in listPageSizeOptions" :key="String(option.value)" :value="option.value">{{ option.label }}</option></select></label>
              <div v-if="sessionPageInfo.totalPages > 1" class="pagination-controls">
                <button class="pagination-button" type="button" :disabled="!sessionPageInfo.hasPrevious" @click="changeSessionPage(sessionPageInfo.page - 1)">上一頁</button>
                <span>第 {{ sessionPageInfo.page }} / {{ sessionPageInfo.totalPages }} 頁</span>
                <button class="pagination-button" type="button" :disabled="!sessionPageInfo.hasNext" @click="changeSessionPage(sessionPageInfo.page + 1)">下一頁</button>
              </div>
              <span v-else class="pagination-current">共 {{ sessionPageInfo.total }} 筆</span>
            </div>
          </section>
        </WorklogView>
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
