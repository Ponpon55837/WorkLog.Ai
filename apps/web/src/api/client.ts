import type {
  DashboardSummary,
  GraphQuery,
  GraphQueryResult,
  KnowledgeQuery,
  KnowledgeSearchResult,
  PageInfo,
  ProjectRecord,
  ReportPeriod,
  ReportQueryResult,
  SessionDetail,
  SessionListResult
} from "@work-intelligence/core";

type ApiErrorPayload = { error?: string };

export type SessionListRequest = {
  q?: string;
  projectId?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number | "all";
};

export type ReportRequest = {
  period: ReportPeriod;
  date?: string;
  projectId?: string;
  evidencePage?: number;
  evidencePageSize?: number | "all";
  evidenceKind?: string;
  evidenceQuery?: string;
};

function appendQuery(path: string, values: Record<string, string | number | undefined>): string {
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

  public async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {})
      }
    });
    const payload = (await response.json()) as T & ApiErrorPayload;
    if (!response.ok) {
      throw new Error(payload.error ?? "請求失敗，請確認 API 是否已啟動。");
    }
    return payload;
  }

  public getDashboard(signal?: AbortSignal): Promise<DashboardSummary> {
    return this.request<DashboardSummary>("/api/dashboard", { signal });
  }

  public listProjects(signal?: AbortSignal): Promise<ProjectRecord[]> {
    return this.request<ProjectRecord[]>("/api/projects", { signal });
  }

  public listSessions(options: SessionListRequest = {}, signal?: AbortSignal): Promise<SessionListResult> {
    return this.request<SessionListResult>(appendQuery("/api/sessions", {
      q: options.q,
      projectId: options.projectId,
      from: options.from,
      to: options.to,
      page: options.page,
      pageSize: options.pageSize === "all" ? 0 : options.pageSize
    }), { signal });
  }

  public getSessionDetail(sessionId: string, signal?: AbortSignal): Promise<SessionDetail> {
    return this.request<SessionDetail>(`/api/sessions/${encodeURIComponent(sessionId)}`, { signal });
  }

  public searchKnowledge(options: KnowledgeQuery = {}, signal?: AbortSignal): Promise<KnowledgeSearchResult> {
    return this.request<KnowledgeSearchResult>(appendQuery("/api/knowledge", {
      projectId: options.projectId,
      q: options.q ?? options.query,
      kind: options.kind,
      status: options.status,
      page: options.page,
      pageSize: options.pageSize,
      limit: options.limit
    }), { signal });
  }

  public getGraph(options: GraphQuery = {}, signal?: AbortSignal): Promise<GraphQueryResult> {
    return this.request<GraphQueryResult>(appendQuery("/api/graph", {
      projectRoot: options.projectRoot,
      projectId: options.projectId,
      limit: options.limit,
      maxNodes: options.maxNodes,
      maxEdges: options.maxEdges
    }), { signal });
  }

  public getReport(options: ReportRequest, signal?: AbortSignal): Promise<ReportQueryResult> {
    return this.request<ReportQueryResult>(appendQuery("/api/reports", {
      period: options.period,
      date: options.date,
      projectId: options.projectId,
      evidencePage: options.evidencePage,
      evidencePageSize: options.evidencePageSize === "all" ? 0 : options.evidencePageSize,
      evidenceKind: options.evidenceKind,
      evidenceQuery: options.evidenceQuery
    }), { signal });
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
      hasNext: normalizedPage < totalPages
    };
  }
}

export function createApiClient(baseUrl = ""): ApiClient {
  return new ApiClient(baseUrl);
}
