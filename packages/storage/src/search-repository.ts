import { createHash } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { KNOWLEDGE_STATUSES } from "@work-intelligence/core";
import type {
  KnowledgeKind,
  KnowledgeStatus,
  RecallConfidence,
  RecallField,
  RecallHit,
  RecallTermHits,
} from "@work-intelligence/core";
import { localDayStartIso, truncateText } from "@work-intelligence/shared";
import {
  APPLIES_TO_SCAN_LIMIT,
  appliesToColumnSql,
  appliesToEntries,
  appliesToStrength,
  createAppliesToBudget,
} from "./applies-to-match.js";
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
  type QueryWord,
} from "./search-text.js";
import { LIST_SEARCH_CHARGE_FUNCTION, PATH_SEARCH_ROW_BYTES, runListSearchScan } from "./list-search-scan.js";
import { nextCalendarDate } from "./session-repository.js";
import { resetLastInsertRowid, runFtsWrite } from "./sqlite-fts.js";
import { runImmediateTransaction } from "./sqlite-transaction.js";

type DocType = "session" | "knowledge";

/*
 * Ranking: original-term FTS5 BM25 per chunk × field weight, summed for structured fields, with only the best raw
 * handoff section counted. Fixed synonym expansions use a separate 0.2-weight score; only the best synonym chunk
 * or raw section counts, and its contribution is capped at 25% of an existing original-term score. Synonym-only
 * candidates use that single best piece as a low-confidence lead. Original-term IDF coverage controls ranking
 * coverage (words matched only in raw text count half there) and confidence. Structured fields outweigh raw planning
 * text, duplicate raw sections are downweighted, path matches add a fixed score, recency is mild, and Knowledge
 * evidence adjusts its score.
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
  raw: 0.3,
};
const DUPLICATE_RAW_WEIGHT_FACTOR = 0.1;
// Sessions listing more changed files than this are likely polluted by unrelated dirty worktrees.
export const CHANGED_FILES_NORMAL = 20;
const PATH_WEIGHT = 4;
const RECENCY_DAYS = 180;
const MAX_QUERY_TERMS = 32;
/** Path-like words of a Knowledge query matched against paths and appliesTo; more add cost, not recall. */
const MAX_QUERY_PATH_WORDS = 5;
const PATH_SCAN_TRUNCATED_WARNING =
  "Some stored paths are longer than the 4 KB a path comparison reads and were not compared, so path matches may be incomplete.";
const APPLIES_TO_TRUNCATED_WARNING =
  "Some Knowledge appliesTo entries were not compared within the match budget, so file-scope matches may be incomplete.";
/** Share of a path score a recall gives an appliesTo-only match; the relaxed Knowledge search keeps the full score. */
const RECALL_APPLIES_TO_SHARE = 0.85;
const EXCERPT_LENGTH = 220;
const MAX_SYNONYM_TERMS = 32;
const SYNONYM_SCORE_WEIGHT = 0.2;
const MAX_SYNONYM_SCORE_SHARE = 0.25;
// Keep weak matches as low-confidence leads, but suppress records with under 10% of the query's IDF weight.
const MIN_QUERY_COVERAGE = 0.1;
// "high" needs half the query's IDF weight in structured fields (title, summary, workSummary, Knowledge) or a
// path match; matches only inside raw handoff text, such as a quoted query in old planning notes, stay "low".
const HIGH_CONFIDENCE_QUERY_COVERAGE = 0.5;
// For ranking only, query words matched solely in raw handoff text count half. Long imported handoffs mention many
// words in passing, so full credit let them outrank shorter records that answer the query in structured fields.
// The coverage floor and confidence still use full coverage, so raw-only answers stay findable.
const RAW_ONLY_COVERAGE_SHARE = 0.5;
// Evidence strength for Knowledge: each confirmation (up to 5) adds 4%, and a contradiction newer than the
// latest confirmation lowers the score, so a disputed item ranks below an equally matching trusted one.
const CONFIRMATION_BONUS = 0.04;
const CONFIRMATION_CAP = 5;
const CONTRADICTED_FACTOR = 0.7;
// A later Session that continues an earlier hit records the more current state of the same work. When it scores at
// least this share of the earlier hit, it moves directly above it, so a chain shows its latest state first and the
// earlier record stays right after it.
const CONTINUATION_SCORE_SHARE = 0.3;
// Only the leading ranked entries are reordered; continuations further down cannot reach the returned hits anyway.
const CONTINUATION_WINDOW = 100;
// With queried paths, path-matched Knowledge may fill this share of a recall page (at most this many slots).
const KNOWLEDGE_PATH_RESERVE_SHARE = 0.15;
const KNOWLEDGE_PATH_RESERVE_MAX = 3;
// A relaxed Knowledge match names at most this many shared query terms and appliesTo/reference paths.
const MAX_MATCHED_TERMS = 8;
const MAX_MATCHED_PATHS = 3;
// Single CJK characters that carry no topic of their own (particles, conjunctions, copulas). A query word made only
// of one of them is left out of termHits: reporting that "的" matched nothing only invites a pointless rephrase.
const ZERO_INFORMATION_CJK_WORDS = new Set([
  "的",
  "之",
  "與",
  "和",
  "及",
  "或",
  "跟",
  "讓",
  "把",
  "被",
  "對",
  "從",
  "在",
  "是",
  "了",
  "也",
  "就",
  "都",
  "而",
  "並",
  "但",
  "嗎",
  "呢",
  "吧",
]);
const CJK_RUN = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{3,}$/u;
const SOFTWARE_TERM_GROUPS = [
  ["endpoint", "API", "路由", "route"],
  ["慣例", "convention"],
  ["效能", "performance"],
  ["測試", "test"],
  ["設定", "config"],
  ["遷移", "migration"],
] as const;
const SOFTWARE_TERM_SYNONYMS = new Map<string, string[]>(
  SOFTWARE_TERM_GROUPS.flatMap((group) => {
    const terms = [...new Set(group.flatMap((term) => tokenize(term)))];
    return terms.map((term) => [term, terms.filter((synonym) => synonym !== term)] as const);
  }),
);

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

/** The statements one index sync reuses for every dirty document. */
interface IndexWriteStatements {
  chunkIds: StatementSync;
  deleteFts: StatementSync;
  deleteChunks: StatementSync;
  deletePaths: StatementSync;
  insertChunk: StatementSync;
  insertFts: StatementSync;
  insertPath: StatementSync;
}

/** The statements one index sync reuses to read every dirty document, and each project's path context once. */
interface IndexReadStatements {
  session: StatementSync;
  events: StatementSync;
  snapshots: StatementSync;
  knowledge: StatementSync;
  project: StatementSync;
  contexts: Map<string, PathContext[]>;
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
  content_hash: string | null;
  is_primary_raw: number;
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
  bestSynonymChunk?: { id: number; score: number; field: RecallField };
  bestSynonymRaw?: { id: number; score: number; heading: string };
  fields: Map<RecallField, number>;
  bestChunk?: { id: number; score: number; field: RecallField };
  bestRaw?: { id: number; score: number; heading: string };
  terms: Set<number>;
  /** Query terms matched outside raw handoff text; a quote in old planning notes alone is not a confident answer. */
  structuredTerms: Set<number>;
  pathScore: number;
  matchedPaths: Set<string>;
}

interface RankedDoc {
  doc: DocAccumulator;
  coverage: number;
  structuredCoverage: number;
  score: number;
}

export interface RecallOptions {
  q?: string;
  paths?: string[];
  projectId?: string;
  types?: DocType[];
  /** Knowledge statuses to rank; recall reads active Knowledge only when this is not set. */
  knowledgeStatuses?: KnowledgeStatus[];
  kind?: KnowledgeKind;
  /** Also match queried paths against Knowledge appliesTo (the relaxed Knowledge search). */
  matchAppliesTo?: boolean;
  /** Inclusive calendar dates in the server's time zone, compared against each document's date. */
  from?: string;
  to?: string;
  limit: number;
  /**
   * Internal, for work_get_context: also return the best-ranked path-matched Knowledge that did not make the page,
   * taken from the same ranking pass. They are never part of `hits`.
   */
  extraPathKnowledge?: number;
}

/** A path-matched Knowledge ranked beyond the recall page, in ranked order; only its title and first matched path. */
export interface ExtraPathKnowledge {
  id: string;
  title: string;
  matchedPath: string;
}

export interface RecallComputation {
  hits: RecallHit[];
  /** Only when `extraPathKnowledge` was requested; internal to the context builder, never returned by work_recall. */
  extraPathKnowledge?: ExtraPathKnowledge[];
  confidence: RecallConfidence;
  termHits?: RecallTermHits[];
  /** Present when stored paths above the per-path cap were skipped. */
  warnings?: string[];
}

export interface KnowledgeRankOptions {
  q: string;
  projectId?: string;
  /** The status whose best matches are returned as hits; every status is counted in totals. */
  status: KnowledgeStatus;
  kind?: KnowledgeKind;
  limit: number;
}

export interface KnowledgeRankHit {
  id: string;
  score: number;
  /** Tokenized query terms (words, identifier parts, CJK bigrams) the Knowledge contains. */
  matchedTerms: string[];
  /** Normalized appliesTo or reference paths that matched a path-like query word. */
  matchedPaths?: string[];
}

export interface KnowledgeRanking {
  /** Matches per status, including the ones not returned as hits. */
  totals: Partial<Record<KnowledgeStatus, number>>;
  hits: KnowledgeRankHit[];
  /** The appliesTo match budget ran out or an over-long stored path was skipped, so some Knowledge was not checked. */
  appliesToScanTruncated?: true;
}

export interface SearchIndexRebuildResult {
  sessions: number;
  knowledge: number;
  chunks: number;
  paths: number;
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

function hashRawContent(content: string): string {
  const normalized = content.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
  return createHash("sha256").update(normalized).digest("hex");
}

function isZeroInformationWord(word: QueryWord): boolean {
  return ZERO_INFORMATION_CJK_WORDS.has(word.word);
}

/** A query word that is one unsegmented CJK run of three or more characters, so it became several bigrams. */
function isCjkRun(word: QueryWord): boolean {
  return CJK_RUN.test(word.word.normalize("NFKC"));
}

function expandSoftwareTermSynonyms(terms: string[]): string[] {
  const originalTerms = new Set(terms);
  return [...new Set(terms.flatMap((term) => SOFTWARE_TERM_SYNONYMS.get(term) ?? []))]
    .filter((term) => !originalTerms.has(term))
    .slice(0, MAX_SYNONYM_TERMS);
}

/** Retrieval index over Sessions (with raw handoff sections) and Knowledge, kept in sync lazily. */
export class SearchRepository {
  public constructor(private readonly db: DatabaseSync) {}

  /** Rebuilds every cached search row from the current Session and Knowledge records. */
  public rebuildIndex(): SearchIndexRebuildResult {
    const documents = this.db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number };
    const knowledge = this.db.prepare("SELECT COUNT(*) AS count FROM knowledge").get() as { count: number };

    runImmediateTransaction(this.db, () => {
      this.db.exec(
        "DELETE FROM search_fts; DELETE FROM search_chunks; DELETE FROM search_paths; DELETE FROM search_dirty;",
      );
      this.db.exec(`
        INSERT OR IGNORE INTO search_dirty (doc_type, doc_id) SELECT 'session', id FROM sessions;
        INSERT OR IGNORE INTO search_dirty (doc_type, doc_id) SELECT 'knowledge', id FROM knowledge;
      `);
    });
    this.syncIndex();

    return {
      sessions: documents.count,
      knowledge: knowledge.count,
      chunks: (this.db.prepare("SELECT COUNT(*) AS count FROM search_chunks").get() as { count: number }).count,
      paths: (this.db.prepare("SELECT COUNT(*) AS count FROM search_paths").get() as { count: number }).count,
    };
  }

  /**
   * Re-indexes documents marked dirty by the write triggers. Every old FTS row is deleted before any new one is
   * inserted: interleaving per document makes FTS5 flush a small segment for each lower rowid it receives and merge
   * them, which grew far faster than linear once a migration or redaction marked thousands of documents dirty.
   *
   * One dirty document (the usual case after a finalize) stays cheap, and a large backlog costs per document only
   * the SQL that must run for it: the old chunk and path rows of all dirty documents are removed with one statement
   * each, the read and write statements are prepared once per sync, and each project's path context is read once.
   * The same rows are deleted and written in the same order, so even the new chunk rowids match re-indexing one
   * document at a time.
   */
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
      const statements = this.prepareIndexWrites();
      this.removeDirtyDocuments(statements);
      const reads = this.prepareIndexReads();
      for (const row of dirty) {
        const document =
          row.doc_type === "session" ? this.loadSession(reads, row.doc_id) : this.loadKnowledge(reads, row.doc_id);
        if (document) {
          this.insertDocument(statements, row.doc_type, row.doc_id, document);
        }
      }
      this.db.exec("DELETE FROM search_dirty");
    });
    resetLastInsertRowid(this.db);
  }

  public recall(options: RecallOptions): RecallComputation {
    this.syncIndex();
    const { words, terms, idf, docs, ranked, pathScanTruncated, appliesToScanTruncated } = this.rank(options);
    const excerptTerms = terms
      .map((term, index) => ({ term, idf: idf[index] ?? 0 }))
      .sort((left, right) => right.idf - left.idf)
      .map((entry) => entry.term);
    const selected = this.preferKnowledgeOverSource(
      this.reserveKnowledgeSlots(this.preferContinuations(ranked), options.limit),
    );
    // Confidence is judged only on the entries that became hits, so a record the response leaves out cannot raise it.
    const returned = selected.flatMap((entry) => {
      const hit = this.toHit(entry.doc, entry.score, excerptTerms);
      return hit ? [{ entry, hit }] : [];
    });
    const hits = returned.map(({ hit }) => hit);
    const extraPathKnowledge = options.extraPathKnowledge
      ? this.extraPathKnowledgeBeyond(ranked, selected, options.extraPathKnowledge)
      : [];
    const confidence =
      returned.length === 0
        ? "none"
        : returned.some(
              ({ entry }) =>
                entry.doc.matchedPaths.size > 0 || entry.structuredCoverage >= HIGH_CONFIDENCE_QUERY_COVERAGE,
            )
          ? "high"
          : "low";

    const termHits = words
      .filter((word) => !isZeroInformationWord(word))
      .map((word) => {
        const indexes = word.terms.map((term) => terms.indexOf(term)).filter((index) => index >= 0);
        // An unsegmented CJK run is split into overlapping bigrams; requiring every bigram in one record reported
        // phrases whose parts all matched as "matched nothing". Half of its bigrams count as found.
        const required = isCjkRun(word) ? Math.ceil(indexes.length / 2) : indexes.length;
        let count = 0;
        for (const doc of docs.values()) {
          if (indexes.length > 0 && indexes.filter((index) => doc.terms.has(index)).length >= required) {
            count += 1;
          }
        }
        return { term: word.word, count };
      });
    return {
      hits,
      ...(extraPathKnowledge.length > 0 ? { extraPathKnowledge } : {}),
      confidence,
      ...(termHits.some((entry) => entry.count === 0) ? { termHits } : {}),
      ...(pathScanTruncated || appliesToScanTruncated
        ? {
            warnings: [
              ...(pathScanTruncated ? [PATH_SCAN_TRUNCATED_WARNING] : []),
              ...(appliesToScanTruncated ? [APPLIES_TO_TRUNCATED_WARNING] : []),
            ],
          }
        : {}),
    };
  }

  /**
   * Ranked OR matching over Knowledge only: the relaxed fallback of the strict Knowledge list search. It reuses the
   * recall ranking (shared tokenizer, BM25 field weights, IDF coverage, path matches) and also matches path-like query
   * words against appliesTo. Records found only through a fixed synonym are left out, because every match must name
   * the query terms it shares. One ranking covers every status, since a record's score does not depend on which other
   * records are ranked: `hits` keeps the best `limit` of the requested status and `totals` counts each status.
   */
  public rankKnowledge(options: KnowledgeRankOptions): KnowledgeRanking {
    this.syncIndex();
    const paths = options.q
      .split(/\s+/u)
      .flatMap((word) => normalizeReference(word))
      .filter((reference) => reference.kind === "path")
      .map((reference) => reference.value);
    const { terms, ranked, appliesToScanTruncated, pathScanTruncated } = this.rank({
      q: options.q,
      paths: [...new Set(paths)].slice(0, MAX_QUERY_PATH_WORDS),
      projectId: options.projectId,
      types: ["knowledge"],
      knowledgeStatuses: [...KNOWLEDGE_STATUSES],
      ...(options.kind ? { kind: options.kind } : {}),
      matchAppliesTo: true,
      limit: options.limit,
    });
    const matches = ranked.filter((entry) => entry.doc.terms.size > 0 || entry.doc.matchedPaths.size > 0);
    const statuses = this.knowledgeStatuses(matches.map((entry) => entry.doc.id));
    const totals: Partial<Record<KnowledgeStatus, number>> = {};
    for (const entry of matches) {
      const status = statuses.get(entry.doc.id);
      if (status) totals[status] = (totals[status] ?? 0) + 1;
    }
    return {
      totals,
      hits: matches
        .filter((entry) => statuses.get(entry.doc.id) === options.status)
        .slice(0, options.limit)
        .map(({ doc, score }) => ({
          id: doc.id,
          score: Math.round(score * 1000) / 1000,
          matchedTerms: terms.filter((_, index) => doc.terms.has(index)).slice(0, MAX_MATCHED_TERMS),
          ...(doc.matchedPaths.size > 0 ? { matchedPaths: [...doc.matchedPaths].slice(0, MAX_MATCHED_PATHS) } : {}),
        })),
      ...(appliesToScanTruncated || pathScanTruncated ? { appliesToScanTruncated: true as const } : {}),
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

    const statements = this.prepareIndexWrites();
    for (const document of documents.values()) {
      this.removeDocument(statements, document.type, document.id);
    }
    this.db.prepare(`DELETE FROM search_dirty WHERE ${dirtyPredicate}`).run(sessionIdJson, knowledgeIdJson);
    return { chunks, fts, paths, dirty };
  }

  /**
   * The best `count` Knowledge whose appliesTo or references match any of `paths`, in one ranking pass. It does not
   * sync the index: the caller has just recalled, which synced it (a clean index costs one query anyway).
   */
  public knowledgeForPaths(paths: string[], projectId: string, count: number): ExtraPathKnowledge[] {
    if (paths.length === 0 || count <= 0) return [];
    const { ranked } = this.rank({ paths, projectId, types: ["knowledge"], limit: count });
    return this.extraPathKnowledgeBeyond(ranked, [], count);
  }

  /** The first `count` path-matched Knowledge of the ranking that the page did not select, with one title query. */
  private extraPathKnowledgeBeyond(ranked: RankedDoc[], selected: RankedDoc[], count: number): ExtraPathKnowledge[] {
    const selectedIds = new Set(selected.map((entry) => entry.doc.id));
    const beyond = ranked
      .filter(
        (entry) => entry.doc.type === "knowledge" && entry.doc.matchedPaths.size > 0 && !selectedIds.has(entry.doc.id),
      )
      .slice(0, count);
    if (beyond.length === 0) {
      return [];
    }
    const titles = new Map(
      (
        this.db
          .prepare("SELECT id, title FROM knowledge WHERE id IN (SELECT value FROM json_each(?))")
          .all(JSON.stringify(beyond.map((entry) => entry.doc.id))) as Array<{ id: string; title: string }>
      ).map((row) => [row.id, row.title]),
    );
    return beyond.flatMap((entry) => {
      const title = titles.get(entry.doc.id);
      const matchedPath = [...entry.doc.matchedPaths][0];
      return title === undefined || matchedPath === undefined ? [] : [{ id: entry.doc.id, title, matchedPath }];
    });
  }

  /** Scores every matching document and returns them best first, with the parsed query the scores refer to. */
  private rank(options: RecallOptions): {
    words: QueryWord[];
    terms: string[];
    idf: number[];
    docs: Map<string, DocAccumulator>;
    ranked: RankedDoc[];
    appliesToScanTruncated: boolean;
    pathScanTruncated: boolean;
  } {
    const words = options.q ? parseQueryWords(options.q) : [];
    const terms = [...new Set(words.flatMap((word) => word.terms))].slice(0, MAX_QUERY_TERMS);
    const synonyms = expandSoftwareTermSynonyms(terms);
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
          structuredTerms: new Set(),
          pathScore: 0,
          matchedPaths: new Set(),
        };
        docs.set(key, doc);
      }
      return doc;
    };

    const { idf, totalIdf } =
      terms.length > 0 ? this.scoreTerms(terms, accumulator, options) : { idf: [], totalIdf: 0 };
    if (synonyms.length > 0) {
      this.scoreSynonyms(synonyms, accumulator, options);
    }
    let appliesToScanTruncated = false;
    let pathScanTruncated = false;
    if (queriedPaths.length > 0) {
      pathScanTruncated = this.scorePaths(queriedPaths, accumulator, options);
      // Recall with paths also matches Knowledge appliesTo, unless it was limited to Sessions only.
      if (options.matchAppliesTo || !options.types || options.types.includes("knowledge")) {
        appliesToScanTruncated = this.scoreAppliesTo(
          queriedPaths,
          accumulator,
          options,
          options.matchAppliesTo ? 1 : RECALL_APPLIES_TO_SHARE,
        );
      }
    }

    const now = Date.now();
    const evidence = this.evidenceFactors(
      [...docs.values()].filter((doc) => doc.type === "knowledge").map((doc) => doc.id),
    );
    const ranked = [...docs.values()]
      .map((doc) => {
        let matchedIdf = 0;
        for (const index of doc.terms) {
          matchedIdf += idf[index] ?? 0;
        }
        let structuredIdf = 0;
        for (const index of doc.structuredTerms) {
          structuredIdf += idf[index] ?? 0;
        }
        const coverage = totalIdf > 0 ? matchedIdf / totalIdf : 0;
        const structuredCoverage = totalIdf > 0 ? structuredIdf / totalIdf : 0;
        const rankingCoverage =
          totalIdf > 0 ? (structuredIdf + (matchedIdf - structuredIdf) * RAW_ONLY_COVERAGE_SHARE) / totalIdf : 0;
        const originalScore = doc.fieldScore + (doc.bestRaw?.score ?? 0);
        const synonymScore = Math.max(doc.bestSynonymChunk?.score ?? 0, doc.bestSynonymRaw?.score ?? 0);
        const textScore =
          originalScore > 0
            ? (originalScore + Math.min(synonymScore, originalScore * MAX_SYNONYM_SCORE_SHARE)) *
              rankingCoverage *
              rankingCoverage
            : synonymScore;
        const ageDays = Math.max(0, (now - Date.parse(doc.date)) / 86_400_000) || 0;
        const recency = 0.75 + 0.25 * Math.exp(-ageDays / RECENCY_DAYS);
        const strength = doc.type === "knowledge" ? (evidence.get(doc.id) ?? 1) : 1;
        return { doc, coverage, structuredCoverage, score: (textScore + doc.pathScore) * recency * strength };
      })
      .filter(
        (entry) =>
          entry.score > 0 &&
          (entry.doc.matchedPaths.size > 0 ||
            entry.coverage >= MIN_QUERY_COVERAGE ||
            (entry.doc.bestSynonymChunk?.score ?? 0) > 0 ||
            (entry.doc.bestSynonymRaw?.score ?? 0) > 0),
      )
      .sort((left, right) => right.score - left.score || right.doc.date.localeCompare(left.doc.date));
    return { words, terms, idf, docs, ranked, appliesToScanTruncated, pathScanTruncated };
  }

  /** Moves each qualifying continuation directly above the earlier Session it continues; see CONTINUATION_SCORE_SHARE. */
  private preferContinuations<T extends { doc: { type: DocType; id: string }; score: number }>(ranked: T[]): T[] {
    const window = ranked.slice(0, CONTINUATION_WINDOW);
    const sessionIds = JSON.stringify(
      window.filter((entry) => entry.doc.type === "session").map((entry) => entry.doc.id),
    );
    const links = this.db
      .prepare(
        `SELECT session_id AS later, related_session_id AS earlier FROM session_links
         WHERE relation = 'continues'
           AND session_id IN (SELECT value FROM json_each(?))
           AND related_session_id IN (SELECT value FROM json_each(?))`,
      )
      .all(sessionIds, sessionIds) as Array<{ later: string; earlier: string }>;
    if (links.length === 0) {
      return ranked;
    }
    const continuations = new Map<string, Set<string>>();
    for (const link of links) {
      const laters = continuations.get(link.earlier) ?? new Set<string>();
      laters.add(link.later);
      continuations.set(link.earlier, laters);
    }
    const order = [...window];
    const moved = new Set<string>();
    for (let index = 0; index < order.length; index += 1) {
      const earlier = order[index]!;
      const laters = earlier.doc.type === "session" ? continuations.get(earlier.doc.id) : undefined;
      if (!laters) continue;
      const position = order.findIndex(
        (entry, candidate) =>
          candidate > index &&
          entry.doc.type === "session" &&
          laters.has(entry.doc.id) &&
          !moved.has(entry.doc.id) &&
          entry.score >= earlier.score * CONTINUATION_SCORE_SHARE,
      );
      if (position < 0) continue;
      const [later] = order.splice(position, 1);
      order.splice(index, 0, later!);
      moved.add(later!.doc.id);
      // Revisit this slot so a continuation of the moved Session can move above it in turn.
      index -= 1;
    }
    return [...order, ...ranked.slice(CONTINUATION_WINDOW)];
  }

  /**
   * Returns the first `limit` entries, except that a path-matched Knowledge item (references or appliesTo) ranked
   * below them takes the place of the lowest-ranked Sessions until KNOWLEDGE_PATH_RESERVE_SHARE of the slots (at most
   * KNOWLEDGE_PATH_RESERVE_MAX) hold Knowledge. A frequently changed file has far more Sessions than Knowledge, each
   * scoring a full path match, so without a reserve its Knowledge never reaches the first page. Queries without a
   * path match, and pages that already hold enough Knowledge, are returned unchanged.
   */
  private reserveKnowledgeSlots<T extends { doc: { type: DocType; matchedPaths: Set<string> } }>(
    ranked: T[],
    limit: number,
  ): T[] {
    const page = ranked.slice(0, limit);
    const wanted = Math.min(KNOWLEDGE_PATH_RESERVE_MAX, Math.floor(limit * KNOWLEDGE_PATH_RESERVE_SHARE));
    const missing = wanted - page.filter((entry) => entry.doc.type === "knowledge").length;
    if (missing <= 0) {
      return page;
    }
    const promoted = ranked
      .slice(limit)
      .filter((entry) => entry.doc.type === "knowledge" && entry.doc.matchedPaths.size > 0)
      .slice(0, missing);
    if (promoted.length === 0) {
      return page;
    }
    const kept = [...page];
    for (let index = kept.length - 1, removed = 0; index >= 0 && removed < promoted.length; index -= 1) {
      if (kept[index]!.doc.type === "session") {
        kept.splice(index, 1);
        removed += 1;
      }
    }
    return [...kept, ...promoted];
  }

  /**
   * Moves each returned Knowledge item directly above its own source Session when that Session ranks higher: the item
   * is the reviewed statement of what the longer record says, and the Session stays one step away. Only the order of
   * the entries already selected changes, never a score or which entries are returned, and only within one project.
   */
  private preferKnowledgeOverSource<T extends { doc: { type: DocType; id: string; projectId: string } }>(
    selected: T[],
  ): T[] {
    const sessions = new Map<string, { index: number; projectId: string }>();
    const knowledgeIds: string[] = [];
    selected.forEach((entry, index) => {
      if (entry.doc.type === "session") sessions.set(entry.doc.id, { index, projectId: entry.doc.projectId });
      else knowledgeIds.push(entry.doc.id);
    });
    if (sessions.size === 0 || knowledgeIds.length === 0) {
      return selected;
    }
    const sources = new Map(
      (
        this.db
          .prepare(
            `SELECT id, session_id FROM knowledge
             WHERE id IN (SELECT value FROM json_each(?)) AND session_id IS NOT NULL`,
          )
          .all(JSON.stringify(knowledgeIds)) as Array<{ id: string; session_id: string }>
      ).map((row) => [row.id, row.session_id]),
    );
    // Knowledge to place above each source Session, in ranked order so several items from one Session keep theirs.
    const above = new Map<string, T[]>();
    const moved = new Set<T>();
    selected.forEach((entry, index) => {
      if (entry.doc.type !== "knowledge") return;
      const sessionId = sources.get(entry.doc.id);
      const source = sessionId === undefined ? undefined : sessions.get(sessionId);
      if (sessionId === undefined || !source || source.index > index || source.projectId !== entry.doc.projectId) {
        return;
      }
      above.set(sessionId, [...(above.get(sessionId) ?? []), entry]);
      moved.add(entry);
    });
    if (moved.size === 0) {
      return selected;
    }
    return selected.flatMap((entry) => {
      if (moved.has(entry)) return [];
      return entry.doc.type === "session" ? [...(above.get(entry.doc.id) ?? []), entry] : [entry];
    });
  }

  private knowledgeStatuses(knowledgeIds: string[]): Map<string, KnowledgeStatus> {
    if (knowledgeIds.length === 0) {
      return new Map();
    }
    const rows = this.db
      .prepare("SELECT id, status FROM knowledge WHERE id IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify(knowledgeIds)) as Array<{ id: string; status: KnowledgeStatus }>;
    return new Map(rows.map((row) => [row.id, row.status]));
  }

  /** Ranking multipliers for Knowledge with recorded feedback (one grouped query); others keep 1. */
  private evidenceFactors(knowledgeIds: string[]): Map<string, number> {
    const factors = new Map<string, number>();
    if (knowledgeIds.length === 0) {
      return factors;
    }
    const rows = this.db
      .prepare(
        `SELECT knowledge_id,
                SUM(kind <> 'contradicted') AS confirmed,
                MAX(CASE WHEN kind <> 'contradicted' THEN occurred_at END) AS last_confirmed_at,
                MAX(CASE WHEN kind = 'contradicted' THEN occurred_at END) AS last_contradicted_at
         FROM knowledge_feedback
         WHERE knowledge_id IN (SELECT value FROM json_each(?))
         GROUP BY knowledge_id`,
      )
      .all(JSON.stringify(knowledgeIds)) as Array<{
      knowledge_id: string;
      confirmed: number;
      last_confirmed_at: string | null;
      last_contradicted_at: string | null;
    }>;
    for (const row of rows) {
      const disputed =
        row.last_contradicted_at !== null &&
        (row.last_confirmed_at === null || row.last_contradicted_at > row.last_confirmed_at);
      const bonus = 1 + CONFIRMATION_BONUS * Math.min(row.confirmed, CONFIRMATION_CAP);
      factors.set(row.knowledge_id, disputed ? CONTRADICTED_FACTOR : bonus);
    }
    return factors;
  }

  private scoreTerms(
    terms: string[],
    accumulator: (type: DocType, id: string, projectId: string, date: string) => DocAccumulator,
    options: RecallOptions,
  ): { idf: number[]; totalIdf: number } {
    const totalChunks = (this.db.prepare("SELECT COUNT(*) AS count FROM search_chunks").get() as { count: number })
      .count;
    // IDF needs only how many chunks contain each term, so SQLite counts them instead of returning every rowid.
    const countStatement = this.db.prepare("SELECT COUNT(*) AS count FROM search_fts WHERE search_fts MATCH ?");
    const termCounts = terms.map((term) => (countStatement.get(ftsTermExpression(term)) as { count: number }).count);
    const idf = termCounts.map((count) => Math.log(1 + (totalChunks - count + 0.5) / (count + 0.5)));
    const totalIdf = idf.reduce((sum, value) => sum + value, 0);
    if (totalIdf === 0) {
      return { idf, totalIdf };
    }

    const { clause, parameters } = this.scopeClause("c", options);
    // CROSS JOIN pins the FTS match as the outer loop. With a plain JOIN and a doc_type filter, SQLite drives
    // from idx_search_chunks_doc and re-runs the full-text scan once per chunk (about 300x slower at 5,000 Sessions).
    const rows = this.db
      .prepare(
        `SELECT c.id, c.doc_type, c.doc_id, c.project_id, c.field, c.heading, c.weight, c.doc_date,
                c.content_hash,
                CASE WHEN c.content_hash IS NULL THEN 1 WHEN c.id = (
                  SELECT primary_chunk.id FROM search_chunks primary_chunk
                  WHERE primary_chunk.project_id = c.project_id AND primary_chunk.content_hash = c.content_hash
                    AND primary_chunk.field = 'raw'
                  ORDER BY primary_chunk.doc_date ASC, primary_chunk.doc_id ASC, primary_chunk.id ASC LIMIT 1
                ) THEN 1 ELSE 0 END AS is_primary_raw,
                -bm25(search_fts) AS score
         FROM search_fts
         CROSS JOIN search_chunks c ON c.id = search_fts.rowid
         JOIN projects p ON p.id = c.project_id
         LEFT JOIN knowledge k ON c.doc_type = 'knowledge' AND k.id = c.doc_id
         WHERE search_fts MATCH ? AND ${clause}`,
      )
      .all(terms.map(ftsTermExpression).join(" OR "), ...parameters) as unknown as ScoredChunkRow[];
    const termSets = this.termMembership(terms, termCounts, rows.length);

    for (const row of rows) {
      const doc = accumulator(row.doc_type, row.doc_id, row.project_id, row.doc_date);
      termSets.forEach((set, index) => {
        if (set.has(row.id)) {
          doc.terms.add(index);
          if (row.field !== "raw") doc.structuredTerms.add(index);
        }
      });
      const rawWeight = row.field === "raw" && !row.is_primary_raw ? DUPLICATE_RAW_WEIGHT_FACTOR : 1;
      const score = Math.max(0, row.score) * row.weight * rawWeight;
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

  /**
   * Which returned chunks contain each query term, for coverage. Reading every rowid of a term is the costly part,
   * so it is skipped where the answer is already known: no returned chunk (nothing to attribute), a term no chunk
   * contains (no member), or a single term with any match (every chunk the OR query returned must contain it).
   */
  private termMembership(
    terms: string[],
    termCounts: number[],
    returnedRows: number,
  ): Array<{ has(chunkId: number): boolean }> {
    const none = { has: () => false };
    const matchedTerms = termCounts.filter((count) => count > 0).length;
    if (returnedRows === 0) {
      return terms.map(() => none);
    }
    if (matchedTerms === 1) {
      return termCounts.map((count) => (count > 0 ? { has: () => true } : none));
    }
    const matchStatement = this.db.prepare("SELECT rowid AS id FROM search_fts WHERE search_fts MATCH ?");
    return terms.map((term, index) =>
      termCounts[index] === 0
        ? none
        : new Set((matchStatement.all(ftsTermExpression(term)) as Array<{ id: number }>).map((row) => row.id)),
    );
  }

  private scoreSynonyms(
    terms: string[],
    accumulator: (type: DocType, id: string, projectId: string, date: string) => DocAccumulator,
    options: RecallOptions,
  ): void {
    const { clause, parameters } = this.scopeClause("c", options);
    // Keep expansion evidence separate so it can surface a weak lead without changing original-term coverage.
    const rows = this.db
      .prepare(
        `SELECT c.id, c.doc_type, c.doc_id, c.project_id, c.field, c.heading, c.weight, c.doc_date,
                c.content_hash,
                CASE WHEN c.content_hash IS NULL THEN 1 WHEN c.id = (
                  SELECT primary_chunk.id FROM search_chunks primary_chunk
                  WHERE primary_chunk.project_id = c.project_id AND primary_chunk.content_hash = c.content_hash
                    AND primary_chunk.field = 'raw'
                  ORDER BY primary_chunk.doc_date ASC, primary_chunk.doc_id ASC, primary_chunk.id ASC LIMIT 1
                ) THEN 1 ELSE 0 END AS is_primary_raw,
                -bm25(search_fts) AS score
         FROM search_fts
         CROSS JOIN search_chunks c ON c.id = search_fts.rowid
         JOIN projects p ON p.id = c.project_id
         LEFT JOIN knowledge k ON c.doc_type = 'knowledge' AND k.id = c.doc_id
         WHERE search_fts MATCH ? AND ${clause}`,
      )
      .all(terms.map(ftsTermExpression).join(" OR "), ...parameters) as unknown as ScoredChunkRow[];

    for (const row of rows) {
      const doc = accumulator(row.doc_type, row.doc_id, row.project_id, row.doc_date);
      const rawWeight = row.field === "raw" && !row.is_primary_raw ? DUPLICATE_RAW_WEIGHT_FACTOR : 1;
      const score = Math.max(0, row.score) * row.weight * rawWeight * SYNONYM_SCORE_WEIGHT;
      if (row.field === "raw") {
        if (!doc.bestSynonymRaw || score > doc.bestSynonymRaw.score) {
          doc.bestSynonymRaw = { id: row.id, score, heading: row.heading ?? "" };
        }
      } else {
        if (!doc.bestSynonymChunk || score > doc.bestSynonymChunk.score) {
          doc.bestSynonymChunk = { id: row.id, score, field: row.field };
        }
      }
      doc.fields.set(row.field, (doc.fields.get(row.field) ?? 0) + score);
    }
  }

  /**
   * Scores stored paths against each queried path: the same basename, or a stored path that contains `queried/`.
   * instr(lower(path), lower(needle)) > 0 is `path LIKE '%needle%'` with the wildcards escaped (LIKE folds ASCII
   * only, as lower() does) without LIKE's re-match from every stored position, which cost about 400 ns per stored
   * byte for a 1,000-character near-miss path. A stored path above PATH_SEARCH_ROW_BYTES (only a hand-written row)
   * is not compared; returns whether any was skipped.
   */
  private scorePaths(
    queriedPaths: string[],
    accumulator: (type: DocType, id: string, projectId: string, date: string) => DocAccumulator,
    options: RecallOptions,
  ): boolean {
    const { clause, parameters } = this.scopeClause("sp", options);
    const statement = this.db.prepare(
      `SELECT sp.doc_type, sp.doc_id, sp.project_id, sp.path, sp.weight, sp.doc_date
       FROM search_paths sp
       JOIN projects p ON p.id = sp.project_id
       LEFT JOIN knowledge k ON sp.doc_type = 'knowledge' AND k.id = sp.doc_id
       WHERE (sp.basename = ?
         OR CASE WHEN ${LIST_SEARCH_CHARGE_FUNCTION}(octet_length(sp.path)) THEN instr(lower(sp.path), lower(?)) > 0
            ELSE 0 END)
         AND ${clause}`,
    );
    const { scan } = runListSearchScan(
      this.db,
      1,
      () => {
        for (const queried of queriedPaths) this.scorePath(statement, queried, parameters, accumulator);
      },
      PATH_SEARCH_ROW_BYTES,
    );
    return scan.overBound > 0;
  }

  /** Adds each document's best path score for one queried path (its own call, inside the shared scan). */
  private scorePath(
    statement: StatementSync,
    queried: string,
    parameters: Array<string | number>,
    accumulator: (type: DocType, id: string, projectId: string, date: string) => DocAccumulator,
  ): void {
    const best = new Map<string, { row: PathRow; strength: number }>();
    const rows = statement.all(pathBasename(queried), `${queried}/`, ...parameters) as unknown as PathRow[];
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

  /**
   * Adds a fixed path score for Knowledge whose appliesTo covers a queried path: a glob that matches it, a plain entry
   * equal to it or a path-segment suffix of it, or a directory entry that contains it (or lies inside a queried
   * directory). appliesTo is not in the retrieval index, so the scoped rows are read once and matched in memory,
   * newest first, within one match budget; returns whether the budget ran out before every row was checked or a
   * stored entry above the write-time limits was skipped.
   */
  private scoreAppliesTo(
    queriedPaths: string[],
    accumulator: (type: DocType, id: string, projectId: string, date: string) => DocAccumulator,
    options: RecallOptions,
    share: number,
  ): boolean {
    const { clause, parameters } = this.scopeClause("k", {
      ...options,
      types: undefined,
      from: undefined,
      to: undefined,
    });
    const rows = this.db
      .prepare(
        `SELECT k.id, k.project_id, k.updated_at, ${appliesToColumnSql("k.applies_to_json")} AS applies_to_json,
                p.name, p.root_path
         FROM knowledge k
         JOIN projects p ON p.id = k.project_id
         WHERE k.applies_to_json <> '[]' AND ${clause}
         ORDER BY k.updated_at DESC, k.id ASC LIMIT ?`,
      )
      .iterate(...parameters, APPLIES_TO_SCAN_LIMIT) as Iterable<{
      id: string;
      project_id: string;
      updated_at: string;
      applies_to_json: string | null;
      name: string;
      root_path: string;
    }>;
    // Rows are read one at a time, so a spent budget also stops reading them.
    const budget = createAppliesToBudget();
    for (const row of rows) {
      const contexts = [{ name: row.name, rootPath: row.root_path }];
      let best = 0;
      let bestPattern = "";
      for (const pattern of appliesToEntries(row.applies_to_json, contexts, budget)) {
        for (const queried of queriedPaths) {
          const strength = appliesToStrength(pattern, queried, budget);
          if (strength > best) {
            best = strength;
            bestPattern = pattern;
          }
        }
      }
      // A row whose matching the budget cut short is left out whole, so a partial best never ranks it.
      if (budget.exhausted) return true;
      if (best > 0) {
        const doc = accumulator("knowledge", row.id, row.project_id, row.updated_at);
        doc.pathScore += best * PATH_WEIGHT * share;
        doc.matchedPaths.add(bestPattern);
      }
    }
    return budget.skippedEntries > 0;
  }

  private scopeClause(alias: string, options: RecallOptions): { clause: string; parameters: string[] } {
    // Recall reads active Knowledge only; the relaxed Knowledge search names the statuses it searches.
    const statuses = options.knowledgeStatuses;
    const knowledgeFilters = [
      statuses ? `k.status IN (${statuses.map(() => "?").join(", ")})` : "k.status = 'active'",
      ...(options.kind ? ["k.kind = ?"] : []),
    ].join(" AND ");
    // The knowledge table itself (alias k) has no doc_type: every row it scopes is Knowledge.
    const clauses = [
      "p.status = 'tracked'",
      alias === "k" ? knowledgeFilters : `(${alias}.doc_type = 'session' OR (${knowledgeFilters}))`,
    ];
    const parameters: string[] = [...(statuses ?? []), ...(options.kind ? [options.kind] : [])];
    if (options.projectId) {
      clauses.push(`${alias}.project_id = ?`);
      parameters.push(options.projectId);
    }
    if (options.types && options.types.length > 0) {
      clauses.push(`${alias}.doc_type IN (${options.types.map(() => "?").join(", ")})`);
      parameters.push(...options.types);
    }
    // doc_date is the Session's completedAt or the Knowledge's updatedAt (UTC ISO); calendar dates become the UTC
    // instants of local midnight, like the Session list.
    if (options.from) {
      clauses.push(`${alias}.doc_date >= ?`);
      parameters.push(localDayStartIso(options.from) ?? options.from);
    }
    if (options.to) {
      clauses.push(`${alias}.doc_date < ?`);
      parameters.push(nextCalendarDate(options.to));
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

    const excerptChunkId = [
      doc.bestChunk,
      doc.bestRaw && { ...doc.bestRaw, field: "raw" as const },
      doc.bestSynonymChunk,
      doc.bestSynonymRaw && { ...doc.bestSynonymRaw, field: "raw" as const },
    ]
      .filter((chunk): chunk is NonNullable<typeof chunk> => chunk !== undefined)
      .sort((left, right) => right.score - left.score)[0]?.id;
    const rawMatch = [doc.bestRaw, doc.bestSynonymRaw]
      .filter((chunk): chunk is NonNullable<typeof chunk> => chunk !== undefined)
      .sort((left, right) => right.score - left.score)[0];
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
      ...(rawMatch?.heading ? { section: truncateText(rawMatch.heading, 120) } : {}),
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

  /** A project's path context, read once per sync: the sync's write transaction keeps projects unchanged. */
  private projectContext(reads: IndexReadStatements, projectId: string): PathContext[] {
    let contexts = reads.contexts.get(projectId);
    if (!contexts) {
      const row = reads.project.get(projectId) as { name: string; root_path: string } | undefined;
      contexts = row ? [{ name: row.name, rootPath: row.root_path }] : [];
      reads.contexts.set(projectId, contexts);
    }
    return contexts;
  }

  private loadSession(reads: IndexReadStatements, sessionId: string): IndexedDocument | undefined {
    const row = reads.session.get(sessionId) as
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
    const events = reads.events.all(sessionId) as Array<{ summary: string }>;
    if (events.length > 0) {
      chunks.push({
        field: "event",
        content: events.map((event) => event.summary).join("\n"),
        weight: FIELD_WEIGHTS.event,
      });
    }
    const snapshots = reads.snapshots.all(sessionId) as Array<{ content: string }>;
    for (const snapshot of snapshots) {
      for (const section of splitMarkdownSections(snapshot.content)) {
        chunks.push({ field: "raw", heading: section.heading, content: section.content, weight: FIELD_WEIGHTS.raw });
      }
    }
    const contexts = this.projectContext(reads, row.project_id);
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

  private loadKnowledge(reads: IndexReadStatements, knowledgeId: string): IndexedDocument | undefined {
    const row = reads.knowledge.get(knowledgeId) as
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
    const contexts = this.projectContext(reads, row.project_id);
    const paths = references
      .flatMap((reference) => normalizeReference(reference, contexts))
      .filter((reference) => reference.kind === "path")
      .map((reference) => ({ path: reference.value, weight: 1 }));
    return { projectId: row.project_id, date: row.updated_at, chunks, paths };
  }

  private prepareIndexReads(): IndexReadStatements {
    return {
      session: this.db.prepare(
        `SELECT project_id, title, summary, work_summary_json, completed_at, git_branch, changed_files_json
         FROM sessions WHERE id = ? AND voided_at IS NULL`,
      ),
      events: this.db.prepare("SELECT summary FROM work_events WHERE session_id = ? ORDER BY occurred_at ASC"),
      snapshots: this.db.prepare("SELECT content FROM raw_snapshots WHERE session_id = ? ORDER BY captured_at ASC"),
      knowledge: this.db.prepare(
        "SELECT project_id, title, body, tags_json, references_json, updated_at FROM knowledge WHERE id = ?",
      ),
      project: this.db.prepare("SELECT name, root_path FROM projects WHERE id = ?"),
      contexts: new Map(),
    };
  }

  private prepareIndexWrites(): IndexWriteStatements {
    return {
      chunkIds: this.db.prepare("SELECT id FROM search_chunks WHERE doc_type = ? AND doc_id = ?"),
      deleteFts: this.db.prepare("DELETE FROM search_fts WHERE rowid = ?"),
      deleteChunks: this.db.prepare("DELETE FROM search_chunks WHERE doc_type = ? AND doc_id = ?"),
      deletePaths: this.db.prepare("DELETE FROM search_paths WHERE doc_type = ? AND doc_id = ?"),
      insertChunk: this.db.prepare(
        `INSERT INTO search_chunks (doc_type, doc_id, project_id, field, heading, content, weight, doc_date, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      insertFts: this.db.prepare("INSERT INTO search_fts (rowid, tokens) VALUES (?, ?)"),
      insertPath: this.db.prepare(
        `INSERT INTO search_paths (doc_type, doc_id, project_id, path, basename, weight, doc_date)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ),
    };
  }

  private removeDocument(statements: IndexWriteStatements, type: DocType, id: string): void {
    const chunkIds = statements.chunkIds.all(type, id) as Array<{ id: number }>;
    if (chunkIds.length > 0) {
      for (const chunk of chunkIds) {
        runFtsWrite(statements.deleteFts, chunk.id);
      }
      resetLastInsertRowid(this.db);
      statements.deleteChunks.run(type, id);
    }
    statements.deletePaths.run(type, id);
  }

  /**
   * Removes the cached rows of every document in search_dirty: all FTS rows first, then the chunk and path rows with
   * one statement each. Call inside the sync transaction, before any document is inserted again.
   */
  private removeDirtyDocuments(statements: IndexWriteStatements): void {
    const dirtyChunks = `SELECT c.id FROM search_dirty d
      CROSS JOIN search_chunks c ON c.doc_type = d.doc_type AND c.doc_id = d.doc_id`;
    const chunkIds = this.db.prepare(dirtyChunks).all() as Array<{ id: number }>;
    for (const chunk of chunkIds) {
      runFtsWrite(statements.deleteFts, chunk.id);
    }
    resetLastInsertRowid(this.db);
    this.db.exec(`DELETE FROM search_chunks WHERE id IN (${dirtyChunks})`);
    this.db.exec(
      `DELETE FROM search_paths WHERE EXISTS (
         SELECT 1 FROM search_dirty d WHERE d.doc_type = search_paths.doc_type AND d.doc_id = search_paths.doc_id
       )`,
    );
  }

  private insertDocument(statements: IndexWriteStatements, type: DocType, id: string, document: IndexedDocument): void {
    for (const chunk of document.chunks) {
      const tokens = tokenize(chunk.content);
      if (tokens.length === 0) {
        continue;
      }
      const result = statements.insertChunk.run(
        type,
        id,
        document.projectId,
        chunk.field,
        chunk.heading ?? null,
        chunk.content,
        chunk.weight,
        document.date,
        chunk.field === "raw" ? hashRawContent(chunk.content) : null,
      );
      runFtsWrite(statements.insertFts, result.lastInsertRowid, tokens.join(" "));
    }
    // No rowid reset is needed here: each INSERT below reports its own new rowid, never an FTS shadow rowid.
    for (const { path, weight } of document.paths) {
      statements.insertPath.run(type, id, document.projectId, path, pathBasename(path), weight, document.date);
    }
  }
}
