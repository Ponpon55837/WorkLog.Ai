import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  AttachDiagramInput,
  AttachDiagramResult,
  DiagramContentInput,
  PolicyDecision,
  RedactionSummary,
  SessionDiagramKind,
  SessionDiagramRecord,
  SetDiagramVoidInput,
  SetDiagramVoidResult,
} from "@work-intelligence/core";
import { nowIso } from "@work-intelligence/shared";
import { combineRedactionSummaries, redactValue } from "./secret-redaction.js";
import { redactDiagramSource } from "./diagram-source-redaction.js";
import { runImmediateTransaction } from "./sqlite-transaction.js";

export interface DiagramDependencies {
  checkProjectById(projectId: string): PolicyDecision;
}

interface DiagramRow {
  id: string;
  session_id: string;
  project_id: string;
  idempotency_key: string;
  title: string;
  kind: SessionDiagramKind;
  format_version: number;
  source: string;
  created_at: string;
  voided_at: string | null;
  void_reason: string | null;
}

function toDiagram(row: DiagramRow): SessionDiagramRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    projectId: row.project_id,
    title: row.title,
    kind: row.kind,
    formatVersion: row.format_version,
    source: row.source,
    createdAt: row.created_at,
    ...(row.voided_at ? { voided: { at: row.voided_at, reason: row.void_reason ?? "" } } : {}),
  };
}

function skipped(decision: PolicyDecision) {
  return {
    outcome: "skipped" as const,
    projectRoot: decision.canonicalRoot,
    projectStatus: decision.projectStatus,
    reason: decision.reason ?? "Project recording is not enabled.",
  };
}

/** Diagrams attached to Sessions. Sources are masked like every other saved text; diagrams are voided, never deleted. */
export class DiagramService {
  public constructor(
    private readonly db: DatabaseSync,
    private readonly dependencies: DiagramDependencies,
  ) {}

  public attach(input: AttachDiagramInput): AttachDiagramResult {
    const session = this.db
      .prepare("SELECT project_id FROM sessions WHERE id = ? AND voided_at IS NULL")
      .get(input.sessionId) as { project_id: string } | undefined;
    if (!session) {
      return { outcome: "not_found", sessionId: input.sessionId };
    }
    const decision = this.dependencies.checkProjectById(session.project_id);
    if (!decision.allowed) {
      return skipped(decision);
    }
    return runImmediateTransaction(this.db, () => {
      const { diagram, duplicate, redactions, conflict } = this.write(
        input.sessionId,
        session.project_id,
        input,
        nowIso(),
      );
      if (conflict) {
        return {
          outcome: "idempotency_conflict",
          reason: "This idempotencyKey already saved a different diagram for the Session; use a new key.",
        };
      }
      return {
        outcome: "diagram_attached",
        duplicate,
        diagram,
        ...(redactions.total > 0 ? { redactions } : {}),
      };
    });
  }

  /** Diagrams sent with finalize, written inside its transaction with keys derived from the finalize key. */
  public attachWithFinalize(
    sessionId: string,
    projectId: string,
    finalizeKey: string,
    diagrams: ReadonlyArray<DiagramContentInput>,
    createdAt: string,
  ): RedactionSummary | undefined {
    let summary: RedactionSummary | undefined;
    diagrams.forEach((diagram, index) => {
      const { redactions } = this.write(
        sessionId,
        projectId,
        { ...diagram, idempotencyKey: `${finalizeKey}:diagram:${index}` },
        createdAt,
      );
      summary = summary ? combineRedactionSummaries(summary, redactions) : redactions;
    });
    return summary;
  }

  public listForSession(sessionId: string): SessionDiagramRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM session_diagrams WHERE session_id = ? ORDER BY created_at ASC, rowid ASC")
        .all(sessionId) as unknown as DiagramRow[]
    ).map(toDiagram);
  }

  public setVoid(input: SetDiagramVoidInput): SetDiagramVoidResult {
    const row = this.db.prepare("SELECT * FROM session_diagrams WHERE id = ?").get(input.diagramId) as
      DiagramRow | undefined;
    if (!row) {
      return { outcome: "not_found", diagramId: input.diagramId };
    }
    const decision = this.dependencies.checkProjectById(row.project_id);
    if (!decision.allowed) {
      return skipped(decision);
    }
    const reason = input.voided ? redactValue(input.reason?.trim() ?? "").value : null;
    this.db
      .prepare("UPDATE session_diagrams SET voided_at = ?, void_reason = ? WHERE id = ?")
      .run(input.voided ? nowIso() : null, reason, row.id);
    const updated = this.db.prepare("SELECT * FROM session_diagrams WHERE id = ?").get(row.id) as unknown as DiagramRow;
    return { outcome: "diagram_void_updated", diagram: toDiagram(updated) };
  }

  private write(
    sessionId: string,
    projectId: string,
    input: DiagramContentInput & { idempotencyKey: string },
    createdAt: string,
  ): { diagram: SessionDiagramRecord; duplicate: boolean; redactions: RedactionSummary; conflict: boolean } {
    const kind = input.kind ?? "mermaid";
    const formatVersion = input.formatVersion ?? 1;
    const title = redactValue(input.title.trim());
    const source = redactDiagramSource(input.source, kind);
    const masked = {
      value: { title: title.value, source: source.value },
      redactions: combineRedactionSummaries(title.redactions, source.redactions),
    };
    const existing = this.db
      .prepare("SELECT * FROM session_diagrams WHERE session_id = ? AND idempotency_key = ?")
      .get(sessionId, input.idempotencyKey) as DiagramRow | undefined;
    if (existing) {
      const same =
        existing.title === masked.value.title &&
        existing.source === masked.value.source &&
        existing.kind === kind &&
        existing.format_version === formatVersion;
      return { diagram: toDiagram(existing), duplicate: true, redactions: masked.redactions, conflict: !same };
    }
    const row: DiagramRow = {
      id: randomUUID(),
      session_id: sessionId,
      project_id: projectId,
      idempotency_key: input.idempotencyKey,
      title: masked.value.title,
      kind,
      format_version: formatVersion,
      source: masked.value.source,
      created_at: createdAt,
      voided_at: null,
      void_reason: null,
    };
    this.db
      .prepare(
        `INSERT INTO session_diagrams (id, session_id, project_id, idempotency_key, title, kind, format_version, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        sessionId,
        projectId,
        row.idempotency_key,
        row.title,
        row.kind,
        row.format_version,
        row.source,
        createdAt,
      );
    return { diagram: toDiagram(row), duplicate: false, redactions: masked.redactions, conflict: false };
  }
}
