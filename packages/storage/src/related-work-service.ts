import type { DatabaseSync } from "node:sqlite";
import type { RelatedWorkResult } from "@work-intelligence/core";
import { truncateText } from "@work-intelligence/shared";
import { parseJson } from "./session-record-codecs.js";
import { normalizePath, type PathContext } from "./search-text.js";
import { runImmediateTransaction } from "./sqlite-transaction.js";

type Source = {
  id: string;
  project_id: string;
  name: string;
  root_path: string;
  title: string;
  completed_at: string;
  changed_files_json: string;
  changed_files_confirmed: number;
};
type Ranked = { row: Source; shared: string[]; union: number };
const POSTING_LIMIT = 1000;

function compare(a: Ranked, b: Ranked): number {
  return (
    b.shared.length - a.shared.length ||
    b.shared.length * a.union - a.shared.length * b.union ||
    b.row.completed_at.localeCompare(a.row.completed_at) ||
    a.row.id.localeCompare(b.row.id)
  );
}

function paths(json: string, context: PathContext[]): Set<string> {
  return new Set(
    parseJson<string[]>(json, [])
      .map((p) => normalizePath(p, context))
      .filter((p) => Boolean(p) && !/^(?:\/|[a-z]:\/)/i.test(p)),
  );
}

/** Same-project file overlap is an exploration hint, never an automatically created relation. */
export class RelatedWorkService {
  public constructor(private readonly db: DatabaseSync) {}

  public get(sessionId: string): RelatedWorkResult {
    const result: RelatedWorkResult = {
      outcome: "related_work",
      sessionId,
      state: "unavailable",
      reason: "source_unavailable",
      coverage: { partial: false, postingLimit: POSTING_LIMIT, examined: 0 },
      items: [],
    };
    const source = this.db
      .prepare(
        `SELECT s.id,s.project_id,s.changed_files_json,s.changed_files_confirmed,p.name,p.root_path FROM sessions s JOIN projects p ON p.id=s.project_id WHERE s.id=? AND p.status='tracked' AND s.voided_at IS NULL`,
      )
      .get(sessionId) as Source | undefined;
    if (!source) return result;
    if (!source.changed_files_confirmed) return { ...result, reason: "files_unconfirmed" };
    const raw = parseJson<string[]>(source.changed_files_json, []);
    if (raw.length > 20) return { ...result, reason: "too_many_files" };
    const context = [{ name: source.name, rootPath: source.root_path }];
    const focus = paths(source.changed_files_json, context);
    if (!focus.size) return { ...result, reason: "no_files" };
    // Limit indexing to this opted-in project. Index synchronization cost is part of the read path.
    this.syncPaths(source.project_id, context);
    const clauses = [...focus].map(
      () => `SELECT * FROM (SELECT sp.doc_id, ? AS hit_path FROM related_work_paths sp
      JOIN sessions s ON s.id=sp.doc_id
      WHERE sp.project_id=? AND sp.path=? AND sp.doc_id<>?
        AND s.project_id=? AND s.voided_at IS NULL AND s.changed_files_confirmed=1 AND json_array_length(s.changed_files_json) BETWEEN 1 AND 20
        AND NOT EXISTS (SELECT 1 FROM session_links l WHERE l.session_id=? AND l.related_session_id=s.id)
        AND NOT EXISTS (SELECT 1 FROM session_links l WHERE l.related_session_id=? AND l.session_id=s.id)
      ORDER BY sp.doc_date DESC, sp.doc_id LIMIT ?)`,
    );
    const values = [...focus].flatMap((p) => [
      p,
      source.project_id,
      p,
      sessionId,
      source.project_id,
      sessionId,
      sessionId,
      POSTING_LIMIT + 1,
    ]);
    const postings = this.db.prepare(clauses.join(" UNION ALL ")).all(...values) as Array<{
      doc_id: string;
      hit_path: string;
    }>;
    const counts = new Map<string, number>();
    const candidates = new Set<string>();
    let partial = false;
    for (const hit of postings) {
      const count = (counts.get(hit.hit_path) ?? 0) + 1;
      counts.set(hit.hit_path, count);
      if (count > POSTING_LIMIT) partial = true;
      else candidates.add(hit.doc_id);
    }
    const ids = [...candidates];
    const best: Ranked[] = [];
    for (let offset = 0; offset < ids.length; offset += 500) {
      const batch = ids.slice(offset, offset + 500);
      const rows = this.db
        .prepare(
          `SELECT id,title,completed_at,changed_files_json FROM sessions WHERE id IN (${batch.map(() => "?").join(",")}) AND project_id=? AND voided_at IS NULL`,
        )
        .all(...batch, source.project_id) as Source[];
      for (const row of rows) {
        const candidate = paths(row.changed_files_json, context);
        const shared = [...focus].filter((p) => candidate.has(p)).sort();
        if (!shared.length) continue;
        const item = { row, shared, union: focus.size + candidate.size - shared.length };
        const position = best.findIndex((other) => compare(item, other) < 0);
        best.splice(position < 0 ? best.length : position, 0, item);
        if (best.length > 5) best.pop();
      }
    }
    return {
      ...result,
      state: "ready",
      reason: undefined,
      coverage: { partial, postingLimit: POSTING_LIMIT, examined: ids.length },
      items: best.map(({ row, shared }) => ({
        id: row.id,
        title: truncateText(row.title, 160),
        completedAt: row.completed_at,
        sharedCount: shared.length,
        sharedPaths: shared.slice(0, 3).map((p) => truncateText(p, 240)),
        pathsOmitted: Math.max(shared.length - 3, 0),
      })),
    };
  }
  /** Rebuild only normalized file postings, without raw handoff or FTS tokenization. */
  private syncPaths(projectId: string, context: PathContext[]): void {
    if (!this.db.prepare(`SELECT 1 FROM related_work_dirty WHERE project_id=? LIMIT 1`).get(projectId)) return;
    runImmediateTransaction(this.db, () => {
      const dirty = this.db
        .prepare(
          `SELECT s.id,s.changed_files_json,s.changed_files_confirmed,s.voided_at,s.completed_at FROM related_work_dirty d JOIN sessions s ON s.id=d.session_id JOIN projects p ON p.id=s.project_id WHERE d.project_id=? AND s.project_id=d.project_id AND p.status='tracked'`,
        )
        .all(projectId) as Array<{
        id: string;
        changed_files_json: string;
        changed_files_confirmed: number;
        voided_at: string | null;
        completed_at: string;
      }>;
      const ids = JSON.stringify(dirty.map((row) => row.id));
      this.db.prepare(`DELETE FROM related_work_paths WHERE doc_id IN (SELECT value FROM json_each(?))`).run(ids);
      const insert = this.db.prepare(
        `INSERT INTO related_work_paths (doc_id,project_id,path,doc_date) VALUES (?,?,?,?)`,
      );
      for (const row of dirty) {
        const raw = parseJson<string[]>(row.changed_files_json, []);
        if (row.voided_at || !row.changed_files_confirmed || raw.length > 20) continue;
        for (const path of paths(row.changed_files_json, context))
          insert.run(row.id, projectId, path, row.completed_at);
      }
      this.db.prepare(`DELETE FROM related_work_dirty WHERE session_id IN (SELECT value FROM json_each(?))`).run(ids);
    });
  }
}
