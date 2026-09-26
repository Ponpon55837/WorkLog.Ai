import { relative } from "node:path";
import { CHANGED_FILE_SOURCES } from "@work-intelligence/core";
import type {
  ChangedFileChange,
  ChangedFileProvenance,
  ChangedFileSource,
  ChangedFilesFollowUp,
  EvidenceRecord,
  KnowledgeAuditAction,
  KnowledgeAuditRecord,
  KnowledgeKind,
  KnowledgeRecord,
  KnowledgeReview,
  KnowledgeStatus,
  RawSnapshotRecord,
  VerificationFollowUp,
  VerificationSummary,
  VerificationUpdateRecord,
  VerificationUpdateSource,
  VoidAuditRecord,
  VoidTargetType,
  WorkEventRecord,
  WorkEventType,
  WorkSessionRecord,
  WorkSummaryFollowUp,
  WorkSummarySections,
} from "@work-intelligence/core";
import { createProjectPathResolver } from "@work-intelligence/project-policy";
import type { SessionRow } from "./session-repository.js";

export type EventRow = {
  id: string;
  session_id: string;
  type: WorkEventType;
  summary: string;
  details_json: string | null;
  occurred_at: string;
};

export type SnapshotRow = {
  id: string;
  session_id: string;
  project_id: string;
  kind: "handoff";
  source_path: string | null;
  content: string;
  captured_at: string;
};

export type EvidenceRow = {
  id: string;
  session_id: string;
  project_id: string;
  kind: string;
  reference: string;
  summary: string | null;
  captured_at: string;
  voided_at?: string | null;
  void_reason?: string | null;
};

export type KnowledgeRow = {
  id: string;
  project_id: string;
  project_name: string | null;
  session_id: string | null;
  idempotency_key: string;
  kind: KnowledgeKind;
  title: string;
  body: string;
  tags_json: string;
  references_json: string;
  status: KnowledgeStatus;
  created_at: string;
  updated_at: string;
  applies_to_json?: string | null;
  last_confirmed_at?: string | null;
  last_confirmed_session_id?: string | null;
  supersedes_id?: string | null;
  review_json?: string | null;
};

export type KnowledgeAuditRow = {
  id: string;
  knowledge_id: string;
  project_id: string;
  action: KnowledgeAuditAction;
  before_json: string | null;
  after_json: string;
  changed_fields_json: string;
  occurred_at: string;
};

export function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function normalizeWorkSummarySections(value: WorkSummarySections | undefined): WorkSummarySections | undefined {
  if (!value) {
    return undefined;
  }

  return {
    outcomes: value.outcomes.map((item) => item.trim()).filter(Boolean),
    scope: value.scope.map((item) => item.trim()).filter(Boolean),
    decisions: value.decisions.map((item) => item.trim()).filter(Boolean),
    verification: value.verification.map((item) => item.trim()).filter(Boolean),
    nextSteps: value.nextSteps.map((item) => item.trim()).filter(Boolean),
  };
}

export function normalizeWorkSummaryPatch(
  value: WorkSummarySections | Partial<WorkSummarySections>,
): Partial<WorkSummarySections> {
  const normalized: Partial<WorkSummarySections> = {};
  const sectionKeys: Array<keyof WorkSummarySections> = ["outcomes", "scope", "decisions", "verification", "nextSteps"];
  for (const key of sectionKeys) {
    const section = value[key];
    if (Array.isArray(section)) {
      normalized[key] = section.map((item) => item.trim()).filter(Boolean);
    }
  }
  return normalized;
}

export function completeWorkSummary(value: Partial<WorkSummarySections>): WorkSummarySections | undefined {
  if (
    !Array.isArray(value.outcomes) ||
    !Array.isArray(value.scope) ||
    !Array.isArray(value.decisions) ||
    !Array.isArray(value.verification) ||
    !Array.isArray(value.nextSteps)
  ) {
    return undefined;
  }
  return {
    outcomes: value.outcomes,
    scope: value.scope,
    decisions: value.decisions,
    verification: value.verification,
    nextSteps: value.nextSteps,
  };
}

export function mergeWorkSummary(
  current: WorkSummarySections | undefined,
  patch: Partial<WorkSummarySections>,
): WorkSummarySections {
  return {
    outcomes: patch.outcomes ?? current?.outcomes ?? [],
    scope: patch.scope ?? current?.scope ?? [],
    decisions: patch.decisions ?? current?.decisions ?? [],
    verification: patch.verification ?? current?.verification ?? [],
    nextSteps: patch.nextSteps ?? current?.nextSteps ?? [],
  };
}

export function parseWorkSummarySections(value: string | null): WorkSummarySections | undefined {
  const parsed = parseJson<Partial<WorkSummarySections>>(value, {});
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }

  const sections: WorkSummarySections = {
    outcomes: Array.isArray(parsed.outcomes)
      ? parsed.outcomes.filter((item): item is string => typeof item === "string")
      : [],
    scope: Array.isArray(parsed.scope) ? parsed.scope.filter((item): item is string => typeof item === "string") : [],
    decisions: Array.isArray(parsed.decisions)
      ? parsed.decisions.filter((item): item is string => typeof item === "string")
      : [],
    verification: Array.isArray(parsed.verification)
      ? parsed.verification.filter((item): item is string => typeof item === "string")
      : [],
    nextSteps: Array.isArray(parsed.nextSteps)
      ? parsed.nextSteps.filter((item): item is string => typeof item === "string")
      : [],
  };

  const hasStructuredSections = ["outcomes", "scope", "decisions", "verification", "nextSteps"].some((key) =>
    Array.isArray(parsed[key as keyof WorkSummarySections]),
  );
  return hasStructuredSections ? sections : undefined;
}

export function changedFileIdentity(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

export function sortChangedFileSources(sources: ChangedFileSource[]): ChangedFileSource[] {
  const order = new Map<ChangedFileSource, number>(CHANGED_FILE_SOURCES.map((source, index) => [source, index]));
  return [...new Set(sources)].sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
}

export function normalizeChangedFilePath(
  projectRoot: string,
  value: string,
  pathResolver = createProjectPathResolver(projectRoot),
): string {
  const candidate = value.trim();
  if (!candidate) {
    throw new Error("Changed file paths must not be empty.");
  }

  const absolutePath = pathResolver.safePath(candidate);
  if (!absolutePath) {
    throw new Error(`Changed file path must remain inside the tracked project root: ${candidate}`);
  }

  const normalized = relative(projectRoot, absolutePath).replaceAll("\\", "/");
  if (!normalized || normalized === ".") {
    throw new Error(`Changed file path must identify a file inside the tracked project root: ${candidate}`);
  }
  return normalized;
}

export function normalizeChangedFileChanges(
  projectRoot: string,
  changes: ChangedFileChange[] | undefined,
  pathResolver = createProjectPathResolver(projectRoot),
): ChangedFileChange[] {
  const normalized: ChangedFileChange[] = [];
  const identities = new Set<string>();

  for (const change of changes ?? []) {
    if (change.status === "renamed" && !change.previousPath?.trim()) {
      throw new Error("A renamed file change must include previousPath.");
    }
    const path = normalizeChangedFilePath(projectRoot, change.path, pathResolver);
    const previousPath = change.previousPath
      ? normalizeChangedFilePath(projectRoot, change.previousPath, pathResolver)
      : undefined;
    const identity = [
      change.status,
      changedFileIdentity(path),
      previousPath ? changedFileIdentity(previousPath) : "",
    ].join(":");
    if (identities.has(identity)) {
      continue;
    }
    identities.add(identity);
    normalized.push({
      path,
      status: change.status,
      ...(previousPath ? { previousPath } : {}),
    });
  }

  return normalized;
}

export function changedFilePathsFromChanges(changes: ChangedFileChange[]): string[] {
  return changes.flatMap((change) => [change.path, ...(change.previousPath ? [change.previousPath] : [])]);
}

export function mergeChangedFileChanges(
  projectRoot: string,
  current: WorkSessionRecord,
  incoming: ChangedFileChange[] | undefined,
  pathResolver = createProjectPathResolver(projectRoot),
): ChangedFileChange[] {
  const normalizedIncoming = normalizeChangedFileChanges(projectRoot, incoming, pathResolver);
  const merged: ChangedFileChange[] = [];
  const identities = new Set<string>();

  for (const change of [...current.changedFileChanges, ...normalizedIncoming]) {
    const identity = [
      change.status,
      changedFileIdentity(change.path),
      change.previousPath ? changedFileIdentity(change.previousPath) : "",
    ].join(":");
    if (identities.has(identity)) {
      continue;
    }
    identities.add(identity);
    merged.push(change);
  }

  return merged;
}

export function normalizeChangedFiles(
  projectRoot: string,
  changedFiles: string[] | undefined,
  provenance: ChangedFileProvenance[] | undefined,
  pathResolver = createProjectPathResolver(projectRoot),
): { files: string[]; provenance: ChangedFileProvenance[] } {
  const files: string[] = [];
  const fileByIdentity = new Map<string, string>();
  const provenanceByIdentity = new Map<string, { sources: ChangedFileSource[]; references: string[] }>();

  const addFile = (value: string): string => {
    const path = normalizeChangedFilePath(projectRoot, value, pathResolver);
    const identity = changedFileIdentity(path);
    const existing = fileByIdentity.get(identity);
    if (existing) {
      return existing;
    }
    fileByIdentity.set(identity, path);
    files.push(path);
    return path;
  };

  for (const file of changedFiles ?? []) {
    addFile(file);
  }

  for (const item of provenance ?? []) {
    const path = addFile(item.path);
    const identity = changedFileIdentity(path);
    const existing = provenanceByIdentity.get(identity);
    const sources: ChangedFileSource[] = item.sources.length > 0 ? item.sources : ["agent"];
    if (existing) {
      existing.sources = sortChangedFileSources([...existing.sources, ...sources]);
      existing.references.push(...(item.references ?? []));
    } else {
      provenanceByIdentity.set(identity, {
        sources: sortChangedFileSources(sources),
        references: [...(item.references ?? [])],
      });
    }
  }

  return {
    files,
    provenance: files.map((path) => {
      const record = provenanceByIdentity.get(changedFileIdentity(path));
      if (!record) {
        return { path, sources: ["agent"] };
      }
      const references = [...new Set(record.references)];
      return {
        path,
        sources: record.sources,
        ...(references.length > 0 ? { references } : {}),
      };
    }),
  };
}

export function excludeBaselineChangedFiles(
  changedFiles: { files: string[]; provenance: ChangedFileProvenance[] },
  baselineIdentities: Set<string>,
): { files: string[]; provenance: ChangedFileProvenance[] } {
  if (baselineIdentities.size === 0) {
    return changedFiles;
  }

  return {
    files: changedFiles.files.filter((file) => !baselineIdentities.has(changedFileIdentity(file))),
    provenance: changedFiles.provenance.filter((entry) => !baselineIdentities.has(changedFileIdentity(entry.path))),
  };
}

export function excludeBaselineChangedFileChanges(
  changes: ChangedFileChange[],
  baselineIdentities: Set<string>,
): ChangedFileChange[] {
  if (baselineIdentities.size === 0) {
    return changes;
  }

  return changes.flatMap((change) => {
    if (baselineIdentities.has(changedFileIdentity(change.path))) {
      return [];
    }
    if (
      change.status === "renamed" &&
      change.previousPath &&
      baselineIdentities.has(changedFileIdentity(change.previousPath))
    ) {
      return [{ path: change.path, status: "added" }];
    }
    return [change];
  });
}

export function mergeChangedFiles(
  projectRoot: string,
  current: WorkSessionRecord,
  changedFiles: string[],
  provenance: ChangedFileProvenance[] | undefined,
  pathResolver = createProjectPathResolver(projectRoot),
): { files: string[]; provenance: ChangedFileProvenance[] } {
  const incoming = normalizeChangedFiles(projectRoot, changedFiles, provenance, pathResolver);
  const files: string[] = [];
  const fileByIdentity = new Map<string, string>();
  const provenanceByIdentity = new Map<string, { sources: ChangedFileSource[]; references: string[] }>();

  const addStoredFile = (value: string): string => {
    const identity = changedFileIdentity(value);
    const existing = fileByIdentity.get(identity);
    if (existing) {
      return existing;
    }
    fileByIdentity.set(identity, value);
    files.push(value);
    return value;
  };

  const addProvenance = (item: ChangedFileProvenance, normalizePath: boolean): void => {
    const path = normalizePath
      ? normalizeChangedFilePath(projectRoot, item.path, pathResolver)
      : addStoredFile(item.path);
    const identity = changedFileIdentity(path);
    const existing = provenanceByIdentity.get(identity);
    if (existing) {
      existing.sources = sortChangedFileSources([...existing.sources, ...item.sources]);
      existing.references.push(...(item.references ?? []));
      return;
    }
    provenanceByIdentity.set(identity, {
      sources: sortChangedFileSources(item.sources),
      references: [...(item.references ?? [])],
    });
  };

  for (const file of current.changedFiles) {
    addStoredFile(file);
  }
  for (const item of current.changedFilesProvenance) {
    addProvenance(item, false);
  }
  for (const file of incoming.files) {
    addStoredFile(file);
  }
  for (const item of incoming.provenance) {
    addProvenance(item, false);
  }

  return {
    files,
    // Legacy files without provenance intentionally remain without a fabricated source.
    provenance: files.flatMap((path) => {
      const record = provenanceByIdentity.get(changedFileIdentity(path));
      if (!record) {
        return [];
      }
      const references = [...new Set(record.references)];
      return [
        {
          path,
          sources: record.sources,
          ...(references.length > 0 ? { references } : {}),
        },
      ];
    }),
  };
}

export function toSession(row: SessionRow): WorkSessionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name ?? undefined,
    externalSessionId: row.external_session_id ?? undefined,
    idempotencyKey: row.idempotency_key,
    title: row.title,
    summary: row.summary,
    workSummary: parseWorkSummarySections(row.work_summary_json),
    status: row.status,
    executionStatus: row.execution_status ?? "completed",
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
    commitSha: row.commit_sha ?? undefined,
    gitBranch: row.git_branch ?? undefined,
    changedFiles: parseJson<string[]>(row.changed_files_json, []),
    changedFilesProvenance: parseJson<ChangedFileProvenance[]>(row.changed_files_provenance_json, []),
    changedFileChanges: parseJson<ChangedFileChange[]>(row.changed_file_changes_json, []),
    verification: parseJson<VerificationSummary | undefined>(row.verification_json, undefined),
    ...(row.voided_at ? { voided: { at: row.voided_at, reason: row.void_reason ?? "" } } : {}),
  };
}

export function toEvent(row: EventRow): WorkEventRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    type: row.type,
    summary: row.summary,
    details: parseJson<Record<string, unknown> | undefined>(row.details_json, undefined),
    occurredAt: row.occurred_at,
  };
}

export function toSnapshot(row: SnapshotRow): RawSnapshotRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    projectId: row.project_id,
    kind: row.kind,
    sourcePath: row.source_path ?? undefined,
    content: row.content,
    capturedAt: row.captured_at,
  };
}

export function toEvidence(row: EvidenceRow): EvidenceRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    projectId: row.project_id,
    kind: row.kind,
    reference: row.reference,
    summary: row.summary ?? undefined,
    capturedAt: row.captured_at,
    ...(row.voided_at ? { voided: { at: row.voided_at, reason: row.void_reason ?? "" } } : {}),
  };
}

export type VoidAuditRow = {
  id: string;
  target_type: VoidTargetType;
  target_id: string;
  action: "voided" | "restored";
  reason: string | null;
  occurred_at: string;
};

export function toVoidAudit(row: VoidAuditRow): VoidAuditRecord {
  return {
    id: row.id,
    targetType: row.target_type,
    targetId: row.target_id,
    action: row.action,
    ...(row.reason ? { reason: row.reason } : {}),
    occurredAt: row.occurred_at,
  };
}

export type VerificationUpdateRow = {
  id: string;
  source: VerificationUpdateSource;
  previous_json: string | null;
  resulting_json: string;
  created_at: string;
};

export function toVerificationUpdate(row: VerificationUpdateRow): VerificationUpdateRecord {
  const previous = parseJson<VerificationSummary | undefined>(row.previous_json, undefined);
  return {
    id: row.id,
    source: row.source,
    ...(previous ? { previous } : {}),
    resulting: parseJson<VerificationSummary>(row.resulting_json, { status: "not_run" }),
    createdAt: row.created_at,
  };
}

export function normalizeVerification(verification: VerificationSummary): VerificationSummary {
  const summary = verification.summary?.trim();
  return { status: verification.status, ...(summary ? { summary } : {}) };
}

export function sameVerification(left: VerificationSummary | undefined, right: VerificationSummary): boolean {
  return left?.status === right.status && (left.summary?.trim() || undefined) === right.summary;
}

/**
 * The reported start wins when it is not after completion; otherwise the earliest event recorded
 * before completion. No start is invented when neither exists.
 */
export function resolveStartedAt(
  reported: string | undefined,
  events: ReadonlyArray<{ occurredAt?: string }> | undefined,
  completedAt: string,
): string | undefined {
  if (reported && reported <= completedAt) {
    return reported;
  }
  const earliest = (events ?? [])
    .map((event) => event.occurredAt)
    .filter((value): value is string => Boolean(value) && value! < completedAt)
    .sort()[0];
  return earliest;
}

/** Voiding needs a reason so the audit explains it; a restore reason is optional. */
export function requireVoidReason(voided: boolean, reason: string | undefined): string | undefined {
  const trimmed = reason?.trim();
  if (voided && !trimmed) {
    throw new Error("A reason is required to void a record.");
  }
  return trimmed || undefined;
}

export function toKnowledge(row: KnowledgeRow): KnowledgeRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name ?? undefined,
    sessionId: row.session_id ?? undefined,
    idempotencyKey: row.idempotency_key,
    kind: row.kind,
    title: row.title,
    body: row.body,
    tags: parseJson<string[]>(row.tags_json, []),
    references: parseJson<string[]>(row.references_json, []),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    appliesTo: parseJson<string[]>(row.applies_to_json ?? null, []),
    ...(row.last_confirmed_at ? { lastConfirmedAt: row.last_confirmed_at } : {}),
    ...(row.last_confirmed_session_id ? { lastConfirmedSessionId: row.last_confirmed_session_id } : {}),
    ...(row.supersedes_id ? { supersedesId: row.supersedes_id } : {}),
    ...(row.review_json
      ? { review: parseJson<KnowledgeReview>(row.review_json, { reason: "contradicted", at: "" }) }
      : {}),
  };
}

/** Audit snapshots written before appliesTo existed lack it; default it so readers can rely on it. */
export function withKnowledgeDefaults(record: KnowledgeRecord): KnowledgeRecord {
  return { ...record, appliesTo: record.appliesTo ?? [] };
}

export function cleanList(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim().replace(/\\/g, "/")).filter(Boolean))];
}

export function toKnowledgeAudit(row: KnowledgeAuditRow): KnowledgeAuditRecord {
  const after = parseJson<KnowledgeRecord | undefined>(row.after_json, undefined);
  if (!after) {
    throw new Error(`Knowledge audit record ${row.id} has an invalid after snapshot.`);
  }

  const before = parseJson<KnowledgeRecord | undefined>(row.before_json, undefined);
  return {
    id: row.id,
    knowledgeId: row.knowledge_id,
    projectId: row.project_id,
    action: row.action,
    ...(before ? { before: withKnowledgeDefaults(before) } : {}),
    after: withKnowledgeDefaults(after),
    changedFields: parseJson<string[]>(row.changed_fields_json, []),
    occurredAt: row.occurred_at,
  };
}

export function getVerificationFollowUp(session: WorkSessionRecord): VerificationFollowUp | undefined {
  if (session.verification?.status === "passed" || session.verification?.status === "failed") {
    return undefined;
  }
  const message =
    session.verification?.status === "not_run"
      ? "Verification is marked not_run. Re-check the completed work and call work_update_session_metadata with passed or failed when a confirmed result is available; keep not_run only when no verification was actually executed."
      : "Verification was not supplied. If verification was completed, call work_update_session_metadata with this sessionId and the confirmed result; otherwise explicitly report status not_run.";
  return {
    required: true,
    sessionId: session.id,
    message,
  };
}

export function getChangedFilesFollowUp(session: WorkSessionRecord): ChangedFilesFollowUp | undefined {
  if (session.changedFiles.length > 0) {
    return undefined;
  }
  return {
    required: true,
    sessionId: session.id,
    message:
      "No changedFiles metadata was supplied. Inspect the working tree and worktree diff before finishing; call work_update_session_metadata with the confirmed file list, using [] only when the work intentionally changed no files.",
  };
}

export function getWorkSummaryFollowUp(session: WorkSessionRecord): WorkSummaryFollowUp | undefined {
  if (session.workSummary) {
    return undefined;
  }
  return {
    required: true,
    sessionId: session.id,
    message:
      "Work summary sections were not supplied. Provide outcomes (confirmed results), scope (important changed areas), decisions (explicit choices only), verification (actual results and unverified coverage), and nextSteps (objective current open state/limitations only; no future recommendations) as concise arrays. Use [] when a section has no supported facts.",
  };
}
