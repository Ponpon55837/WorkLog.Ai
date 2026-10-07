import type { PageInfo } from "./types";
import { ApiTransport } from "./transport";
import { createSystemApi, type SystemApi } from "./system";
import { createBackupsApi, type BackupsApi } from "./backups";
import { createProjectsApi, type ProjectsApi } from "./projects";
import { createAgentReadsApi, type AgentReadsApi } from "./agent-reads";
import { createSessionsApi, type SessionsApi } from "./sessions";
import { createKnowledgeApi, type KnowledgeApi } from "./knowledge";
import { createGraphApi, type GraphApi } from "./graph";
import { createReportsApi, type ReportsApi } from "./reports";
import { createMetadataBackfillApi, type MetadataBackfillApi } from "./metadata-backfill";
import { createHandoffImportApi, type HandoffImportApi } from "./handoff-import";
import { createSessionDecisionsApi, type SessionDecisionsApi } from "./session-decisions";
import { createKnowledgePagesApi, type KnowledgePagesApi } from "./knowledge-pages";
import { createOutstandingCleanupApi, type OutstandingCleanupApi } from "./outstanding-cleanup";
import { createOutstandingItemsApi, type OutstandingItemsApi } from "./outstanding-items";

export { ApiError } from "./transport";
export type { ApiHealth, OutstandingItemsRequest, ReportRequest, SessionListRequest } from "./types";

export interface ApiClient
  extends
    SystemApi,
    BackupsApi,
    ProjectsApi,
    SessionsApi,
    AgentReadsApi,
    KnowledgeApi,
    GraphApi,
    ReportsApi,
    MetadataBackfillApi,
    HandoffImportApi,
    SessionDecisionsApi,
    KnowledgePagesApi,
    OutstandingItemsApi,
    OutstandingCleanupApi {}

// TypeScript declaration merging exposes the domain methods assigned in the constructor.
// eslint-disable-next-line no-redeclare -- the interface describes this class's dynamic API surface.
export class ApiClient extends ApiTransport {
  public constructor(baseUrl = "", onConnectionChange?: (isOnline: boolean) => void) {
    super(baseUrl, onConnectionChange);
    Object.assign(
      this,
      createSystemApi(this),
      createBackupsApi(this),
      createProjectsApi(this),
      createSessionsApi(this),
      createAgentReadsApi(this),
      createKnowledgeApi(this),
      createGraphApi(this),
      createReportsApi(this),
      createMetadataBackfillApi(this),
      createHandoffImportApi(this),
      createSessionDecisionsApi(this),
      createKnowledgePagesApi(this),
      createOutstandingItemsApi(this),
      createOutstandingCleanupApi(this),
    );
  }

  static pageInfo(total: number, page: number, pageSize: number): PageInfo {
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

export function createApiClient(baseUrl = "", onConnectionChange?: (isOnline: boolean) => void): ApiClient {
  return new ApiClient(baseUrl, onConnectionChange);
}
