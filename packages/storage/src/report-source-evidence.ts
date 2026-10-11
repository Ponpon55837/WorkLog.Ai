import { DatabaseSync } from "node:sqlite";
import type { ReportEvidence, WorkSessionRecord } from "@work-intelligence/core";
import { verificationStatusLabel, type ReportEventRow } from "./report-utils.js";

type SnapshotRow = { session_id: string; source_path: string | null };
type EvidenceRow = {
  session_id: string;
  kind: string;
  reference: string;
  summary: string | null;
  session_title: string;
  project_name: string | null;
};

/** Rebuilds evidence for one eligible source page, independently of the current period's latest window. */
export function getSourceReportEvidence(db: DatabaseSync, sessions: WorkSessionRecord[]): ReportEvidence[] {
  if (!sessions.length) return [];
  const ids = sessions.map((session) => session.id);
  const placeholders = ids.map(() => "?").join(", ");
  const snapshots = db
    .prepare(
      `SELECT rs.session_id, rs.source_path FROM raw_snapshots rs
    CROSS JOIN projects p ON p.id = rs.project_id WHERE p.status = 'tracked' AND rs.session_id IN (${placeholders})
    ORDER BY rs.captured_at ASC, rs.id ASC`,
    )
    .all(...ids) as SnapshotRow[];
  const snapshotsBySession = new Map(snapshots.map((row) => [row.session_id, row]));
  const events = db
    .prepare(
      `SELECT e.*, s.project_id FROM work_events e
    CROSS JOIN sessions s ON s.id = e.session_id CROSS JOIN projects p ON p.id = s.project_id
    WHERE p.status = 'tracked' AND e.session_id IN (${placeholders}) AND e.type IN ('verification', 'note', 'closing')
    ORDER BY e.occurred_at ASC, e.id ASC`,
    )
    .all(...ids) as unknown as ReportEventRow[];
  const eventsBySession = new Map<string, ReportEventRow[]>();
  for (const event of events) {
    const group = eventsBySession.get(event.session_id) ?? [];
    group.push(event);
    eventsBySession.set(event.session_id, group);
  }
  const attachedEvidenceRows = db
    .prepare(
      `SELECT e.*, s.title AS session_title, p.name AS project_name FROM evidence e
    CROSS JOIN sessions s ON s.id = e.session_id CROSS JOIN projects p ON p.id = e.project_id
    WHERE p.status = 'tracked' AND e.voided_at IS NULL AND e.session_id IN (${placeholders})
    ORDER BY e.captured_at ASC, e.id ASC`,
    )
    .all(...ids) as EvidenceRow[];
  return buildSourceReportEvidence(sessions, snapshotsBySession, eventsBySession, attachedEvidenceRows);
}

export function buildSourceReportEvidence(
  sessions: WorkSessionRecord[],
  snapshotsBySession: ReadonlyMap<string, SnapshotRow>,
  eventsBySession: ReadonlyMap<string, ReportEventRow[]>,
  attachedEvidenceRows: readonly EvidenceRow[],
): ReportEvidence[] {
  const evidence: ReportEvidence[] = [];
  for (const session of sessions) {
    const snapshot = snapshotsBySession.get(session.id);
    if (snapshot) {
      evidence.push({
        sessionId: session.id,
        sessionTitle: session.title,
        projectName: session.projectName,
        kind: "handoff",
        label: "Handoff snapshot",
        detail: "Closing handoff 已保存為 raw snapshot。",
        reference: snapshot.source_path ?? "captured handoff",
      });
    }
    if (session.verification) {
      evidence.push({
        sessionId: session.id,
        sessionTitle: session.title,
        projectName: session.projectName,
        kind: "verification",
        label: `Verification ${verificationStatusLabel(session.verification.status)}`,
        detail: session.verification.summary ?? "Agent 提供了 verification 狀態。",
      });
    }
    if (session.changedFiles.length) {
      evidence.push({
        sessionId: session.id,
        sessionTitle: session.title,
        projectName: session.projectName,
        kind: "changed-files",
        label: "Changed files metadata",
        detail: `記錄 ${session.changedFiles.length} 個檔案變更；不等同 Git commit。`,
        reference: session.changedFiles.slice(0, 3).join(", "),
      });
    }
    const primaryEvent = (eventsBySession.get(session.id) ?? []).find(
      (event) => event.type === "verification" || event.type === "note" || event.type === "closing",
    );
    if (primaryEvent) {
      evidence.push({
        sessionId: session.id,
        sessionTitle: session.title,
        projectName: session.projectName,
        kind: "event",
        label: `${primaryEvent.type} event`,
        detail: primaryEvent.summary,
        reference: primaryEvent.id,
      });
    }
  }
  for (const item of attachedEvidenceRows) {
    evidence.push({
      sessionId: item.session_id,
      sessionTitle: item.session_title,
      projectName: item.project_name ?? undefined,
      kind: "attached",
      label: `Evidence · ${item.kind}`,
      detail: item.summary ?? item.reference,
      reference: item.reference,
    });
  }

  return evidence;
}
