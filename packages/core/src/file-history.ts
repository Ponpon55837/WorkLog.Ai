import type { ReportVerificationStatus } from "./index.js";

export interface FileHistoryQuery {
  projectRoot: string;
  /** 1–3 repository-relative paths, matched like recorded changed files (separators and letter case ignored). */
  paths: string[];
  /** How many of the newest Sessions to return per path (default 5, at most 10). */
  limit?: number;
  /** nextCursor of an earlier one-path answer, to read the Sessions before it. */
  cursor?: string;
}

/** One Session that recorded the path among its changed files. */
export interface FileHistorySessionDigest {
  id: string;
  completedAt: string;
  title: string;
  verificationStatus: ReportVerificationStatus;
  /** The first decisions of its workSummary, shortened; decisionsOmitted counts the rest. */
  decisions?: string[];
  decisionsOmitted?: number;
  /** Its pending outstanding items, text shortened; pendingItemsOmitted counts the rest. */
  pendingItems?: Array<{ id: string; text: string }>;
  pendingItemsOmitted?: number;
  /** Some text of this digest was shortened. */
  truncated?: true;
}

export interface FileHistoryTotals {
  /** Non-voided Sessions whose recorded changed files contain the path. */
  sessions: number;
  firstAt?: string;
  lastAt?: string;
  /** Session counts by verification status; statuses with no Session are left out. */
  verification: Partial<Record<ReportVerificationStatus, number>>;
  /** Sessions that recorded at least one decision. */
  withDecisions: number;
  /** Pending outstanding items that originate from these Sessions. */
  pendingItems: number;
  /** Sessions that recorded more than 20 changed files (broad changes such as renames or formatting). */
  broadChanges: number;
}

export interface FileHistoryEntry {
  /** The path as requested. */
  path: string;
  totals: FileHistoryTotals;
  /** The newest Sessions (before the cursor, when one was passed), newest first. */
  recent: FileHistorySessionDigest[];
  /** Failed or not-run Sessions older than recent, newest first. */
  attention: FileHistorySessionDigest[];
  omitted: {
    /** Sessions older than the last recent digest; read them with nextCursor. */
    older: number;
    /** Failed or not-run Sessions older than recent that attention does not show. */
    attention: number;
  };
  nextCursor?: string;
}

export interface FileHistoryResult {
  outcome: "file_history";
  project: { id: string; name: string };
  /** Only recorded changed files relate a Session to a path; nothing is inferred. */
  relation: "changed_files";
  files: FileHistoryEntry[];
  /** Active Knowledge whose appliesTo covers a requested path, best match first. */
  knowledge: Array<{ type: "knowledge"; id: string; title: string }>;
  knowledgeOmitted?: number;
  /** The appliesTo match budget ran out, so older Knowledge was not checked against the requested paths. */
  appliesToScanTruncated?: true;
  /** Digests were shortened or dropped to keep the response within budget. */
  budgetTrimmed?: true;
  readWith: "work_get_session";
  /** Arguments to pass with readWith: the compact handoff projection, which lists each changed path once. */
  readArguments: { view: "handoff" };
}
