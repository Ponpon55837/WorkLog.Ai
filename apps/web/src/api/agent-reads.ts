import type { AgentReadAuditPage, AgentReadReferences } from "@work-intelligence/core";
import { appendQuery, type ApiTransport } from "./transport";

export interface AgentReadsRequest {
  projectId?: string;
  agent?: string;
  page?: number;
  pageSize?: number;
}

export interface AgentReadsApi {
  listAgentReads(options?: AgentReadsRequest, signal?: AbortSignal): Promise<AgentReadAuditPage>;
  getSessionAgentReads(sessionId: string, signal?: AbortSignal): Promise<AgentReadReferences>;
  getKnowledgeAgentReads(knowledgeId: string, signal?: AbortSignal): Promise<AgentReadReferences>;
}

export function createAgentReadsApi(client: ApiTransport): AgentReadsApi {
  return {
    listAgentReads(options: AgentReadsRequest = {}, signal?: AbortSignal): Promise<AgentReadAuditPage> {
      return client.request<AgentReadAuditPage>(
        appendQuery("/api/agent-reads", {
          projectId: options.projectId,
          agent: options.agent,
          page: options.page,
          pageSize: options.pageSize,
        }),
        { signal },
      );
    },

    getSessionAgentReads(sessionId: string, signal?: AbortSignal): Promise<AgentReadReferences> {
      return client.request<AgentReadReferences>(`/api/sessions/${encodeURIComponent(sessionId)}/agent-reads`, {
        signal,
      });
    },

    getKnowledgeAgentReads(knowledgeId: string, signal?: AbortSignal): Promise<AgentReadReferences> {
      return client.request<AgentReadReferences>(`/api/knowledge/${encodeURIComponent(knowledgeId)}/agent-reads`, {
        signal,
      });
    },
  };
}
