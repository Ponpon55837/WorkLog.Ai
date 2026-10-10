import type { DatabaseSync } from "node:sqlite";
import {
  SESSION_READ_FIELDS,
  type KnowledgeRecord,
  type PolicyDecision,
  type SessionAgentReadQuery,
  type SessionAgentReadResult,
  type SessionDiagramRecord,
  type SessionLinkRecord,
  type SessionProjectionResult,
  type SessionReadField,
  type VerificationSummary,
  type WorkSummarySections,
} from "@work-intelligence/core";
import { sessionDetailQuerySchema } from "@work-intelligence/schema";
import {
  parseJson,
  toEvent,
  toSnapshot,
  toEvidence,
  toKnowledge,
  toVerificationUpdate,
  toVoidAudit,
  type EventRow,
  type SnapshotRow,
  type EvidenceRow,
  type KnowledgeRow,
  type VerificationUpdateRow,
  type VoidAuditRow,
} from "./session-record-codecs.js";
import { toSessionDecision, type SessionDecisionDbRow } from "./session-record-service.js";
import { runReadTransaction } from "./sqlite-transaction.js";

export interface SessionAgentReadDependencies {
  checkProjectById(projectId: string): PolicyDecision;
  withKnowledgeTrustMany(knowledge: KnowledgeRecord[]): KnowledgeRecord[];
  listDiagrams(sessionId: string): SessionDiagramRecord[];
  getSessionLinks(sessionId: string): SessionLinkRecord[];
}

type SelectedRow = {
  id: string;
  project_id: string;
  title: string;
  status: "finalized";
  execution_status: "completed";
  completed_at: string;
  updated_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  summary?: string;
  verification_json?: string | null;
  changed_files_json?: string | null;
  changed_files_confirmed?: number;
  changed_files_provenance_json?: string | null;
  changed_file_changes_json?: string | null;
  commit_sha?: string | null;
  git_branch?: string | null;
} & Partial<Record<`work_${keyof WorkSummarySections}_json`, string | null>>;

const WORK_SECTIONS = ["outcomes", "scope", "decisions", "verification", "nextSteps"] as const;
const COMPLETION: SessionReadField[] = [
  "session.summary",
  "session.workSummary.outcomes",
  "session.workSummary.verification",
  "session.workSummary.nextSteps",
  "session.verification",
  "links",
];
const HANDOFF: SessionReadField[] = [
  "session.summary",
  ...WORK_SECTIONS.map((key): SessionReadField => `session.workSummary.${key}`),
  "session.verification",
  "decisions",
  "links",
];
const COLUMNS: Partial<Record<SessionReadField, string[]>> = {
  "session.summary": ["summary"],
  "session.verification": ["verification_json"],
  "session.changedFiles": [
    "changed_files_json",
    "changed_files_confirmed",
    "changed_files_provenance_json",
    "changed_file_changes_json",
  ],
  "session.git": ["commit_sha", "git_branch"],
};

function fieldsFor(query: SessionAgentReadQuery): SessionReadField[] {
  const selected = new Set(query.select ?? (query.view === "completion" ? COMPLETION : HANDOFF));
  if (selected.has("session.workSummary.decisions")) selected.add("decisions");
  if (selected.has("session.verification")) selected.add("verificationHistory");
  return SESSION_READ_FIELDS.filter((field) => selected.has(field));
}

/** Projected reads load no unselected family and retain one consistent deferred SQLite snapshot. */
export class SessionAgentReadService {
  public constructor(
    private readonly db: DatabaseSync,
    private readonly dependencies: SessionAgentReadDependencies,
  ) {
    // SQLite length counts code points; the existing contract uses JavaScript UTF-16 length (including emoji).
    db.function("wi_utf16_length", { deterministic: true }, (value) => (typeof value === "string" ? value.length : 0));
  }

  public read(input: SessionAgentReadQuery): SessionAgentReadResult {
    const query = sessionDetailQuerySchema.parse(input);
    return runReadTransaction(this.db, () => this.readInSnapshot(query));
  }

  private readInSnapshot(query: SessionAgentReadQuery): SessionAgentReadResult {
    const identity = this.db.prepare("SELECT project_id FROM sessions WHERE id = ?").get(query.sessionId) as
      { project_id: string } | undefined;
    if (!identity) return { outcome: "not_found", sessionId: query.sessionId, reason: "Session does not exist." };
    const decision = this.dependencies.checkProjectById(identity.project_id);
    if (!decision.allowed || !decision.project)
      return {
        outcome: "skipped",
        sessionId: query.sessionId,
        projectStatus: decision.projectStatus,
        reason: decision.reason ?? "Project recording is not enabled.",
      };
    const fields = fieldsFor(query);
    const selected = new Set(fields);
    // Every SQL fragment here is a developer-owned constant; only ids are bound from input.
    const columns = [
      "id",
      "project_id",
      "title",
      "status",
      "execution_status",
      "completed_at",
      "updated_at",
      "voided_at",
      "void_reason",
    ];
    for (const field of fields) columns.push(...(COLUMNS[field] ?? []));
    for (const key of WORK_SECTIONS)
      if (selected.has(`session.workSummary.${key}`))
        columns.push(
          `CASE WHEN json_valid(work_summary_json) THEN json_extract(work_summary_json, '$.${key}') END AS work_${key}_json`,
        );
    const row = this.db
      .prepare(`SELECT ${columns.join(", ")} FROM sessions WHERE id = ?`)
      .get(query.sessionId) as SelectedRow;
    const result: SessionProjectionResult = {
      outcome: "session_detail",
      projection: {
        version: 1,
        ...(query.view ? { view: query.view } : {}),
        includedFields: fields,
        unavailableFields: [],
      },
      session: {
        id: row.id,
        projectId: row.project_id,
        title: row.title,
        status: row.status,
        executionStatus: row.execution_status,
        completedAt: row.completed_at,
        ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
        ...(row.voided_at ? { voided: { at: row.voided_at, reason: row.void_reason ?? "" } } : {}),
      },
    };
    const unavailable = new Set<SessionReadField>();
    if (selected.has("session.summary")) result.session.summary = row.summary;
    for (const key of WORK_SECTIONS) {
      const field: SessionReadField = `session.workSummary.${key}`;
      if (!selected.has(field)) continue;
      const value = parseJson<unknown>(row[`work_${key}_json`] ?? null, undefined);
      if (!Array.isArray(value)) {
        unavailable.add(field);
        continue;
      }
      (result.session.workSummary ??= {})[key] = value.filter((item): item is string => typeof item === "string");
    }
    if (selected.has("session.verification")) {
      const verification = parseJson<VerificationSummary | undefined>(row.verification_json ?? null, undefined);
      if (verification) result.session.verification = verification;
      else unavailable.add("session.verification");
    }
    if (selected.has("session.changedFiles")) {
      const files = parseJson<unknown>(row.changed_files_json ?? null, undefined);
      if (
        Array.isArray(files) &&
        files.every((file) => typeof file === "string") &&
        (files.length > 0 || row.changed_files_confirmed === 1)
      ) {
        result.session.changedFiles = files;
        result.session.changedFilesProvenance = parseJson(row.changed_files_provenance_json ?? null, []);
        result.session.changedFileChanges = parseJson(row.changed_file_changes_json ?? null, []);
      } else unavailable.add("session.changedFiles");
    }
    if (selected.has("session.git")) {
      if (row.commit_sha) result.session.commitSha = row.commit_sha;
      if (row.git_branch) result.session.gitBranch = row.git_branch;
      if (!row.commit_sha && !row.git_branch) unavailable.add("session.git");
    }
    if (selected.has("decisions"))
      result.decisions = (
        this.db
          .prepare("SELECT * FROM session_decisions WHERE session_id = ? ORDER BY position ASC, id ASC")
          .all(query.sessionId) as SessionDecisionDbRow[]
      ).map(toSessionDecision);
    if (selected.has("links")) result.links = this.dependencies.getSessionLinks(query.sessionId);
    if (selected.has("verificationHistory"))
      result.verificationHistory = (
        this.db
          .prepare(
            "SELECT * FROM session_verification_updates WHERE session_id = ? ORDER BY created_at DESC, rowid DESC",
          )
          .all(query.sessionId) as VerificationUpdateRow[]
      ).map(toVerificationUpdate);
    if (selected.has("voidHistory"))
      result.voidHistory = (
        this.db
          .prepare("SELECT * FROM void_audit WHERE session_id = ? ORDER BY occurred_at DESC, rowid DESC")
          .all(query.sessionId) as VoidAuditRow[]
      ).map(toVoidAudit);
    if (selected.has("events"))
      result.events = (
        this.db
          .prepare("SELECT * FROM work_events WHERE session_id = ? ORDER BY occurred_at ASC")
          .all(query.sessionId) as EventRow[]
      ).map(toEvent);
    if (selected.has("evidence"))
      result.evidence = (
        this.db
          .prepare("SELECT * FROM evidence WHERE session_id = ? ORDER BY captured_at ASC, rowid ASC")
          .all(query.sessionId) as EvidenceRow[]
      ).map(toEvidence);
    if (selected.has("knowledge"))
      result.knowledge = this.dependencies.withKnowledgeTrustMany(
        (
          this.db
            .prepare(
              "SELECT k.*, p.name AS project_name FROM knowledge k JOIN projects p ON p.id=k.project_id WHERE k.session_id = ? ORDER BY k.updated_at DESC, k.id ASC",
            )
            .all(query.sessionId) as KnowledgeRow[]
        ).map(toKnowledge),
      );
    if (selected.has("diagrams")) result.diagrams = this.dependencies.listDiagrams(query.sessionId);
    if (selected.has("rawSnapshots")) {
      if (query.includeRawSnapshots)
        result.rawSnapshots = (
          this.db
            .prepare("SELECT * FROM raw_snapshots WHERE session_id = ? ORDER BY captured_at ASC")
            .all(query.sessionId) as SnapshotRow[]
        ).map(toSnapshot);
      else
        result.rawSnapshots = (
          this.db
            .prepare(
              "SELECT id, session_id, project_id, kind, source_path, captured_at, wi_utf16_length(content) AS content_length FROM raw_snapshots WHERE session_id = ? ORDER BY captured_at ASC",
            )
            .all(query.sessionId) as Array<Omit<SnapshotRow, "content"> & { content_length: number }>
        ).map((row) => ({
          id: row.id,
          sessionId: row.session_id,
          projectId: row.project_id,
          kind: row.kind,
          ...(row.source_path ? { sourcePath: row.source_path } : {}),
          capturedAt: row.captured_at,
          contentLength: row.content_length,
        }));
    }
    result.projection.unavailableFields = fields.filter((field) => unavailable.has(field));
    return result;
  }
}
