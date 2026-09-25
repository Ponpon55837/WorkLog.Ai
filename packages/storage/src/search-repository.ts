import type { DatabaseSync } from "node:sqlite";
import type { KnowledgeKind, RecallField, RecallHit, RecallTermHits } from "@work-intelligence/core";
import { truncateText } from "@work-intelligence/shared";
import {
  excerptAround,
  ftsTermExpression,
  normalizePath,
  normalizeReference,
  parseQueryWords,
  pathBasename,
  pathMatchStrength,
  splitMarkdownSections,
  tokenize,
  type PathContext,
} from "./search-text.js";
import { LIKE_ESCAPE, likeContainsPattern } from "./sql-like.js";
import { runImmediateTransaction } from "./sqlite-transaction.js";

type DocType = "session" | "knowledge";

/*
 * Ranking: FTS5 BM25 per chunk × field weight, summed per document, with only the best raw handoff
 * section counted (long snapshots would otherwise match everything). The sum is multiplied by the
 * squared IDF-weighted share of query terms the document contains, so records matching most words
 * outrank those matching one common word. Path matches add a fixed score; recency is a mild factor.
 */
const FIELD_WEIGHTS: Record<Exclude<RecallField, "path">, number> = {
  title: 3,
  tags: 2,
  summary: 1.5,
  workSummary: 1.5,
  body: 1.5,
  changedFiles: 1,
  branch: 1,
  event: 1,
  references: 1,
  raw: 0.5,
};
// Sessions listing more changed files than this are likely polluted by unrelated dirty worktrees.
const CHANGED_FILES_NORMAL = 20;
const PATH_WEIGHT = 4;
const RECENCY_DAYS = 180;
const MAX_QUERY_TERMS = 32;
const EXCERPT_LENGTH = 220;

interface ChunkInput {
  field: Exclude<RecallField, "path">;
  heading?: string;
  content: string;
  weight: number;
}

interface IndexedDocument {
  projectId: string;
  date: string;
  chunks: ChunkInput[];
  paths: Array<{ path: string; weight: number }>;
}

interface ScoredChunkRow {
  id: number;
  doc_type: DocType;
  doc_id: string;
  project_id: string;
  field: Exclude<RecallField, "path">;
  heading: string | null;
  weight: number;
  doc_date: string;
  score: number;
}

interface PathRow {
  doc_type: DocType;
  doc_id: string;
  project_id: string;
  path: string;
  weight: number;
  doc_date: string;
}

interface DocAccumulator {
  type: DocType;
  id: string;
  projectId: string;
  date: string;
  fieldScore: number;
  fields: Map<RecallField, number>;
  bestChunk?: { id: number; score: number; field: RecallField };
  bestRaw?: { id: number; score: number; heading: string };
  terms: Set<number>;
  pathScore: number;
  matchedPaths: Set<string>;
}

export interface RecallOptions {
  q?: string;
  paths?: string[];
  projectId?: string;
  types?: DocType[];
  limit: number;
}

export interface RecallComputation {
  hits: RecallHit[];
  termHits?: RecallTermHits[];
}

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseSections(value: string | null): Array<[string, string[]]> {
  if (!value) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") {
      return [];
    }
    return Object.entries(parsed as Record<string, unknown>).map(([key, items]) => [
      key,
      Array.isArray(items) ? items.filter((item): item is string => typeof item === "string") : [],
    ]);
  } catch {
    return [];
  }
}

function docKey(type: DocType, id: string): string {
  return `${type}:${id}`;
}

/** Retrieval index over Sessions (with raw handoff sections) and Knowledge, kept in sync lazily. */
export class SearchRepository {
  public constructor(private readonly db: DatabaseSync) {}

  /** Re-indexes documents marked dirty by the write triggers. */
  public syncIndex(): void {
    const pending = this.db.prepare("SELECT 1 FROM search_dirty LIMIT 1").get();
    if (!pending) {
      return;
    }
    runImmediateTransaction(this.db, () => {
      const dirty = this.db.prepare("SELECT doc_type, doc_id FROM search_dirty").all() as Array<{
        doc_type: DocType;
        doc_id: string;
      }>;
      const clearDirty = this.db.prepare("DELETE FROM search_dirty WHERE doc_type = ? AND doc_id = ?");
      for (const row of dirty) {
        this.removeDocument(row.doc_type, row.doc_id);
        const document = row.doc_type === "session" ? this.loadSession(row.doc_id) : this.loadKnowledge(row.doc_id);
        if (document) {
          this.insertDocument(row.doc_type, row.doc_id, document);
        }
        clearDirty.run(row.doc_type, row.doc_id);
      }
    });
  }

  public recall(options: RecallOptions): RecallComputation {
    this.syncIndex();
    const words = options.q ? parseQueryWords(options.q) : [];
    const terms = [...new Set(words.flatMap((word) => word.terms))].slice(0, MAX_QUERY_TERMS);
    const contexts = this.pathContexts(options.projectId);
    const queriedPaths = [
      ...new Set((options.paths ?? []).map((path) => normalizePath(path, contexts)).filter(Boolean)),
    ];
    const docs = new Map<string, DocAccumulator>();
    const accumulator = (type: DocType, id: string, projectId: string, date: string): DocAccumulator => {
      const key = docKey(type, id);
      let doc = docs.get(key);
      if (!doc) {
        doc = {
          type,
          id,
          projectId,
          date,
          fieldScore: 0,
          fields: new Map(),
          terms: new Set(),
          pathScore: 0,
          matchedPaths: new Set(),
        };
        docs.set(key, doc);
      }
      return doc;
    };

    const { idf, totalIdf } =
      terms.length > 0 ? this.scoreTerms(terms, accumulator, options) : { idf: [], totalIdf: 0 };
    if (queriedPaths.length > 0) {
      this.scorePaths(queriedPaths, accumulator, options);
    }

    const now = Date.now();
    const ranked = [...docs.values()]
      .map((doc) => {
        let matchedIdf = 0;
        for (const index of doc.terms) {
          matchedIdf += idf[index] ?? 0;
        }
        const coverage = totalIdf > 0 ? matchedIdf / totalIdf : 0;
        const textScore = (doc.fieldScore + (doc.bestRaw?.score ?? 0)) * coverage * coverage;
        const ageDays = Math.max(0, (now - Date.parse(doc.date)) / 86_400_000) || 0;
        const recency = 0.75 + 0.25 * Math.exp(-ageDays / RECENCY_DAYS);
        return { doc, score: (textScore + doc.pathScore) * recency };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || right.doc.date.localeCompare(left.doc.date))
      .slice(0, options.limit);

    const excerptTerms = terms
      .map((term, index) => ({ term, idf: idf[index] ?? 0 }))
      .sort((left, right) => right.idf - left.idf)
      .map((entry) => entry.term);
    const hits = ranked.flatMap(({ doc, score }) => {
      const hit = this.toHit(doc, score, excerptTerms);
      return hit ? [hit] : [];
    });

    const termHits = words.map((word) => {
      const indexes = word.terms.map((term) => terms.indexOf(term)).filter((index) => index >= 0);
      let count = 0;
      for (const doc of docs.values()) {
        if (indexes.length > 0 && indexes.every((index) => doc.terms.has(index))) {
          count += 1;
        }
      }
      return { term: word.word, count };
    });
    return {
      hits,
      ...(termHits.some((entry) => entry.count === 0) ? { termHits } : {}),
    };
  }

  /** Removes every cached retrieval row for a project and its source documents. Call inside the delete transaction. */
  public deleteProjectDocuments(
    projectId: string,
    sessionIds: string[],
    knowledgeIds: string[],
  ): { chunks: number; fts: number; paths: number; dirty: number } {
    const indexedDocuments = this.db
      .prepare(
        `SELECT doc_type, doc_id FROM search_chunks WHERE project_id = ?
         UNION SELECT doc_type, doc_id FROM search_paths WHERE project_id = ?`,
      )
      .all(projectId, projectId) as Array<{ doc_type: DocType; doc_id: string }>;
    const documents = new Map<string, { type: DocType; id: string }>();
    for (const document of indexedDocuments) {
      documents.set(docKey(document.doc_type, document.doc_id), { type: document.doc_type, id: document.doc_id });
    }
    for (const id of sessionIds) {
      documents.set(docKey("session", id), { type: "session", id });
    }
    for (const id of knowledgeIds) {
      documents.set(docKey("knowledge", id), { type: "knowledge", id });
    }

    const sessionIdJson = JSON.stringify([
      ...new Set([
        ...sessionIds,
        ...indexedDocuments.filter((document) => document.doc_type === "session").map((document) => document.doc_id),
      ]),
    ]);
    const knowledgeIdJson = JSON.stringify([
      ...new Set([
        ...knowledgeIds,
        ...indexedDocuments.filter((document) => document.doc_type === "knowledge").map((document) => document.doc_id),
      ]),
    ]);
    const chunks = (
      this.db.prepare("SELECT COUNT(*) AS count FROM search_chunks WHERE project_id = ?").get(projectId) as {
        count: number;
      }
    ).count;
    const fts = (
      this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM search_fts f JOIN search_chunks c ON c.id = f.rowid WHERE c.project_id = ?",
        )
        .get(projectId) as { count: number }
    ).count;
    const paths = (
      this.db.prepare("SELECT COUNT(*) AS count FROM search_paths WHERE project_id = ?").get(projectId) as {
        count: number;
      }
    ).count;
    const dirtyPredicate = `
      (doc_type = 'session' AND doc_id IN (SELECT value FROM json_each(?)))
      OR (doc_type = 'knowledge' AND doc_id IN (SELECT value FROM json_each(?)))`;
    const dirty = (
      this.db
        .prepare(`SELECT COUNT(*) AS count FROM search_dirty WHERE ${dirtyPredicate}`)
        .get(sessionIdJson, knowledgeIdJson) as {
        count: number;
      }
    ).count;

    for (const document of documents.values()) {
      this.removeDocument(document.type, document.id);
    }
    this.db.prepare(`DELETE FROM search_dirty WHERE ${dirtyPredicate}`).run(sessionIdJson, knowledgeIdJson);
    return { chunks, fts, paths, dirty };
  }

  private scoreTerms(
    terms: string[],
    accumulator: (type: DocType, id: string, projectId: string, date: string) => DocAccumulator,
    options: RecallOptions,
  ): { idf: number[]; totalIdf: number } {
    const totalChunks = (this.db.prepare("SELECT COUNT(*) AS count FROM search_chunks").get() as { count: number })
      .count;
    const matchStatement = this.db.prepare("SELECT rowid AS id FROM search_fts WHERE search_fts MATCH ?");
    const termSets = terms.map(
      (term) => new Set((matchStatement.all(ftsTermExpression(term)) as Array<{ id: number }>).map((row) => row.id)),
    );
    const idf = termSets.map((set) =>
      set.size === 0 ? 0 : Math.log(1 + (totalChunks - set.size + 0.5) / (set.size + 0.5)),
    );
    const totalIdf = idf.reduce((sum, value) => sum + value, 0);
    if (totalIdf === 0) {
      return { idf, totalIdf };
    }

    const { clause, parameters } = this.scopeClause("c", options);
    const rows = this.db
      .prepare(
        `SELECT c.id, c.doc_type, c.doc_id, c.project_id, c.field, c.heading, c.weight, c.doc_date,
                -bm25(search_fts) AS score
         FROM search_fts
         JOIN search_chunks c ON c.id = search_fts.rowid
         JOIN projects p ON p.id = c.project_id
         LEFT JOIN knowledge k ON c.doc_type = 'knowledge' AND k.id = c.doc_id
         WHERE search_fts MATCH ? AND ${clause}`,
      )
      .all(terms.map(ftsTermExpression).join(" OR "), ...parameters) as unknown as ScoredChunkRow[];

    for (const row of rows) {
      const doc = accumulator(row.doc_type, row.doc_id, row.project_id, row.doc_date);
      termSets.forEach((set, index) => {
        if (set.has(row.id)) {
          doc.terms.add(index);
        }
      });
      const score = Math.max(0, row.score) * row.weight;
      if (row.field === "raw") {
        if (!doc.bestRaw || score > doc.bestRaw.score) {
          doc.bestRaw = { id: row.id, score, heading: row.heading ?? "" };
        }
      } else {
        doc.fieldScore += score;
        if (row.field !== "title" && (!doc.bestChunk || score > doc.bestChunk.score)) {
          doc.bestChunk = { id: row.id, score, field: row.field };
        }
      }
      doc.fields.set(row.field, (doc.fields.get(row.field) ?? 0) + score);
    }
    return { idf, totalIdf };
  }

  private scorePaths(
    queriedPaths: string[],
    accumulator: (type: DocType, id: string, projectId: string, date: string) => DocAccumulator,
    options: RecallOptions,
  ): void {
    const { clause, parameters } = this.scopeClause("sp", options);
    const statement = this.db.prepare(
      `SELECT sp.doc_type, sp.doc_id, sp.project_id, sp.path, sp.weight, sp.doc_date
       FROM search_paths sp
       JOIN projects p ON p.id = sp.project_id
       LEFT JOIN knowledge k ON sp.doc_type = 'knowledge' AND k.id = sp.doc_id
       WHERE (sp.basename = ? OR sp.path LIKE ? ${LIKE_ESCAPE}) AND ${clause}`,
    );
    for (const queried of queriedPaths) {
      const best = new Map<string, { row: PathRow; strength: number }>();
      const rows = statement.all(
        pathBasename(queried),
        likeContainsPattern(`${queried}/`),
        ...parameters,
      ) as unknown as PathRow[];
      for (const row of rows) {
        const strength = pathMatchStrength(row.path, queried) * row.weight;
        const key = docKey(row.doc_type, row.doc_id);
        if (strength > 0 && strength > (best.get(key)?.strength ?? 0)) {
          best.set(key, { row, strength });
        }
      }
      for (const { row, strength } of best.values()) {
        const doc = accumulator(row.doc_type, row.doc_id, row.project_id, row.doc_date);
        doc.pathScore += strength * PATH_WEIGHT;
        doc.matchedPaths.add(row.path);
      }
    }
  }

  private scopeClause(alias: string, options: RecallOptions): { clause: string; parameters: string[] } {
    const clauses = ["p.status = 'tracked'", `(${alias}.doc_type = 'session' OR k.status = 'active')`];
    const parameters: string[] = [];
    if (options.projectId) {
      clauses.push(`${alias}.project_id = ?`);
      parameters.push(options.projectId);
    }
    if (options.types && options.types.length > 0) {
      clauses.push(`${alias}.doc_type IN (${options.types.map(() => "?").join(", ")})`);
      parameters.push(...options.types);
    }
    return { clause: clauses.join(" AND "), parameters };
  }

  private toHit(doc: DocAccumulator, score: number, terms: string[]): RecallHit | undefined {
    const header =
      doc.type === "session"
        ? (this.db
            .prepare(
              `SELECT s.title, p.name AS project_name, NULL AS kind
               FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = ?`,
            )
            .get(doc.id) as { title: string; project_name: string | null; kind: null } | undefined)
        : (this.db
            .prepare(
              `SELECT k.title, p.name AS project_name, k.kind
               FROM knowledge k JOIN projects p ON p.id = k.project_id WHERE k.id = ?`,
            )
            .get(doc.id) as { title: string; project_name: string | null; kind: KnowledgeKind } | undefined);
    if (!header) {
      return undefined;
    }

    const excerptChunkId =
      doc.bestRaw && (!doc.bestChunk || doc.bestRaw.score > doc.bestChunk.score) ? doc.bestRaw.id : doc.bestChunk?.id;
    const excerptRow = excerptChunkId
      ? (this.db.prepare("SELECT content FROM search_chunks WHERE id = ?").get(excerptChunkId) as
          { content: string } | undefined)
      : (this.db
          .prepare(
            `SELECT content FROM search_chunks
             WHERE doc_type = ? AND doc_id = ? AND field IN ('summary', 'body', 'title')
             ORDER BY CASE field WHEN 'title' THEN 1 ELSE 0 END LIMIT 1`,
          )
          .get(doc.type, doc.id) as { content: string } | undefined);

    const matchedIn = [...doc.fields.entries()].sort((left, right) => right[1] - left[1]).map(([field]) => field);
    if (doc.matchedPaths.size > 0) {
      matchedIn.push("path");
    }
    return {
      type: doc.type,
      id: doc.id,
      projectId: doc.projectId,
      ...(header.project_name ? { projectName: header.project_name } : {}),
      title: header.title,
      ...(header.kind ? { kind: header.kind } : {}),
      date: doc.date,
      matchedIn,
      ...(doc.bestRaw?.heading ? { section: truncateText(doc.bestRaw.heading, 120) } : {}),
      excerpt: excerptRow ? excerptAround(excerptRow.content, terms, EXCERPT_LENGTH) : "",
      ...(doc.matchedPaths.size > 0 ? { matchedPaths: [...doc.matchedPaths].slice(0, 5) } : {}),
      score: Math.round(score * 1000) / 1000,
    };
  }

  private pathContexts(projectId?: string): PathContext[] {
    const rows = this.db
      .prepare(`SELECT name, root_path FROM projects WHERE status = 'tracked' ${projectId ? "AND id = ?" : ""}`)
      .all(...(projectId ? [projectId] : [])) as Array<{ name: string; root_path: string }>;
    return rows.map((row) => ({ name: row.name, rootPath: row.root_path }));
  }

  private projectContext(projectId: string): PathContext[] {
    const row = this.db.prepare("SELECT name, root_path FROM projects WHERE id = ?").get(projectId) as
      { name: string; root_path: string } | undefined;
    return row ? [{ name: row.name, rootPath: row.root_path }] : [];
  }

  private loadSession(sessionId: string): IndexedDocument | undefined {
    const row = this.db
      .prepare(
        `SELECT project_id, title, summary, work_summary_json, completed_at, git_branch, changed_files_json
         FROM sessions WHERE id = ? AND voided_at IS NULL`,
      )
      .get(sessionId) as
      | {
          project_id: string;
          title: string;
          summary: string;
          work_summary_json: string | null;
          completed_at: string;
          git_branch: string | null;
          changed_files_json: string;
        }
      | undefined;
    if (!row) {
      return undefined;
    }
    const chunks: ChunkInput[] = [
      { field: "title", content: row.title, weight: FIELD_WEIGHTS.title },
      { field: "summary", content: row.summary, weight: FIELD_WEIGHTS.summary },
    ];
    for (const [section, items] of parseSections(row.work_summary_json)) {
      if (items.length > 0) {
        chunks.push({
          field: "workSummary",
          heading: section,
          content: items.join("\n"),
          weight: FIELD_WEIGHTS.workSummary,
        });
      }
    }
    const changedFiles = parseStringArray(row.changed_files_json);
    const changedFilesWeight = Math.min(1, CHANGED_FILES_NORMAL / Math.max(changedFiles.length, 1));
    if (changedFiles.length > 0) {
      chunks.push({
        field: "changedFiles",
        content: changedFiles.join("\n"),
        weight: FIELD_WEIGHTS.changedFiles * changedFilesWeight,
      });
    }
    if (row.git_branch) {
      chunks.push({ field: "branch", content: row.git_branch, weight: FIELD_WEIGHTS.branch });
    }
    const events = this.db
      .prepare("SELECT summary FROM work_events WHERE session_id = ? ORDER BY occurred_at ASC")
      .all(sessionId) as Array<{ summary: string }>;
    if (events.length > 0) {
      chunks.push({
        field: "event",
        content: events.map((event) => event.summary).join("\n"),
        weight: FIELD_WEIGHTS.event,
      });
    }
    const snapshots = this.db
      .prepare("SELECT content FROM raw_snapshots WHERE session_id = ? ORDER BY captured_at ASC")
      .all(sessionId) as Array<{ content: string }>;
    for (const snapshot of snapshots) {
      for (const section of splitMarkdownSections(snapshot.content)) {
        chunks.push({ field: "raw", heading: section.heading, content: section.content, weight: FIELD_WEIGHTS.raw });
      }
    }
    const contexts = this.projectContext(row.project_id);
    return {
      projectId: row.project_id,
      date: row.completed_at,
      chunks,
      paths: changedFiles
        .map((path) => normalizePath(path, contexts))
        .filter(Boolean)
        .map((path) => ({ path, weight: changedFilesWeight })),
    };
  }

  private loadKnowledge(knowledgeId: string): IndexedDocument | undefined {
    const row = this.db
      .prepare("SELECT project_id, title, body, tags_json, references_json, updated_at FROM knowledge WHERE id = ?")
      .get(knowledgeId) as
      | {
          project_id: string;
          title: string;
          body: string;
          tags_json: string;
          references_json: string;
          updated_at: string;
        }
      | undefined;
    if (!row) {
      return undefined;
    }
    const tags = parseStringArray(row.tags_json);
    const references = parseStringArray(row.references_json);
    const chunks: ChunkInput[] = [
      { field: "title", content: row.title, weight: FIELD_WEIGHTS.title },
      { field: "body", content: row.body, weight: FIELD_WEIGHTS.body },
    ];
    if (tags.length > 0) {
      chunks.push({ field: "tags", content: tags.join(" "), weight: FIELD_WEIGHTS.tags });
    }
    if (references.length > 0) {
      chunks.push({ field: "references", content: references.join("\n"), weight: FIELD_WEIGHTS.references });
    }
    const contexts = this.projectContext(row.project_id);
    const paths = references
      .flatMap((reference) => normalizeReference(reference, contexts))
      .filter((reference) => reference.kind === "path")
      .map((reference) => ({ path: reference.value, weight: 1 }));
    return { projectId: row.project_id, date: row.updated_at, chunks, paths };
  }

  private removeDocument(type: DocType, id: string): void {
    const chunkIds = this.db
      .prepare("SELECT id FROM search_chunks WHERE doc_type = ? AND doc_id = ?")
      .all(type, id) as Array<{ id: number }>;
    const deleteFts = this.db.prepare("DELETE FROM search_fts WHERE rowid = ?");
    for (const chunk of chunkIds) {
      deleteFts.run(chunk.id);
    }
    this.db.prepare("DELETE FROM search_chunks WHERE doc_type = ? AND doc_id = ?").run(type, id);
    this.db.prepare("DELETE FROM search_paths WHERE doc_type = ? AND doc_id = ?").run(type, id);
  }

  private insertDocument(type: DocType, id: string, document: IndexedDocument): void {
    const insertChunk = this.db.prepare(
      `INSERT INTO search_chunks (doc_type, doc_id, project_id, field, heading, content, weight, doc_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertFts = this.db.prepare("INSERT INTO search_fts (rowid, tokens) VALUES (?, ?)");
    for (const chunk of document.chunks) {
      const tokens = tokenize(chunk.content);
      if (tokens.length === 0) {
        continue;
      }
      const result = insertChunk.run(
        type,
        id,
        document.projectId,
        chunk.field,
        chunk.heading ?? null,
        chunk.content,
        chunk.weight,
        document.date,
      );
      insertFts.run(result.lastInsertRowid, tokens.join(" "));
    }
    const insertPath = this.db.prepare(
      `INSERT INTO search_paths (doc_type, doc_id, project_id, path, basename, weight, doc_date)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const { path, weight } of document.paths) {
      insertPath.run(type, id, document.projectId, path, pathBasename(path), weight, document.date);
    }
  }
}
