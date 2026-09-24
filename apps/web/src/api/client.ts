import type {
  DatabaseBackupCreated,
  DatabaseBackupList,
  FolderPickResult,
  DashboardSummary,
  CancelMetadataBackfillRequestResult,
  CancelReportSynthesisRequestResult,
  CreateMetadataBackfillRequestResult,
  CreateReportSynthesisRequestResult,
  DeleteReportSummaryResult,
  GraphQuery,
  GraphQueryResult,
  HandoffImportApplyInput,
  HandoffImportBatchResult,
  HandoffImportPreviewResult,
  KnowledgeHistoryResult,
  KnowledgeQuery,
  KnowledgeSearchResult,
  DecideKnowledgeCandidateInput,
  DecideKnowledgeCandidateResult,
  KnowledgeCandidateListResult,
  RequestKnowledgeCandidatesResult,
  LinkSessionsResult,
  SessionLinkRelation,
  MetadataBackfillPreviewResult,
  MetadataBackfillRequestListQueryResult,
  PageInfo,
  ProjectRecord,
  ProjectStatus,
  ReportPeriod,
  ReportExportFormat,
  ReportExportResult,
  ReportQueryResult,
  ReportSynthesisScopeType,
  ReportSummaryQueryResult,
  ReportSynthesisRequestListQueryResult,
  RetryReportSynthesisRequestResult,
  SessionDetail,
  SessionListResult,
  SessionVoidedFilter,
  SetEvidenceVoidInput,
  SetEvidenceVoidResult,
  SetSessionVoidInput,
  SetSessionVoidResult,
  UpdateKnowledgeInput,
  UpdateKnowledgeResult,
  UpdateSessionSummaryInput,
  UpdateSessionVerificationResult,
  VerificationSummary,
  UpdateSessionSummaryResult,
  UpdateSessionWorkSummaryInput,
  UpdateSessionWorkSummaryResult,
} from "@work-intelligence/core";

type ApiErrorPayload = { error?: string };

export type SessionListRequest = {
  q?: string;
  projectId?: string;
  voided?: SessionVoidedFilter;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number | "all";
};

export type ReportRequest = {
  period: ReportPeriod;
  date?: string;
  /** An explicit calendar range; the server then ignores period and date. */
  from?: string;
  to?: string;
  projectId?: string;
  evidencePage?: number;
  evidencePageSize?: number | "all";
  evidenceKind?: string;
  evidenceQuery?: string;
};

type KnowledgeRequest = Omit<KnowledgeQuery, "pageSize"> & { pageSize?: number | "all" };

function appendQuery(path: string, values: Record<string, boolean | string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") {
      query.set(key, String(value));
    }
  }
  const encoded = query.toString();
  return encoded ? `${path}?${encoded}` : path;
}

export class ApiClient {
  public constructor(private readonly baseUrl = "") {}

  /** Opens the data-free change stream used to refresh views from the normal REST API. */
  public openChangeStream(onChanged: () => void, onReconnected?: () => void): EventSource {
    const source = new EventSource(`${this.baseUrl.replace(/\/$/, "")}/api/events`);
    source.addEventListener("changed", onChanged);
    if (onReconnected) {
      source.addEventListener("open", onReconnected);
    }
    return source;
  }

  public async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const payload = (await response.json()) as T & ApiErrorPayload;
    if (!response.ok) {
      throw new Error(payload.error ?? "請求失敗，請確認 API 是否已啟動。");
    }
    return payload;
  }

  private write<T>(path: string, method: "DELETE" | "PATCH" | "POST", body: unknown, signal?: AbortSignal): Promise<T> {
    return this.request<T>(path, { method, body: JSON.stringify(body), signal });
  }

  /** Opens the native folder dialog on this computer (through the local API server). */
  public pickFolder(): Promise<FolderPickResult> {
    return this.write<FolderPickResult>("/api/system/pick-folder", "POST", {});
  }

  public listBackups(signal?: AbortSignal): Promise<DatabaseBackupList> {
    return this.request<DatabaseBackupList>("/api/backups", { signal });
  }

  public createBackup(): Promise<DatabaseBackupCreated> {
    return this.write<DatabaseBackupCreated>("/api/backups", "POST", {});
  }

  /** Downloads a fresh snapshot of the whole database; the JSON body keeps cross-site forms from triggering it. */
  public async exportDatabase(): Promise<{ blob: Blob; fileName: string }> {
    const response = await fetch(`${this.baseUrl}/api/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!response.ok) {
      throw new Error("無法匯出資料，請確認 API 是否已啟動。");
    }
    // Content-Disposition is not exposed cross-origin, so the name is made here from the local date.
    const fileName = `work-intelligence-export-${new Date().toLocaleDateString("sv-SE").replace(/-/g, "")}.sqlite`;
    return { blob: await response.blob(), fileName };
  }

  public getDashboard(signal?: AbortSignal): Promise<DashboardSummary> {
    return this.request<DashboardSummary>("/api/dashboard", { signal });
  }

  public listProjects(signal?: AbortSignal): Promise<ProjectRecord[]> {
    return this.request<ProjectRecord[]>("/api/projects", { signal });
  }

  public listSessions(options: SessionListRequest = {}, signal?: AbortSignal): Promise<SessionListResult> {
    return this.request<SessionListResult>(
      appendQuery("/api/sessions", {
        q: options.q,
        projectId: options.projectId,
        voided: options.voided === "exclude" ? undefined : options.voided,
        from: options.from,
        to: options.to,
        page: options.page,
        pageSize: options.pageSize === "all" ? 0 : options.pageSize,
      }),
      { signal },
    );
  }

  public getSessionDetail(sessionId: string, signal?: AbortSignal): Promise<SessionDetail> {
    return this.request<SessionDetail>(`/api/sessions/${encodeURIComponent(sessionId)}`, { signal });
  }

  public updateSessionVerification(
    sessionId: string,
    verification: VerificationSummary,
    signal?: AbortSignal,
  ): Promise<UpdateSessionVerificationResult> {
    return this.write<UpdateSessionVerificationResult>(
      `/api/sessions/${encodeURIComponent(sessionId)}/verification`,
      "PATCH",
      verification,
      signal,
    );
  }

  public listKnowledgeCandidates(projectRoot?: string, signal?: AbortSignal): Promise<KnowledgeCandidateListResult> {
    return this.request<KnowledgeCandidateListResult>(appendQuery("/api/knowledge/candidates", { projectRoot }), {
      signal,
    });
  }

  public requestKnowledgeCandidates(
    projectRoot: string,
    signal?: AbortSignal,
  ): Promise<RequestKnowledgeCandidatesResult> {
    return this.write<RequestKnowledgeCandidatesResult>(
      "/api/knowledge/candidate-requests",
      "POST",
      { projectRoot },
      signal,
    );
  }

  public decideKnowledgeCandidate(
    input: DecideKnowledgeCandidateInput,
    signal?: AbortSignal,
  ): Promise<DecideKnowledgeCandidateResult> {
    const { candidateId, ...body } = input;
    return this.write<DecideKnowledgeCandidateResult>(
      `/api/knowledge/candidates/${encodeURIComponent(candidateId)}/decision`,
      "POST",
      body,
      signal,
    );
  }

  public linkSession(
    sessionId: string,
    relatedSessionId: string,
    relation: SessionLinkRelation,
    signal?: AbortSignal,
  ): Promise<LinkSessionsResult> {
    return this.write<LinkSessionsResult>(
      `/api/sessions/${encodeURIComponent(sessionId)}/links`,
      "POST",
      { relatedSessionId, relation },
      signal,
    );
  }

  public unlinkSession(sessionId: string, relatedSessionId: string, signal?: AbortSignal): Promise<LinkSessionsResult> {
    return this.write<LinkSessionsResult>(
      `/api/sessions/${encodeURIComponent(sessionId)}/links/${encodeURIComponent(relatedSessionId)}`,
      "DELETE",
      {},
      signal,
    );
  }

  public setSessionVoid(input: SetSessionVoidInput, signal?: AbortSignal): Promise<SetSessionVoidResult> {
    const { sessionId, ...body } = input;
    return this.write<SetSessionVoidResult>(
      `/api/sessions/${encodeURIComponent(sessionId)}/void`,
      "PATCH",
      body,
      signal,
    );
  }

  public setEvidenceVoid(input: SetEvidenceVoidInput, signal?: AbortSignal): Promise<SetEvidenceVoidResult> {
    const { evidenceId, ...body } = input;
    return this.write<SetEvidenceVoidResult>(
      `/api/evidence/${encodeURIComponent(evidenceId)}/void`,
      "PATCH",
      body,
      signal,
    );
  }

  public updateSessionSummary(
    input: UpdateSessionSummaryInput,
    signal?: AbortSignal,
  ): Promise<UpdateSessionSummaryResult> {
    const { sessionId, ...body } = input;
    return this.write<UpdateSessionSummaryResult>(
      `/api/sessions/${encodeURIComponent(sessionId)}/summary`,
      "PATCH",
      body,
      signal,
    );
  }

  public updateSessionWorkSummary(
    input: UpdateSessionWorkSummaryInput,
    signal?: AbortSignal,
  ): Promise<UpdateSessionWorkSummaryResult> {
    const { sessionId, ...body } = input;
    return this.write<UpdateSessionWorkSummaryResult>(
      `/api/sessions/${encodeURIComponent(sessionId)}/work-summary`,
      "PATCH",
      body,
      signal,
    );
  }

  public searchKnowledge(options: KnowledgeRequest = {}, signal?: AbortSignal): Promise<KnowledgeSearchResult> {
    return this.request<KnowledgeSearchResult>(
      appendQuery("/api/knowledge", {
        projectId: options.projectId,
        q: options.q ?? options.query,
        kind: options.kind,
        status: options.status,
        page: options.page,
        pageSize: options.pageSize === "all" ? 0 : options.pageSize,
        limit: options.limit,
      }),
      { signal },
    );
  }

  public getGraph(options: GraphQuery = {}, signal?: AbortSignal): Promise<GraphQueryResult> {
    return this.request<GraphQueryResult>(
      appendQuery("/api/graph", {
        projectRoot: options.projectRoot,
        projectId: options.projectId,
        limit: options.limit,
        maxNodes: options.maxNodes,
        maxEdges: options.maxEdges,
        pageSize: options.pageSize,
        cursor: options.cursor,
      }),
      { signal },
    );
  }

  public getReport(options: ReportRequest, signal?: AbortSignal): Promise<ReportQueryResult> {
    return this.request<ReportQueryResult>(
      appendQuery("/api/reports", {
        period: options.period,
        date: options.date,
        from: options.from,
        to: options.to,
        projectId: options.projectId,
        evidencePage: options.evidencePage,
        evidencePageSize: options.evidencePageSize === "all" ? 0 : options.evidencePageSize,
        evidenceKind: options.evidenceKind,
        evidenceQuery: options.evidenceQuery,
      }),
      { signal },
    );
  }

  public listReportSynthesisRequests(
    options: {
      period?: ReportPeriod;
      date?: string;
      projectId?: string;
      scopeType?: ReportSynthesisScopeType;
      limit?: number;
    } = {},
    signal?: AbortSignal,
  ): Promise<ReportSynthesisRequestListQueryResult> {
    return this.request<ReportSynthesisRequestListQueryResult>(
      appendQuery("/api/reports/synthesis-requests", {
        period: options.period,
        date: options.date,
        projectId: options.projectId,
        scopeType: options.scopeType,
        limit: options.limit,
      }),
      { signal },
    );
  }

  public listReportSummaries(
    options: {
      period?: ReportPeriod;
      date?: string;
      projectId?: string;
      scopeType?: ReportSynthesisScopeType;
      currentOnly?: boolean;
    } = {},
    signal?: AbortSignal,
  ): Promise<ReportSummaryQueryResult> {
    return this.request<ReportSummaryQueryResult>(
      appendQuery("/api/reports/summaries", {
        period: options.period,
        date: options.date,
        projectId: options.projectId,
        scopeType: options.scopeType,
        currentOnly: options.currentOnly,
      }),
      { signal },
    );
  }

  public createReportSynthesisRequest(
    input: {
      period: ReportPeriod;
      date?: string;
      projectId?: string;
      idempotencyKey?: string;
    },
    signal?: AbortSignal,
  ): Promise<CreateReportSynthesisRequestResult> {
    return this.write<CreateReportSynthesisRequestResult>("/api/reports/synthesis-requests", "POST", input, signal);
  }

  public retryReportSynthesisRequest(
    requestId: string,
    signal?: AbortSignal,
  ): Promise<RetryReportSynthesisRequestResult> {
    return this.write<RetryReportSynthesisRequestResult>(
      `/api/reports/synthesis-requests/${encodeURIComponent(requestId)}/retry`,
      "POST",
      {},
      signal,
    );
  }

  public cancelReportSynthesisRequest(
    requestId: string,
    signal?: AbortSignal,
  ): Promise<CancelReportSynthesisRequestResult> {
    return this.write<CancelReportSynthesisRequestResult>(
      `/api/reports/synthesis-requests/${encodeURIComponent(requestId)}/cancel`,
      "POST",
      {},
      signal,
    );
  }

  public deleteReportSummary(summaryId: string, signal?: AbortSignal): Promise<DeleteReportSummaryResult> {
    return this.write<DeleteReportSummaryResult>(
      `/api/reports/summaries/${encodeURIComponent(summaryId)}`,
      "DELETE",
      {},
      signal,
    );
  }

  public exportReport(
    options: ReportRequest & { format: ReportExportFormat },
    signal?: AbortSignal,
  ): Promise<ReportExportResult> {
    return this.request<ReportExportResult>(
      appendQuery("/api/reports/export", {
        period: options.period,
        date: options.date,
        from: options.from,
        to: options.to,
        projectId: options.projectId,
        format: options.format,
        evidencePage: options.evidencePage,
        evidencePageSize: options.evidencePageSize === "all" ? 0 : options.evidencePageSize,
        evidenceKind: options.evidenceKind,
        evidenceQuery: options.evidenceQuery,
      }),
      { signal },
    );
  }

  public createProject(input: { name: string; rootPath: string }, signal?: AbortSignal): Promise<ProjectRecord> {
    return this.write<ProjectRecord>("/api/projects", "POST", input, signal);
  }

  public updateProject(
    projectId: string,
    input: { name?: string; status?: ProjectStatus },
    signal?: AbortSignal,
  ): Promise<ProjectRecord> {
    return this.write<ProjectRecord>(`/api/projects/${encodeURIComponent(projectId)}`, "PATCH", input, signal);
  }

  public listMetadataBackfillRequests(signal?: AbortSignal): Promise<MetadataBackfillRequestListQueryResult> {
    return this.request<MetadataBackfillRequestListQueryResult>(
      "/api/backfill/metadata-requests?scopeType=all&limit=1",
      { signal },
    );
  }

  public createMetadataBackfillRequest(
    projectId?: string,
    signal?: AbortSignal,
  ): Promise<CreateMetadataBackfillRequestResult> {
    return this.write<CreateMetadataBackfillRequestResult>(
      "/api/backfill/metadata-requests",
      "POST",
      { projectId },
      signal,
    );
  }

  public cancelMetadataBackfillRequest(
    requestId: string,
    signal?: AbortSignal,
  ): Promise<CancelMetadataBackfillRequestResult> {
    return this.write<CancelMetadataBackfillRequestResult>(
      `/api/backfill/metadata-requests/${encodeURIComponent(requestId)}/cancel`,
      "POST",
      {},
      signal,
    );
  }

  public previewMetadataBackfill(limit = 50, signal?: AbortSignal): Promise<MetadataBackfillPreviewResult> {
    return this.request<MetadataBackfillPreviewResult>(appendQuery("/api/backfill/metadata/preview", { limit }), {
      signal,
    });
  }

  public previewHandoffs(
    projectRoot: string,
    handoffDirectory?: string,
    signal?: AbortSignal,
  ): Promise<HandoffImportPreviewResult> {
    return this.request<HandoffImportPreviewResult>(
      appendQuery("/api/imports/handoffs/preview", { projectRoot, handoffDirectory }),
      { signal },
    );
  }

  public importHandoffs(input: HandoffImportApplyInput, signal?: AbortSignal): Promise<HandoffImportBatchResult> {
    return this.write<HandoffImportBatchResult>("/api/imports/handoffs", "POST", input, signal);
  }

  public getKnowledgeHistory(
    knowledgeId: string,
    options: { projectRoot: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<KnowledgeHistoryResult> {
    return this.request<KnowledgeHistoryResult>(
      appendQuery(`/api/knowledge/${encodeURIComponent(knowledgeId)}/history`, options),
      { signal },
    );
  }

  public updateKnowledge(
    knowledgeId: string,
    input: Omit<UpdateKnowledgeInput, "knowledgeId">,
    signal?: AbortSignal,
  ): Promise<UpdateKnowledgeResult> {
    return this.write<UpdateKnowledgeResult>(
      `/api/knowledge/${encodeURIComponent(knowledgeId)}`,
      "PATCH",
      { ...input, knowledgeId },
      signal,
    );
  }

  public static pageInfo(total: number, page: number, pageSize: number): PageInfo {
    const normalizedPageSize = Math.max(pageSize, 1);
    const totalPages = Math.max(Math.ceil(total / normalizedPageSize), 1);
    const normalizedPage = Math.min(Math.max(page, 1), totalPages);
    const from = total === 0 ? 0 : (normalizedPage - 1) * normalizedPageSize + 1;
    const to = Math.min(normalizedPage * normalizedPageSize, total);
    return {
      page: normalizedPage,
      pageSize: normalizedPageSize,
      total,
      totalPages,
      from,
      to,
      hasPrevious: normalizedPage > 1,
      hasNext: normalizedPage < totalPages,
      truncated: false,
    };
  }
}

export function createApiClient(baseUrl = ""): ApiClient {
  return new ApiClient(baseUrl);
}
