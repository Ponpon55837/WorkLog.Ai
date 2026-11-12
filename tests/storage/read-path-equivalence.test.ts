import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FinalizeSessionInput } from "../../packages/core/src/index.js";
import { ftsTermExpression } from "../../packages/storage/src/search-text.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only. Each oracle below is the implementation a read path had before it was made cheaper; the
// current code must return exactly the same output for the same database.
const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];
const FIXED_NOW = new Date("2026-06-01T08:00:00.000Z");
const WORDS = ["kiln", "glaze", "ferry", "manifest", "harbor", "crane", "orchard", "ledger", "beacon", "lantern"];
const CJK = ["茶葉倉庫濕度", "圖書館條碼", "診所叫號換日"];

type ScoreTerms = (terms: string[], accumulator: unknown, options: unknown) => { idf: number[]; totalIdf: number };

interface SearchIndexInternals {
  db: DatabaseSync;
  scoreTerms: ScoreTerms;
  removeDirtyDocuments(statements: unknown): void;
  removeDocument(statements: unknown, type: string, id: string): void;
  scopeClause(alias: string, options: unknown): { clause: string; parameters: string[] };
}

interface ScoredRow {
  id: number;
  doc_type: string;
  doc_id: string;
  project_id: string;
  field: string;
  heading: string | null;
  weight: number;
  doc_date: string;
  is_primary_raw: number;
  score: number;
}

interface Accumulated {
  terms: Set<number>;
  structuredTerms: Set<number>;
  fieldScore: number;
  fields: Map<string, number>;
  bestRaw?: { id: number; score: number; heading: string };
  bestChunk?: { id: number; score: number; field: string };
}

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "work-intelligence-read-eq-"));
  tempDirs.push(directory);
  return directory;
}

function openStore(databasePath: string): WorkIntelligenceStore {
  const store = new WorkIntelligenceStore(databasePath);
  stores.push(store);
  return store;
}

function searchIndexOf(store: WorkIntelligenceStore): SearchIndexInternals {
  return (store as unknown as { searchIndex: SearchIndexInternals }).searchIndex;
}

function finalize(
  store: WorkIntelligenceStore,
  root: string,
  key: string,
  input: Partial<FinalizeSessionInput>,
): string {
  const result = store.finalizeSession({
    projectRoot: root,
    idempotencyKey: key,
    title: `Session ${key}`,
    summary: "Routine maintenance.",
    workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
    changedFiles: [],
    verification: { status: "passed" },
    ...input,
  });
  if (result.outcome !== "finalized") {
    throw new Error(`Expected ${key} to finalize, got ${result.outcome}`);
  }
  return result.session.id;
}

/**
 * Two tracked projects and one paused project. Sessions mix the fixture words so single-term, multi-term, zero-hit,
 * prefix, CJK, synonym, and raw-handoff matches all occur, and several Sessions share one completion time.
 */
function seedCorpus(): { store: WorkIntelligenceStore; databasePath: string; roots: string[] } {
  const directory = tempDir();
  const databasePath = join(directory, "corpus.sqlite");
  const store = openStore(databasePath);
  const roots = ["apiary", "burrow", "paused"].map((name) => join(directory, name));
  const projects = roots.map((root, index) => store.addProject(`Project ${index}`, root));
  for (const project of projects.slice(0, 2)) store.updateProject(project.id, { status: "tracked" });
  vi.useFakeTimers({ now: new Date("2026-03-01T00:00:00.000Z"), toFake: ["Date"] });
  for (let index = 0; index < 48; index += 1) {
    const root = roots[index % 2]!;
    const first = WORDS[index % WORDS.length]!;
    const second = WORDS[(index * 3 + 1) % WORDS.length]!;
    // Every fourth Session repeats the previous completion time, so ties are ranked by the later keys.
    if (index % 4 !== 0) vi.setSystemTime(new Date(Date.UTC(2026, 2, 1 + index, 9)));
    finalize(store, root, `corpus-${index}`, {
      title: `${first} ${second} ${index % 5 === 0 ? CJK[index % CJK.length] : "maintenance"}`,
      summary: `The ${first} endpoint ${index % 3 === 0 ? "performance" : "routing"} work touched the ${second}.`,
      workSummary: {
        outcomes: [`${second} ${first} fixed`],
        scope: [],
        decisions: index % 6 === 0 ? [`Keep the ${first} API stable`] : [],
        verification: [],
        nextSteps: [],
      },
      changedFiles: [`src/${first}/index.ts`, `src/${second}/${first}.ts`],
      ...(index % 7 === 0
        ? { handoffContent: `# Notes\n## ${second}\nThe ${first} ${second} beacon was checked.\n## Other\n${CJK[0]}` }
        : {}),
    });
  }
  for (let index = 0; index < 12; index += 1) {
    const root = roots[index % 2]!;
    const word = WORDS[index % WORDS.length]!;
    store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: `knowledge-${index}`,
      kind: index % 2 === 0 ? "gotcha" : "pattern",
      title: `${word} ${WORDS[(index + 2) % WORDS.length]} rule ${index}`,
      body: `When the ${word} test runs, check the ${WORDS[(index + 5) % WORDS.length]} config first.`,
      tags: [word],
      appliesTo: [`src/${word}/**`],
    });
  }
  vi.useFakeTimers({ now: FIXED_NOW, toFake: ["Date"] });
  return { store, databasePath, roots };
}

/** The candidate read before per-term counts: one MATCH per term returning every rowid, then the OR query. */
function originalScoreTerms(
  this: SearchIndexInternals,
  terms: string[],
  accumulator: (type: string, id: string, projectId: string, date: string) => Accumulated,
  options: unknown,
): { idf: number[]; totalIdf: number } {
  const totalChunks = (this.db.prepare("SELECT COUNT(*) AS count FROM search_chunks").get() as { count: number }).count;
  const matchStatement = this.db.prepare("SELECT rowid AS id FROM search_fts WHERE search_fts MATCH ?");
  const termSets = terms.map(
    (term) => new Set((matchStatement.all(ftsTermExpression(term)) as Array<{ id: number }>).map((row) => row.id)),
  );
  const idf = termSets.map((set) => Math.log(1 + (totalChunks - set.size + 0.5) / (set.size + 0.5)));
  const totalIdf = idf.reduce((sum, value) => sum + value, 0);
  if (totalIdf === 0) return { idf, totalIdf };
  const { clause, parameters } = this.scopeClause("c", options);
  const rows = this.db
    .prepare(
      `SELECT c.id, c.doc_type, c.doc_id, c.project_id, c.field, c.heading, c.weight, c.doc_date, c.content_hash,
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
    .all(terms.map(ftsTermExpression).join(" OR "), ...parameters) as unknown as ScoredRow[];
  for (const row of rows) {
    const doc = accumulator(row.doc_type, row.doc_id, row.project_id, row.doc_date);
    termSets.forEach((set, index) => {
      if (set.has(row.id)) {
        doc.terms.add(index);
        if (row.field !== "raw") doc.structuredTerms.add(index);
      }
    });
    const rawWeight = row.field === "raw" && !row.is_primary_raw ? 0.1 : 1;
    const score = Math.max(0, row.score) * row.weight * rawWeight;
    if (row.field === "raw") {
      if (!doc.bestRaw || score > doc.bestRaw.score) doc.bestRaw = { id: row.id, score, heading: row.heading ?? "" };
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

function withOriginalScoreTerms<T>(store: WorkIntelligenceStore, read: () => T): T {
  const index = searchIndexOf(store);
  const current = index.scoreTerms;
  index.scoreTerms = originalScoreTerms as unknown as ScoreTerms;
  try {
    return read();
  } finally {
    index.scoreTerms = current;
  }
}

function dumpIndex(databasePath: string): unknown {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const chunks = db.prepare("SELECT * FROM search_chunks ORDER BY id").all();
    const paths = db
      .prepare("SELECT doc_type, doc_id, project_id, path, basename, weight, doc_date FROM search_paths")
      .all()
      .map((row) => JSON.stringify(row))
      .sort();
    const matches = [...WORDS, "茶葉", "條碼"].map((word) =>
      db
        .prepare("SELECT rowid, bm25(search_fts) AS score FROM search_fts WHERE search_fts MATCH ? ORDER BY rowid")
        .all(ftsTermExpression(word)),
    );
    return { chunks, paths, matches, dirty: db.prepare("SELECT COUNT(*) AS count FROM search_dirty").get() };
  } finally {
    db.close();
  }
}

describe("recall ranking with per-term counts", () => {
  it("returns exactly the original ranking for recall, relaxed Knowledge search, and focused context", () => {
    const { store, roots } = seedCorpus();
    const recallInputs: Array<Parameters<WorkIntelligenceStore["recall"]>[0]> = [
      { q: "kiln", limit: 20 },
      { q: "kiln zzyzx", limit: 20 },
      { q: "kiln glaze ferry", limit: 20 },
      { q: "manifest harbor crane orchard ledger beacon lantern", limit: 50 },
      { q: "endpoint performance", limit: 20 },
      { q: "茶葉倉庫濕度", limit: 20 },
      { q: "beacon checked", projectRoot: roots[0], limit: 10 },
      { q: "glaze", paths: [join(roots[1]!, "src/glaze/index.ts")], limit: 10 },
      { q: "orchard ledger", from: "2026-03-10", to: "2026-03-30", limit: 10 },
      { q: "zzyzx qqqq", limit: 10 },
      { q: "lant", limit: 10 },
    ];
    for (const input of recallInputs) {
      const current = store.recall(input);
      expect(current.outcome).toBe("recall");
      expect(withOriginalScoreTerms(store, () => store.recall(input))).toEqual(current);
    }
    const knowledgeQueries = ["kiln config", "beacon zzyzx", "lantern test ferry src/kiln/index.ts", "qqqq", "rule"];
    for (const q of knowledgeQueries) {
      for (const projectRoot of [roots[0], undefined]) {
        const current = store.searchKnowledgeForAgent({ q, ...(projectRoot ? { projectRoot } : {}) });
        expect(
          withOriginalScoreTerms(store, () =>
            store.searchKnowledgeForAgent({ q, ...(projectRoot ? { projectRoot } : {}) }),
          ),
        ).toEqual(current);
      }
    }
    const focus = { task: "kiln glaze endpoint performance", paths: [join(roots[0]!, "src/kiln/index.ts")] };
    expect(withOriginalScoreTerms(store, () => store.getContext(roots[0], focus))).toEqual(
      store.getContext(roots[0], focus),
    );
  });

  it("counts the same chunks per term as reading every matching rowid", () => {
    const { store } = seedCorpus();
    store.recall({ q: "kiln", limit: 1 });
    const db = searchIndexOf(store).db;
    for (const word of [...WORDS, "茶葉", "lant", "zzyzx"]) {
      const expression = ftsTermExpression(word);
      const rows = db.prepare("SELECT rowid FROM search_fts WHERE search_fts MATCH ?").all(expression);
      expect(db.prepare("SELECT COUNT(*) AS count FROM search_fts WHERE search_fts MATCH ?").get(expression)).toEqual({
        count: rows.length,
      });
    }
  });
});

describe("batched search index sync", () => {
  it("writes the same chunks, rowids, paths, and FTS scores as re-indexing one document at a time", () => {
    const { store, databasePath } = seedCorpus();
    store.recall({ q: "kiln", limit: 1 });
    const db = searchIndexOf(store).db;
    // A bulk change: every document dirty, some of them edited, one voided Session that must lose its rows.
    db.exec(`
      UPDATE sessions SET title = title || ' beacon' WHERE rowid % 3 = 0;
      UPDATE sessions SET voided_at = '2026-05-01T00:00:00.000Z' WHERE rowid = 5;
      INSERT OR IGNORE INTO search_dirty (doc_type, doc_id) SELECT 'session', id FROM sessions;
      INSERT OR IGNORE INTO search_dirty (doc_type, doc_id) SELECT 'knowledge', id FROM knowledge;
    `);
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const originalPath = join(tempDir(), "original.sqlite");
    copyFileSync(databasePath, originalPath);

    openStore(databasePath).search("kiln");
    const original = openStore(originalPath);
    const index = searchIndexOf(original);
    // The removal before batching: each dirty document's FTS rows, chunks, and paths, one document at a time.
    index.removeDirtyDocuments = function (this: SearchIndexInternals, statements: unknown) {
      const dirty = this.db.prepare("SELECT doc_type, doc_id FROM search_dirty").all() as Array<{
        doc_type: string;
        doc_id: string;
      }>;
      for (const row of dirty) this.removeDocument(statements, row.doc_type, row.doc_id);
    };
    original.search("kiln");
    for (const opened of stores.splice(0)) opened.close();

    const batched = dumpIndex(databasePath);
    expect(batched).toEqual(dumpIndex(originalPath));
    expect((batched as { dirty: { count: number } }).dirty.count).toBe(0);
  });

  it("keeps a just-finalized Session searchable on the next read", () => {
    const { store, roots } = seedCorpus();
    store.recall({ q: "kiln", limit: 1 });
    finalize(store, roots[0]!, "fresh", { title: "Heliotrope siphon calibration" });
    const result = store.recall({ q: "heliotrope siphon", limit: 5 });
    expect(result.outcome === "recall" ? result.hits.map((hit) => hit.title) : []).toEqual([
      "Heliotrope siphon calibration",
    ]);
  });
});

describe("Session list text query in one scan", () => {
  it("returns the same items, total, and clamped page info as the COUNT plus LIMIT/OFFSET reads", () => {
    const { store, roots } = seedCorpus();
    const context = store.getContext(roots[0]);
    const projectId = context.outcome === "context" ? context.project?.id : undefined;
    expect(projectId).toBeDefined();
    const db = searchIndexOf(store).db;
    const sessions = (store as unknown as { sessions: { listTextQueryPage: unknown } }).sessions;
    const current = sessions.listTextQueryPage;
    const cases = [
      { query: "kiln", page: 1, pageSize: 5 },
      { query: "kiln", page: 3, pageSize: 5 },
      { query: "kiln", page: 999, pageSize: 5 },
      { query: "kiln", pageSize: 0 },
      { query: "glaze beacon", page: 1, pageSize: 20 },
      { query: "orchard", projectId, trackedOnly: true, page: 2, pageSize: 3 },
      { query: "src/kiln", page: 1, pageSize: 10 },
      { query: "zzqx", page: 1, pageSize: 20 },
      { query: "routing", voided: "include" as const, from: "2026-03-05", to: "2026-03-25", page: 1, pageSize: 4 },
    ];
    const results = cases.map((options) => store.listSessionsPage(options));
    // The original two reads: COUNT for the total, then the page with LIMIT/OFFSET over the same filter.
    sessions.listTextQueryPage = function (
      this: {
        buildPageInfo: (
          page?: number,
          pageSize?: number,
          total?: number,
          max?: number,
        ) => { page: number; pageSize: number };
        mapSession: (row: unknown) => unknown;
      },
      where: string,
      parameters: Array<string | number | null>,
      options: { page?: number; pageSize?: number },
    ) {
      const total = db
        .prepare(`SELECT COUNT(*) AS count FROM sessions s JOIN projects p ON p.id = s.project_id ${where}`)
        .get(...parameters) as { count: number };
      const pageInfo = this.buildPageInfo(options.page, options.pageSize, total.count, 100);
      const rows = db
        .prepare(
          `SELECT s.*, p.name AS project_name FROM sessions s JOIN projects p ON p.id = s.project_id ${where}
           ORDER BY s.completed_at DESC, s.id DESC LIMIT ? OFFSET ?`,
        )
        .all(...parameters, pageInfo.pageSize, (pageInfo.page - 1) * pageInfo.pageSize);
      return { outcome: "sessions", items: rows.map(this.mapSession), pageInfo };
    };
    try {
      expect(cases.map((options) => store.listSessionsPage(options))).toEqual(results);
    } finally {
      sessions.listTextQueryPage = current;
    }
    expect(results[0]?.items).toHaveLength(5);
    expect(results[2]?.pageInfo.page).toBe(results[2]?.pageInfo.totalPages);
  });
});

describe("join-order rewrites", () => {
  it("lists, counts, and groups the same rows as the plain joins", () => {
    const { store } = seedCorpus();
    const db = searchIndexOf(store).db;
    db.exec("UPDATE sessions SET voided_at = '2026-05-01T00:00:00.000Z' WHERE rowid IN (2, 9)");
    for (const limit of [1, 6, 12, 200]) {
      expect(store.listSessions({ limit, trackedOnly: true })).toEqual(
        store.listSessionsPage({ trackedOnly: true, page: 1, pageSize: limit }).items,
      );
    }
    expect(store.getDashboardSummary().recordedEvents).toBe(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM work_events e JOIN sessions s ON s.id = e.session_id
             JOIN projects p ON p.id = s.project_id WHERE p.status = 'tracked' AND s.voided_at IS NULL`,
          )
          .get() as { count: number }
      ).count,
    );
    store.recall({ q: "kiln", limit: 1 });
    const touched = (from: string) =>
      db
        .prepare(
          `SELECT DISTINCT sp.project_id, sp.path, s.id FROM ${from} JOIN projects p ON p.id = sp.project_id
           WHERE sp.doc_type = 'session' AND sp.weight >= 1 AND p.status = 'tracked' AND s.voided_at IS NULL
             AND s.completed_at >= ? AND s.completed_at < ? ORDER BY 1, 2, 3`,
        )
        .all("2026-03-05T00:00:00.000Z", "2026-03-30T00:00:00.000Z");
    const periodRows = touched("sessions s CROSS JOIN search_paths sp ON sp.doc_type = 'session' AND sp.doc_id = s.id");
    expect(periodRows.length).toBeGreaterThan(0);
    expect(periodRows).toEqual(touched("search_paths sp JOIN sessions s ON s.id = sp.doc_id"));
  });
});

describe("page records shared within one context read", () => {
  it("builds a project's page records once per getContext and reads them again on the next call", () => {
    const { store, roots } = seedCorpus();
    const db = searchIndexOf(store).db;
    const prepare = vi.spyOn(db, "prepare");
    const pageReads = () =>
      prepare.mock.calls.filter(([sql]) => sql.includes("FROM knowledge_pages WHERE project_id IN")).length;
    const pending = () => {
      const context = store.getContext(roots[0]);
      return context.outcome === "context" ? context.pendingRequests.knowledgePages : [];
    };

    expect(pending()).toEqual([]);
    const firstReads = pageReads();
    expect(store.requestKnowledgePageUpdate({ projectRoot: roots[0]!, slug: "pitfalls" }).outcome).not.toBe("skipped");
    prepare.mockClear();
    expect(pending().map((page) => page.slug)).toEqual(["pitfalls"]);
    expect(pageReads()).toBe(1);
    expect(firstReads).toBeLessThanOrEqual(1);
    prepare.mockRestore();
  });
});
