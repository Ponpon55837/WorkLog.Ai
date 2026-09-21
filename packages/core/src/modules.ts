import type {
  AttachEvidenceInput,
  AttachEvidenceResult,
  GraphQuery,
  GraphQueryResult,
  KnowledgeQuery,
  KnowledgeHistoryQuery,
  KnowledgeHistoryResult,
  KnowledgeSearchResult,
  RecordKnowledgeInput,
  RecordKnowledgeResult,
  ReportPeriod,
  ReportQueryResult,
  UpdateKnowledgeInput,
  UpdateKnowledgeResult
} from "./index.js";

export interface ReportModule {
  buildReport(input: { period: ReportPeriod; date?: string; projectId?: string }): Promise<ReportQueryResult> | ReportQueryResult;
}

export interface EvidenceModule {
  attachEvidence(input: AttachEvidenceInput): Promise<AttachEvidenceResult> | AttachEvidenceResult;
}

export interface KnowledgeModule {
  recordKnowledge(input: RecordKnowledgeInput): Promise<RecordKnowledgeResult> | RecordKnowledgeResult;
  updateKnowledge(input: UpdateKnowledgeInput): Promise<UpdateKnowledgeResult> | UpdateKnowledgeResult;
  searchKnowledge(input: KnowledgeQuery): Promise<KnowledgeSearchResult> | KnowledgeSearchResult;
  getKnowledgeHistory(input: KnowledgeHistoryQuery): Promise<KnowledgeHistoryResult> | KnowledgeHistoryResult;
}

export interface GraphModule {
  buildGraph(input: GraphQuery): Promise<GraphQueryResult> | GraphQueryResult;
}

export interface ExtensionModules {
  reports?: ReportModule;
  evidence?: EvidenceModule;
  knowledge?: KnowledgeModule;
  graph?: GraphModule;
}
