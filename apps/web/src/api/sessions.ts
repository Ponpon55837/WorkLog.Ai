import type {
  LinkSessionsResult,
  SessionLinkRelation,
  SessionDetail,
  SessionListResult,
  SetDiagramVoidInput,
  SetDiagramVoidResult,
  SetEvidenceVoidInput,
  SetEvidenceVoidResult,
  SetSessionVoidInput,
  SetSessionVoidResult,
  UpdateSessionSummaryInput,
  UpdateSessionVerificationResult,
  VerificationSummary,
  UpdateSessionSummaryResult,
  UpdateSessionWorkSummaryInput,
  UpdateSessionWorkSummaryResult,
} from "@work-intelligence/core";
import type { SessionListRequest } from "./types";
import { appendQuery, type ApiTransport } from "./transport";

export interface SessionsApi {
  listSessions(options?: SessionListRequest, signal?: AbortSignal): Promise<SessionListResult>;
  listSessionAgents(signal?: AbortSignal): Promise<string[]>;
  getSessionDetail(sessionId: string, signal?: AbortSignal): Promise<SessionDetail>;
  updateSessionVerification(
    sessionId: string,
    verification: VerificationSummary,
    signal?: AbortSignal,
  ): Promise<UpdateSessionVerificationResult>;
  linkSession(
    sessionId: string,
    relatedSessionId: string,
    relation: SessionLinkRelation,
    signal?: AbortSignal,
  ): Promise<LinkSessionsResult>;
  unlinkSession(sessionId: string, relatedSessionId: string, signal?: AbortSignal): Promise<LinkSessionsResult>;
  setSessionVoid(input: SetSessionVoidInput, signal?: AbortSignal): Promise<SetSessionVoidResult>;
  setEvidenceVoid(input: SetEvidenceVoidInput, signal?: AbortSignal): Promise<SetEvidenceVoidResult>;
  setDiagramVoid(input: SetDiagramVoidInput, signal?: AbortSignal): Promise<SetDiagramVoidResult>;
  updateSessionSummary(input: UpdateSessionSummaryInput, signal?: AbortSignal): Promise<UpdateSessionSummaryResult>;
  updateSessionWorkSummary(
    input: UpdateSessionWorkSummaryInput,
    signal?: AbortSignal,
  ): Promise<UpdateSessionWorkSummaryResult>;
}

export function createSessionsApi(client: ApiTransport): SessionsApi {
  return {
    listSessions(options: SessionListRequest = {}, signal?: AbortSignal): Promise<SessionListResult> {
      return client.request<SessionListResult>(
        appendQuery("/api/sessions", {
          q: options.q,
          projectId: options.projectId,
          agent: options.agent,
          voided: options.voided === "exclude" ? undefined : options.voided,
          from: options.from,
          to: options.to,
          page: options.page,
          pageSize: options.pageSize === "all" ? 0 : options.pageSize,
        }),
        { signal },
      );
    },

    async listSessionAgents(signal?: AbortSignal): Promise<string[]> {
      const result = await client.request<{ agents: string[] }>("/api/sessions/agents", { signal });
      return result.agents;
    },

    getSessionDetail(sessionId: string, signal?: AbortSignal): Promise<SessionDetail> {
      return client.request<SessionDetail>(`/api/sessions/${encodeURIComponent(sessionId)}`, { signal });
    },

    updateSessionVerification(
      sessionId: string,
      verification: VerificationSummary,
      signal?: AbortSignal,
    ): Promise<UpdateSessionVerificationResult> {
      return client.write<UpdateSessionVerificationResult>(
        `/api/sessions/${encodeURIComponent(sessionId)}/verification`,
        "PATCH",
        verification,
        signal,
      );
    },

    linkSession(
      sessionId: string,
      relatedSessionId: string,
      relation: SessionLinkRelation,
      signal?: AbortSignal,
    ): Promise<LinkSessionsResult> {
      return client.write<LinkSessionsResult>(
        `/api/sessions/${encodeURIComponent(sessionId)}/links`,
        "POST",
        { relatedSessionId, relation },
        signal,
      );
    },

    unlinkSession(sessionId: string, relatedSessionId: string, signal?: AbortSignal): Promise<LinkSessionsResult> {
      return client.write<LinkSessionsResult>(
        `/api/sessions/${encodeURIComponent(sessionId)}/links/${encodeURIComponent(relatedSessionId)}`,
        "DELETE",
        {},
        signal,
      );
    },

    setSessionVoid(input: SetSessionVoidInput, signal?: AbortSignal): Promise<SetSessionVoidResult> {
      const { sessionId, ...body } = input;
      return client.write<SetSessionVoidResult>(
        `/api/sessions/${encodeURIComponent(sessionId)}/void`,
        "PATCH",
        body,
        signal,
      );
    },

    setDiagramVoid(input: SetDiagramVoidInput, signal?: AbortSignal): Promise<SetDiagramVoidResult> {
      const { diagramId, ...body } = input;
      return client.write<SetDiagramVoidResult>(
        `/api/diagrams/${encodeURIComponent(diagramId)}/void`,
        "PATCH",
        body,
        signal,
      );
    },

    setEvidenceVoid(input: SetEvidenceVoidInput, signal?: AbortSignal): Promise<SetEvidenceVoidResult> {
      const { evidenceId, ...body } = input;
      return client.write<SetEvidenceVoidResult>(
        `/api/evidence/${encodeURIComponent(evidenceId)}/void`,
        "PATCH",
        body,
        signal,
      );
    },

    updateSessionSummary(input: UpdateSessionSummaryInput, signal?: AbortSignal): Promise<UpdateSessionSummaryResult> {
      const { sessionId, ...body } = input;
      return client.write<UpdateSessionSummaryResult>(
        `/api/sessions/${encodeURIComponent(sessionId)}/summary`,
        "PATCH",
        body,
        signal,
      );
    },

    updateSessionWorkSummary(
      input: UpdateSessionWorkSummaryInput,
      signal?: AbortSignal,
    ): Promise<UpdateSessionWorkSummaryResult> {
      const { sessionId, ...body } = input;
      return client.write<UpdateSessionWorkSummaryResult>(
        `/api/sessions/${encodeURIComponent(sessionId)}/work-summary`,
        "PATCH",
        body,
        signal,
      );
    },
  };
}
