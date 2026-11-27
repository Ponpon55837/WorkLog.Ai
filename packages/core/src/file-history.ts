import type { ReportVerificationStatus } from "./index.js";

export interface FileHistoryQuery {
  projectRoot: string;
  /** 1–3 repository-relative paths, matched like recorded changed files (separators and letter case ignored). */
  paths: string[];
  /** How many of the newest Sessions to return per path (default 5, at most 10). */
  limit?: number;
  cursor?: string;
}

export interface FileHistorySessionDigest {
  id: string;
  completedAt: string;
  title: string;
  verificationStatus: ReportVerificationStatus;
  decisions?: string[];
  decisionsOmitted?: number;
  pendingItems?: Array<{ id: string; text: string }>;
  pendingItemsOmitted?: number;
  truncated?: true;
}

export interface FileHistoryTotals {
  sessions: number;
  firstAt?: string;
  lastAt?: string;
  verification: Partial<Record<ReportVerificationStatus, number>>;
  withDecisions: number;
  pendingItems: number;
  /** Sessions that recorded more than 20 changed files (broad changes such as renames or formatting). */
  broadChanges: number;
}

export interface FileHistoryEntry {
  path: string;
  totals: FileHistoryTotals;
  recent: FileHistorySessionDigest[];
  attention: FileHistorySessionDigest[];
  omitted: {
    older: number;
    attention: number;
  };
  nextCursor?: string;
}

export interface FileHistoryResult {
  outcome: "file_history";
  project: { id: string; name: string };
  relation: "changed_files";
  files: FileHistoryEntry[];
  knowledge: Array<{ type: "knowledge"; id: string; title: string }>;
  knowledgeOmitted?: number;
  appliesToScanTruncated?: true;
  budgetTrimmed?: true;
  readWith: "work_get_session";
  readArguments: { view: "handoff" };
}
