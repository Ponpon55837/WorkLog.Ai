import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  appliesToStrength,
  createAppliesToBudget,
  MAX_STORED_APPLIES_TO_JSON_BYTES,
} from "../../packages/storage/src/applies-to-match.js";
import { findKnowledgeToReview } from "../../packages/storage/src/knowledge-review-hint.js";
import {
  rankRelatedPending,
  rankRelatedPendingWithin,
  RELATED_PENDING_UNIT_LIMIT,
} from "../../packages/storage/src/outstanding-item-relevance.js";
import {
  LIST_SEARCH_SCAN_BUDGET,
  MAX_LIST_SEARCH_TERM_LENGTH,
  MAX_LIST_SEARCH_TERMS,
  parseListSearchTerms,
  setListSearchScanProbe,
  type ListSearchScanProbe,
} from "../../packages/storage/src/list-search-scan.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional data only. Each case builds the largest stored data the write limits allow (or a hand-written row above
// them) with the most expensive caller input, and checks deterministic counters, never time.
const ENTRY = "a".repeat(1_000);
/** 30 entries of 1,000 characters; the last ends with every near-miss word's tail, so each word matches only there. */
const MAX_APPLIES_TO = JSON.stringify(
  Array.from({ length: 30 }, (_, index) => (index === 29 ? `${ENTRY.slice(8)}bbbbbbbb` : `${index}${ENTRY.slice(1)}`)),
);
/** Eight distinct near-miss words at the length cap: almost every stored position matches all but their tails. */
const NEAR_MISS_QUERY = Array.from(
  { length: MAX_LIST_SEARCH_TERMS },
  (_, index) => `${"a".repeat(MAX_LIST_SEARCH_TERM_LENGTH - 1 - index)}${"b".repeat(index + 1)}`,
).join(" ");

const cleanups: Array<() => void> = [];

function trackedStore(): { store: WorkIntelligenceStore; root: string; db: DatabaseSync; projectId: string } {
  const store = new WorkIntelligenceStore(":memory:");
  const root = mkdtempSync(join(tmpdir(), "wi-text-bounds-"));
  cleanups.push(
    () => rmSync(root, { recursive: true, force: true }),
    () => store.close(),
  );
  const project = store.addProject("Synthetic Bounds", root);
  store.updateProject(project.id, { status: "tracked" });
  return { store, root, db: (store as unknown as { db: DatabaseSync }).db, projectId: project.id };
}

function probe(budget?: number): ListSearchScanProbe {
  const scans: ListSearchScanProbe = { scans: [], ...(budget === undefined ? {} : { budget }) };
  setListSearchScanProbe(scans);
  cleanups.push(() => setListSearchScanProbe(undefined));
  return scans;
}

function recordKnowledge(store: WorkIntelligenceStore, root: string, key: string, appliesTo: string[] = []): string {
  const result = store.recordKnowledge({
    projectRoot: root,
    idempotencyKey: key,
    kind: "gotcha",
    title: `Synthetic rule ${key}`,
    body: `Synthetic body ${key}.`,
    appliesTo,
  });
  if (result.outcome !== "knowledge_recorded") throw new Error(`Could not record ${key}`);
  return result.knowledge.id;
}

function finalize(
  store: WorkIntelligenceStore,
  root: string,
  key: string,
  changedFiles: string[],
  completedAt: string,
) {
  const result = store.finalizeSession({
    projectRoot: root,
    idempotencyKey: key,
    title: `Synthetic Session ${key}`,
    summary: "Synthetic change.",
    workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
    changedFiles,
    verification: { status: "passed" },
    completedAt,
  });
  if (result.outcome !== "finalized") throw new Error(`Could not finalize ${key}`);
  return result;
}

function knowledgeBytes(db: DatabaseSync): { bytes: number; rows: number } {
  return db
    .prepare(
      `SELECT COUNT(*) AS rows, SUM(octet_length(title) + octet_length(body) + octet_length(tags_json)
         + octet_length(references_json) + octet_length(applies_to_json)) AS bytes FROM knowledge`,
    )
    .get() as { bytes: number; rows: number };
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("list search terms", () => {
  it("cuts a word to its first 200 characters and ignores words after the eighth, saying so", () => {
    const long = `${"x".repeat(MAX_LIST_SEARCH_TERM_LENGTH)}tail`;
    const parsed = parseListSearchTerms(`one ${long} two three four five six seven eight nine ten`);
    expect(parsed.terms).toHaveLength(MAX_LIST_SEARCH_TERMS);
    expect(parsed.terms[1]).toBe("x".repeat(MAX_LIST_SEARCH_TERM_LENGTH));
    expect(parsed.warnings).toEqual([
      expect.stringContaining("Search word 2 is longer than 200 characters"),
      expect.stringContaining("3 more were ignored"),
    ]);
    // Ordinary queries (2-6 short words, paths) are unchanged and warn about nothing.
    expect(parseListSearchTerms('report "time zone" packages/storage/src/search-repository.ts')).toEqual({
      terms: ["report", "time zone", "packages/storage/src/search-repository.ts"],
      warnings: [],
    });
  });
});

describe("Knowledge list search", () => {
  it("charges every stored byte once per word before the words read it, for the largest allowed rows", () => {
    const { store, root, db } = trackedStore();
    for (let index = 0; index < 12; index += 1) recordKnowledge(store, root, `k${index}`);
    db.prepare("UPDATE knowledge SET body = ?, applies_to_json = ?").run("a".repeat(20_000), MAX_APPLIES_TO);
    const scans = probe();
    // Every word matches only at the end of appliesTo, so SQLite reads every row once per word.
    const result = store.searchKnowledge({ projectRoot: root, q: NEAR_MISS_QUERY });
    expect(result).toMatchObject({ outcome: "knowledge", pageInfo: { total: 12 } });
    expect(result.outcome === "knowledge" && result.warnings).toBeFalsy();
    const { bytes, rows } = knowledgeBytes(db);
    expect(scans.scans).toHaveLength(1);
    const [scan] = scans.scans;
    expect(scan).toMatchObject({
      exhausted: false,
      rowsCharged: rows * MAX_LIST_SEARCH_TERMS,
      bytesCharged: bytes * MAX_LIST_SEARCH_TERMS,
    });
    expect(scan!.charged).toBe((bytes + rows) * MAX_LIST_SEARCH_TERMS);
    expect(scan!.charged).toBeLessThanOrEqual(LIST_SEARCH_SCAN_BUDGET);
    // A row the first word rules out is charged once, not once per word.
    const missing = probe();
    store.searchKnowledge({ projectRoot: root, q: `zzz ${NEAR_MISS_QUERY}` });
    expect(missing.scans[0]).toMatchObject({ rowsCharged: rows, charged: bytes + rows });
  });

  it("stops at the scan budget, never reads a row it cannot afford, and says the result may be incomplete", () => {
    const { store, root, db } = trackedStore();
    for (let index = 0; index < 6; index += 1) recordKnowledge(store, root, `k${index}`);
    db.prepare("UPDATE knowledge SET body = ?").run(`needle ${"a".repeat(5_000)}`);
    const { bytes, rows } = knowledgeBytes(db);
    // Enough for about two rows: the others hold the word but are never searched.
    const scans = probe(Math.floor((2.5 * (bytes + rows)) / rows));
    const result = store.searchKnowledge({ projectRoot: root, q: "needle" });
    if (result.outcome !== "knowledge") throw new Error("Expected a Knowledge result.");
    const [scan] = scans.scans;
    expect(scan!.exhausted).toBe(true);
    expect(scan!.charged).toBeLessThanOrEqual(scans.budget!);
    expect(scan!.rowsCharged).toBe(2);
    expect(result.items).toHaveLength(2);
    expect(result.pageInfo.total).toBe(2);
    expect(result.warnings).toEqual([expect.stringContaining("text-scan limit")]);
  });

  it("matches a cut word by its prefix and reports the cut to the Agent search too", () => {
    const { store, root, db } = trackedStore();
    const id = recordKnowledge(store, root, "long");
    const word = `${"q".repeat(MAX_LIST_SEARCH_TERM_LENGTH)}rest`;
    db.prepare("UPDATE knowledge SET body = ? WHERE id = ?").run(`Synthetic ${word}.`, id);
    const result = store.searchKnowledgeForAgent({ projectRoot: root, q: word });
    expect(result).toMatchObject({ match: "strict", items: [{ id }] });
    expect(result.outcome === "knowledge" && result.warnings).toEqual([
      expect.stringContaining("longer than 200 characters"),
    ]);
  });

  it("shares one budget across the other-status counts of an empty Agent search", () => {
    const { store, root, db } = trackedStore();
    for (let index = 0; index < 4; index += 1) recordKnowledge(store, root, `k${index}`);
    db.prepare("UPDATE knowledge SET body = ?, status = 'archived'").run("a".repeat(5_000));
    const scans = probe(10_000);
    const result = store.searchKnowledgeForAgent({ projectRoot: root, q: "zzz" });
    // The strict scan has its own budget; the counts of the other statuses spend one budget between them.
    const counts = scans.scans.slice(1);
    expect(counts.length).toBeGreaterThan(0);
    expect(counts.reduce((total, scan) => total + scan.charged, 0)).toBeLessThanOrEqual(LIST_SEARCH_SCAN_BUDGET);
    expect(result.outcome === "knowledge" && result.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("otherStatusMatches may be low")]),
    );
  });
});

describe("Sessions list search", () => {
  it("charges title, summary, work summary, changed files and events before the words read them", () => {
    const { store, root, db } = trackedStore();
    const line = "a".repeat(4_000);
    for (let index = 0; index < 3; index += 1) {
      const result = store.finalizeSession({
        projectRoot: root,
        idempotencyKey: `s${index}`,
        title: "a".repeat(300),
        summary: "a".repeat(20_000),
        workSummary: {
          outcomes: Array(20).fill(line),
          scope: Array(20).fill(line),
          decisions: [],
          verification: Array(20).fill(line),
          nextSteps: [],
        },
        changedFiles: Array.from({ length: 200 }, (_, file) => `${file}${ENTRY.slice(1)}`),
        verification: { status: "passed" },
        events: Array.from({ length: 5 }, () => ({ type: "note" as const, summary: "a".repeat(2_000) })),
      });
      if (result.outcome !== "finalized") throw new Error("Could not finalize.");
    }
    const scans = probe();
    const result = store.listSessionsPage({ query: NEAR_MISS_QUERY, trackedOnly: true });
    expect(result).toMatchObject({ items: [], pageInfo: { total: 0 } });
    const stored = db
      .prepare(
        `SELECT COUNT(*) AS rows, SUM(octet_length(title) + octet_length(summary) + octet_length(work_summary_json)
           + octet_length(changed_files_json)) + (SELECT SUM(octet_length(summary)) FROM work_events) AS bytes
         FROM sessions`,
      )
      .get() as { rows: number; bytes: number };
    // The first near-miss word rules every row out, after being charged for all of its text.
    const [scan] = scans.scans;
    expect(scan).toMatchObject({ exhausted: false, rowsCharged: stored.rows, bytesCharged: stored.bytes });
    expect(scan!.charged).toBe(stored.bytes + stored.rows);

    // About one and a half rows for a one-word query: the first row matches, the second is never read.
    probe(Math.floor((1.5 * (stored.bytes + stored.rows)) / stored.rows));
    expect(store.listSessionsPage({ query: "a", trackedOnly: true })).toMatchObject({
      items: [{}],
      warnings: [expect.stringContaining("text-scan limit")],
    });
  });
});

describe("recall path comparison", () => {
  it("charges each stored path before the substring test and reports a spent budget", () => {
    const { store, root } = trackedStore();
    finalize(store, root, "paths", ["src/alpha/one.ts", "src/beta/two.ts"], "2026-03-01T10:00:00.000Z");
    const scans = probe();
    const ordinary = store.recall({ projectRoot: root, paths: ["src/alpha"] });
    expect(ordinary).toMatchObject({ outcome: "recall", hits: [{}] });
    expect(ordinary.outcome === "recall" && ordinary.warnings).toBeFalsy();
    expect(scans.scans[0]!.rowsCharged).toBeGreaterThan(0);
    probe(1);
    expect(store.recall({ projectRoot: root, paths: ["src/alpha"] })).toMatchObject({
      warnings: [expect.stringContaining("text-scan limit")],
    });
  });
});

describe("finalize knowledgeToReview", () => {
  it("reads later Sessions in one pass shared by every candidate", () => {
    const { store, root, db, projectId } = trackedStore();
    const ids = Array.from({ length: 40 }, (_, index) => recordKnowledge(store, root, `c${index}`, ["src/lease.ts"]));
    db.prepare("UPDATE knowledge SET created_at = ?, updated_at = ?").run(
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
    // The oldest later Session touches every candidate; the newer ones only contain the fragment.
    finalize(store, root, "touch", ["src/lease.ts"], "2026-02-01T00:00:00.000Z");
    for (let index = 0; index < 60; index += 1) {
      finalize(
        store,
        root,
        `near${index}`,
        [`src/lease.ts.${index}.bak`],
        `2026-02-02T00:${String(index).padStart(2, "0")}:00.000Z`,
      );
    }
    const session = finalize(store, root, "focus", ["src/lease.ts"], "2026-03-01T00:00:00.000Z").session;
    const scans = probe();
    const result = findKnowledgeToReview(db, {
      projectId,
      sessionId: session.id,
      completedAt: session.completedAt,
      changedFiles: ["src/lease.ts"],
      project: { name: "Synthetic Bounds", rootPath: root },
    });
    expect(result).toEqual({ hints: [], truncated: false });
    // One pass over the 61 later Sessions, not one per candidate (40 x 61 rows before).
    expect(scans.scans).toHaveLength(1);
    expect(scans.scans[0]!.rowsCharged).toBe(61);
    expect(ids).toHaveLength(40);
  });

  it("stops with knowledgeToReviewTruncated when the pass cannot afford the next Session", () => {
    const { store, root, db, projectId } = trackedStore();
    recordKnowledge(store, root, "c", ["src/lease.ts"]);
    db.prepare("UPDATE knowledge SET created_at = ?, updated_at = ?").run(
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
    for (let index = 0; index < 5; index += 1) {
      finalize(store, root, `near${index}`, [`src/lease.ts.${index}.bak`], `2026-02-0${index + 1}T00:00:00.000Z`);
    }
    const session = finalize(store, root, "focus", ["src/lease.ts"], "2026-03-01T00:00:00.000Z").session;
    const scans = probe(1);
    const result = findKnowledgeToReview(db, {
      projectId,
      sessionId: session.id,
      completedAt: session.completedAt,
      changedFiles: ["src/lease.ts"],
      project: { name: "Synthetic Bounds", rootPath: root },
    });
    expect(result).toEqual({ hints: [], truncated: true });
    expect(scans.scans[0]!.exhausted).toBe(true);
  });
});

describe("staleness check", () => {
  it("charges later changed-file lists before parsing them and marks the records unchecked when spent", () => {
    const { store, root, db } = trackedStore();
    const id = recordKnowledge(store, root, "stale", ["src/target.ts"]);
    db.prepare("UPDATE knowledge SET created_at = ?, updated_at = ?").run(
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
    const files = Array.from({ length: 200 }, (_, file) => `${file}${ENTRY.slice(1)}`);
    finalize(store, root, "seed", files, "2026-02-01T00:00:00.000Z");
    // Copies of the largest allowed list: 40 x 200 x 1,000 characters is more than the staleness budget can parse.
    const row = db.prepare("SELECT * FROM sessions WHERE idempotency_key = 'seed'").get() as Record<string, unknown>;
    const columns = Object.keys(row);
    const insert = db.prepare(
      `INSERT INTO sessions (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    );
    for (let index = 0; index < 40; index += 1) {
      const copy: Record<string, unknown> = { ...row, id: `copy-${index}`, idempotency_key: `copy-${index}` };
      insert.run(...(columns.map((column) => copy[column]) as Array<string | number | null>));
    }
    finalize(store, root, "touch", ["src/target.ts"], "2026-02-02T00:00:00.000Z");
    const result = store.searchKnowledge({ projectRoot: root });
    expect(result).toMatchObject({ items: [{ id, stalenessUnchecked: true }] });
    expect(result.outcome === "knowledge" && result.items[0]!.possiblyStale).toBeFalsy();
    // Ordinary history is read whole and gives the marker.
    db.prepare("DELETE FROM sessions WHERE id LIKE 'copy-%'").run();
    expect(store.searchKnowledge({ projectRoot: root })).toMatchObject({
      items: [{ id, possiblyStale: { sessionCount: 1 } }],
    });
  });
});

describe("stored appliesTo above the load bound", () => {
  it("is never loaded, never matches, and marks the scans incomplete", () => {
    const { store, root, db, projectId } = trackedStore();
    const id = recordKnowledge(store, root, "huge", ["src/lease.ts"]);
    const huge = JSON.stringify(["src/lease.ts", "b".repeat(MAX_STORED_APPLIES_TO_JSON_BYTES)]);
    db.prepare("UPDATE knowledge SET applies_to_json = ? WHERE id = ?").run(huge, id);
    expect(store.getFileHistory({ projectRoot: root, paths: ["src/lease.ts"] })).toMatchObject({
      knowledge: [],
      appliesToScanTruncated: true,
    });
    const session = finalize(store, root, "focus", ["src/lease.ts"], "2026-03-01T00:00:00.000Z").session;
    expect(
      findKnowledgeToReview(db, {
        projectId,
        sessionId: session.id,
        completedAt: session.completedAt,
        changedFiles: ["src/lease.ts"],
        project: { name: "Synthetic Bounds", rootPath: root },
      }),
    ).toEqual({ hints: [], truncated: true });
    expect(store.searchKnowledgeForAgent({ projectRoot: root, q: "unrelated src/lease.ts" })).toMatchObject({
      appliesToScanTruncated: true,
    });
  });
});

describe("related pending items", () => {
  it("charges each candidate's text per term and each stored path per query path before scoring it", () => {
    const files = JSON.stringify(Array.from({ length: 200 }, (_, file) => `src/${file}/${"a".repeat(990)}`));
    const candidates = Array.from({ length: 10 }, (_, index) => ({
      id: `item-${index}`,
      source_session_id: `session-${index}`,
      source_session_completed_at: `2026-01-${String(20 - index).padStart(2, "0")}T00:00:00.000Z`,
      position: 0,
      text_key: `${index} ${"a".repeat(3_990)}`,
      title_key: "a".repeat(300),
      summary_key: "a".repeat(2_000),
      changed_files_json: files,
    }));
    const focus = {
      terms: Array.from({ length: 24 }, (_, term) => `${"a".repeat(78)}${String.fromCharCode(98 + (term % 20))}z`),
      paths: Array.from({ length: 20 }, (_, path) => `src/${path}/${"a".repeat(989)}b`),
      sources: [],
    };
    const full = rankRelatedPendingWithin(candidates, focus, Number.POSITIVE_INFINITY);
    const perCandidate = full.units / candidates.length;
    // Each candidate: three text keys x 24 terms, plus its Session's list parsed and compared with 20 query paths.
    const text = (4_000 + 300 + 2_000 + 3) * 24;
    const paths = 4 * files.length + 1 + 200 * (`src/0/${"a".repeat(990)}`.length + 16) * 20;
    expect(perCandidate).toBeGreaterThanOrEqual(text + paths - 200 * 20 * 3);
    const cut = rankRelatedPendingWithin(candidates, focus, perCandidate * 3.5);
    expect(cut).toMatchObject({ exhausted: true });
    expect(cut.units).toBeLessThanOrEqual(perCandidate * 3.5);
    // Ordinary candidates rank exactly as before.
    const ordinary = [
      { ...candidates[0]!, text_key: "fix the lease renewal", changed_files_json: '["src/lease.ts"]' },
      { ...candidates[1]!, text_key: "update docs", changed_files_json: "[]" },
    ];
    const ordinaryFocus = { terms: ["lease"], paths: ["src/lease.ts"], sources: [] };
    expect(rankRelatedPendingWithin(ordinary, ordinaryFocus, RELATED_PENDING_UNIT_LIMIT)).toMatchObject({
      ranked: rankRelatedPending(ordinary, ordinaryFocus),
      exhausted: false,
    });
  });
});

describe("glob classification", () => {
  it("charges telling a plain entry from a glob by its length on every pair", () => {
    const budget = createAppliesToBudget();
    const pattern = "p".repeat(1_000);
    appliesToStrength(pattern, "src/a.ts", budget);
    // The classification scan (1,000) plus the pair's constant work: nothing is left uncharged.
    expect(budget.units).toBeGreaterThanOrEqual(1_000 + 12);
  });
});
