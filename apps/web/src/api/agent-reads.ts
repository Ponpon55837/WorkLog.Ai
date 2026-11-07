import type { AgentReadAuditPage, AgentReadReferences, AgentReadStats } from "@work-intelligence/core";
import { appendQuery, type ApiTransport } from "./transport";

export interface AgentReadsRequest {
  projectId?: string;
  agent?: string;
  page?: number;
  pageSize?: number;
}

export interface AgentReadStatsRequest {
  projectId?: string;
  agentClient?: string;
}

export interface AgentReadsApi {
  listAgentReads(options?: AgentReadsRequest, signal?: AbortSignal): Promise<AgentReadAuditPage>;
  getAgentReadStats(options?: AgentReadStatsRequest, signal?: AbortSignal): Promise<AgentReadStats>;
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

    getAgentReadStats(options: AgentReadStatsRequest = {}, signal?: AbortSignal): Promise<AgentReadStats> {
      return client.request<AgentReadStats>(
        appendQuery("/api/agent-reads/stats", { projectId: options.projectId, agentClient: options.agentClient }),
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
