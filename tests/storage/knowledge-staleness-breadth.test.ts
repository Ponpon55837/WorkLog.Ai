import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FinalizeSessionInput, KnowledgeRecord } from "../../packages/core/src/index.js";
import {
  BREADTH_SCAN_LIMIT,
  BROAD_APPLIES_TO_SHARE,
  MIN_BREADTH_SESSIONS,
} from "../../packages/storage/src/knowledge-breadth.js";
import { setStalenessUnitLimits } from "../../packages/storage/src/later-change-index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only. Later Sessions that list more than 20 files are counted apart (broadChangesSince) and never
// set possiblyStale; appliesTo breadth is the share of the later Sessions with 1-20 files that touch appliesTo.
const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  setStalenessUnitLimits(undefined);
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-staleness-breadth-"));
  tempDirs.push(root);
  const databasePath = join(root, "breadth.sqlite");
  const store = new WorkIntelligenceStore(databasePath);
  stores.push(store);
  const project = store.addProject("Meadow", root);
  store.updateProject(project.id, { status: "tracked" });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2030, 0, 1));
  const tick = () => vi.setSystemTime(Date.now() + 60_000);
  const finalize = (key: string, changedFiles: string[], overrides: Partial<FinalizeSessionInput> = {}) => {
    tick();
    const result = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: key,
      title: `Session ${key}`,
      summary: `${key} summary.`,
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles,
      verification: { status: "passed" },
      ...overrides,
    });
    if (result.outcome !== "finalized") throw new Error("Expected finalize");
    return result;
  };
  const wide = (key: string, touching: string): string[] => [
    touching,
    ...Array.from({ length: 24 }, (_, index) => `vendor/${key}/file-${index}.ts`),
  ];
  const record = (key: string, appliesTo: string[]) => {
    tick();
    const result = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: key,
      kind: "gotcha",
      title: `Clover ${key}`,
      body: "Mow before the seed heads open.",
      appliesTo,
    });
    if (result.outcome !== "knowledge_recorded") throw new Error("Expected Knowledge");
    return result;
  };
  const read = (id: string): KnowledgeRecord => {
    const result = store.searchKnowledge({ projectRoot: root, limit: 50 });
    const item = result.outcome === "knowledge" ? result.items.find((candidate) => candidate.id === id) : undefined;
    if (!item) throw new Error("Expected the Knowledge in the list");
    return item;
  };
  /** Copies one finalized row into many Sessions, so a test can hold hundreds without finalizing each. */
  const insertRaw = (rows: Array<{ id: string; changedFilesJson: string; completedAt: string }>) => {
    const template = finalize("template", ["template.ts"], { completedAt: "2029-01-01T00:00:00.000Z" });
    const db = new DatabaseSync(databasePath);
    try {
      const source = db.prepare("SELECT * FROM sessions WHERE id = ?").get(template.session.id) as Record<
        string,
        unknown
      >;
      const columns = Object.keys(source);
      const insert = db.prepare(
        `INSERT INTO sessions (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      );
      db.exec("BEGIN");
      for (const row of rows) {
        const copy = {
          ...source,
          id: row.id,
          idempotency_key: row.id,
          completed_at: row.completedAt,
          changed_files_json: row.changedFilesJson,
        };
        insert.run(...(columns.map((column) => copy[column as keyof typeof copy]) as Array<string | number | null>));
      }
      db.exec("COMMIT");
    } finally {
      db.close();
    }
  };
  return { root, store, finalize, wide, record, read, insertRaw, tick };
}

describe("broad Sessions in the staleness check", () => {
  it("counts a Session with more than 20 files without setting possiblyStale", () => {
    const { finalize, wide, record, read } = setup();
    const knowledge = record("only-broad", ["src/field/**"]).knowledge;
    finalize("bulk", wide("bulk", "src/field/a.ts"));

    const item = read(knowledge.id);
    expect(item.possiblyStale).toBeUndefined();
    expect(item.broadChangesSince).toBe(1);
    expect(item.stalenessUnchecked).toBeUndefined();
  });

  it("treats exactly 20 files as focused and 21 as broad", () => {
    const { finalize, record, read } = setup();
    const knowledge = record("edge", ["src/field/**"]).knowledge;
    const files = (count: number) => [
      "src/field/a.ts",
      ...Array.from({ length: count - 1 }, (_, index) => `other/${index}.ts`),
    ];
    const twenty = finalize("twenty", files(20));
    expect(read(knowledge.id).possiblyStale).toMatchObject({ sessionId: twenty.session.id, sessionCount: 1 });
    expect(read(knowledge.id).broadChangesSince).toBeUndefined();
    finalize("twenty-one", files(21));
    expect(read(knowledge.id).possiblyStale).toMatchObject({ sessionCount: 1 });
    expect(read(knowledge.id).broadChangesSince).toBe(1);
  });

  it("reports the first focused Session and counts only focused ones in sessionCount, whatever the order", () => {
    const { finalize, wide, record, read } = setup();
    const knowledge = record("mixed", ["src/field/**"]).knowledge;
    finalize("bulk-first", wide("first", "src/field/a.ts"));
    const focused = finalize("focused", ["src/field/b.ts"]);
    finalize("bulk-second", wide("second", "src/field/c.ts"));
    finalize("focused-again", ["src/field/d.ts"]);

    const item = read(knowledge.id);
    expect(item.possiblyStale).toMatchObject({
      sessionId: focused.session.id,
      sessionTitle: "Session focused",
      paths: ["src/field/b.ts"],
      sessionCount: 2,
    });
    expect(item.broadChangesSince).toBe(2);
  });

  it("does not count the Knowledge's own Session or its last confirming Session as broad", () => {
    const { store, root, finalize, wide, tick, read } = setup();
    const source = finalize("source", ["src/field/source.ts"]);
    tick();
    const recorded = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: "from-session",
      kind: "gotcha",
      title: "From a Session",
      body: "Mow early.",
      sessionId: source.session.id,
      appliesTo: ["src/field/**"],
    });
    if (recorded.outcome !== "knowledge_recorded") throw new Error("Expected Knowledge");
    // A Session that finished after the Knowledge was recorded, changed many files, and confirmed it: it is the last
    // confirming Session, so it is not counted as a broad touch either.
    const confirming = finalize("confirming", wide("confirming", "src/field/c.ts"), {
      appliedKnowledgeIds: [recorded.knowledge.id],
    });
    expect(confirming.session.id).toBeTruthy();
    const item = read(recorded.knowledge.id);
    expect(item.possiblyStale).toBeUndefined();
    expect(item.broadChangesSince).toBeUndefined();

    finalize("later-bulk", wide("later", "src/field/d.ts"));
    expect(read(recorded.knowledge.id).broadChangesSince).toBe(1);
  });

  it("measures breadth over the later Sessions with 1-20 files and marks a wide appliesTo broad_applies_to", () => {
    const { finalize, wide, record, read } = setup();
    const knowledge = record("wide", ["src/field/**"]).knowledge;
    // 12 comparable Sessions after it, 3 of which touch appliesTo (25%); broad Sessions and empty ones are not compared.
    finalize("t1", ["src/field/a.ts"]);
    finalize("t2", ["src/field/b.ts"]);
    finalize("t3", ["src/field/c.ts", "docs/c.md"]);
    for (let index = 0; index < 9; index += 1) finalize(`other-${index}`, [`docs/${index}.md`]);
    finalize("bulk", wide("bulk", "docs/bulk.md"));
    finalize("no-files", []);

    const item = read(knowledge.id);
    expect(item.possiblyStale).toMatchObject({
      sessionCount: 3,
      reason: "broad_applies_to",
      appliesToBreadth: { share: 0.25, sessions: 12 },
    });
    expect(item.broadChangesSince).toBeUndefined();
    expect(0.25).toBeGreaterThan(BROAD_APPLIES_TO_SHARE);
    expect(12).toBeGreaterThanOrEqual(MIN_BREADTH_SESSIONS);
  });

  it("keeps applies_to_changed when the share is high but the sample is too small, or the share is low", () => {
    const small = setup();
    const few = small.record("few", ["src/field/**"]).knowledge;
    small.finalize("t1", ["src/field/a.ts"]);
    small.finalize("t2", ["src/field/b.ts"]);
    small.finalize("t3", ["docs/c.md"]);
    expect(small.read(few.id).possiblyStale).toMatchObject({
      reason: "applies_to_changed",
      appliesToBreadth: { share: 0.667, sessions: 3 },
    });

    const narrow = setup();
    const one = narrow.record("one", ["src/field/**"]).knowledge;
    narrow.finalize("t1", ["src/field/a.ts"]);
    for (let index = 0; index < 11; index += 1) narrow.finalize(`other-${index}`, [`docs/${index}.md`]);
    // 1 of 12 (8.3%) is under the threshold even with a sample large enough to count.
    expect(narrow.read(one.id).possiblyStale).toMatchObject({
      reason: "applies_to_changed",
      appliesToBreadth: { share: 0.083, sessions: 12 },
    });
  });

  it("starts from the later of creation and last confirmation", () => {
    const { store, root, finalize, record, read } = setup();
    const knowledge = record("baseline", ["src/field/**"]).knowledge;
    const before = finalize("before", ["src/field/a.ts"]);
    expect(read(knowledge.id).possiblyStale).toMatchObject({ sessionId: before.session.id });
    // A confirmation dated before the Knowledge existed must not reopen the window to earlier Sessions.
    store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "early-confirm",
      title: "Backfilled",
      summary: "Backfilled.",
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles: [],
      verification: { status: "passed" },
      completedAt: "2029-12-31T00:00:00.000Z",
      appliedKnowledgeIds: [knowledge.id],
    });
    const item = read(knowledge.id);
    expect(item.lastConfirmedAt).toBe("2029-12-31T00:00:00.000Z");
    expect(item.possiblyStale).toMatchObject({ sessionId: before.session.id, sessionCount: 1 });
  });

  it("remembers both signals while the data is unchanged and drops them when it changes", () => {
    const { store, root, finalize, wide, record, read, tick } = setup();
    const knowledge = record("cached", ["src/field/**"]).knowledge;
    finalize("bulk", wide("bulk", "src/field/a.ts"));
    expect(read(knowledge.id).broadChangesSince).toBe(1);
    expect(read(knowledge.id)).toMatchObject({ broadChangesSince: 1 });
    expect(read(knowledge.id).possiblyStale).toBeUndefined();

    finalize("bulk-2", wide("bulk-2", "src/field/b.ts"));
    expect(read(knowledge.id).broadChangesSince).toBe(2);
    const focused = finalize("focused", ["src/field/c.ts"]);
    expect(read(knowledge.id)).toMatchObject({
      broadChangesSince: 2,
      possiblyStale: { sessionId: focused.session.id, sessionCount: 1 },
    });
    // Warm again: the same answer without recomputing.
    expect(read(knowledge.id)).toMatchObject({ broadChangesSince: 2, possiblyStale: { sessionCount: 1 } });

    tick();
    store.updateKnowledge({ projectRoot: root, knowledgeId: knowledge.id, confirm: true });
    const confirmed = read(knowledge.id);
    expect(confirmed.possiblyStale).toBeUndefined();
    expect(confirmed.broadChangesSince).toBeUndefined();
  });
});

describe("appliesTo breadth when Knowledge is written", () => {
  it("warns when appliesTo touches more than the threshold of a large enough sample", () => {
    const { finalize, record } = setup();
    for (let index = 0; index < 12; index += 1) {
      finalize(`s${index}`, index < 6 ? [`src/field/${index}.ts`] : [`docs/${index}.md`]);
    }
    const result = record("broad", ["src/**"]);
    expect(result.appliesToBreadth).toEqual({ share: 0.5, sessions: 12, truncated: false, broad: true });
    expect(result.warnings).toEqual([expect.stringContaining("touches 50% of this project's recent Sessions")]);
    expect(result.warnings![0]).toContain("Narrow it to the specific files or subdirectories");
  });

  it("reports the share without a warning for a narrow appliesTo or a small sample", () => {
    const { finalize, record } = setup();
    for (let index = 0; index < 12; index += 1) finalize(`s${index}`, [`src/field/${index}.ts`]);
    const narrow = record("narrow", ["docs/readme.md"]);
    expect(narrow.appliesToBreadth).toEqual({ share: 0, sessions: 12, truncated: false, broad: false });
    expect(narrow.warnings).toBeUndefined();

    const fresh = setup();
    for (let index = 0; index < MIN_BREADTH_SESSIONS - 1; index += 1) fresh.finalize(`s${index}`, ["src/a.ts"]);
    const small = fresh.record("small", ["src/**"]);
    expect(small.appliesToBreadth).toEqual({
      share: 1,
      sessions: MIN_BREADTH_SESSIONS - 1,
      truncated: false,
      broad: false,
    });
    expect(small.warnings).toBeUndefined();
  });

  it("says nothing without appliesTo, without comparable Sessions, or for a duplicate retry", () => {
    const { store, root, finalize, wide, record } = setup();
    expect(record("none", []).appliesToBreadth).toBeUndefined();
    finalize("bulk", wide("bulk", "src/a.ts"));
    finalize("empty", []);
    expect(record("no-sample", ["src/**"]).appliesToBreadth).toBeUndefined();
    for (let index = 0; index < 12; index += 1) finalize(`s${index}`, [`src/${index}.ts`]);
    const first = record("retry", ["src/**"]);
    expect(first.warnings).toBeDefined();
    const duplicate = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: "retry",
      kind: "gotcha",
      title: "Clover retry",
      body: "Mow before the seed heads open.",
      appliesTo: ["src/**"],
    });
    expect(duplicate).toMatchObject({ outcome: "knowledge_recorded", duplicate: true });
    expect(duplicate).not.toHaveProperty("appliesToBreadth");
  });

  it("scans only the newest Sessions and says when more matched", () => {
    const { insertRaw, record } = setup();
    const total = BREADTH_SCAN_LIMIT + 5;
    // The oldest five touch appliesTo; the newest 200 do not, so truncation must hide those five.
    insertRaw(
      Array.from({ length: total }, (_, index) => ({
        id: `bulk-${index}`,
        changedFilesJson: JSON.stringify([index < 5 ? "src/field/old.ts" : `docs/${index}.md`]),
        completedAt: new Date(Date.UTC(2029, 5, 1) + index * 1000).toISOString(),
      })),
    );
    const result = record("truncated", ["src/field/**"]);
    expect(result.appliesToBreadth).toEqual({ share: 0, sessions: BREADTH_SCAN_LIMIT, truncated: true, broad: false });

    // The copied template Session makes one more, so this project has exactly BREADTH_SCAN_LIMIT.
    const exact = setup();
    exact.insertRaw(
      Array.from({ length: BREADTH_SCAN_LIMIT - 1 }, (_, index) => ({
        id: `exact-${index}`,
        changedFilesJson: JSON.stringify([`docs/${index}.md`]),
        completedAt: new Date(Date.UTC(2029, 5, 1) + index * 1000).toISOString(),
      })),
    );
    expect(exact.record("not-truncated", ["src/field/**"]).appliesToBreadth).toMatchObject({
      sessions: BREADTH_SCAN_LIMIT,
      truncated: false,
    });
  });

  it("skips damaged and oversized changed-file lists without failing the write", () => {
    const { insertRaw, record } = setup();
    insertRaw([
      { id: "bad-text", changedFilesJson: "not json", completedAt: "2029-06-01T00:00:00.000Z" },
      { id: "null-text", changedFilesJson: "null", completedAt: "2029-06-01T00:01:00.000Z" },
      { id: "object", changedFilesJson: '{"a":1}', completedAt: "2029-06-01T00:02:00.000Z" },
      { id: "scalar", changedFilesJson: "7", completedAt: "2029-06-01T00:03:00.000Z" },
      { id: "empty", changedFilesJson: "[]", completedAt: "2029-06-01T00:04:00.000Z" },
      { id: "good", changedFilesJson: '["src/field/a.ts"]', completedAt: "2029-06-01T00:05:00.000Z" },
    ]);
    const result = record("damaged", ["src/field/**"]);
    expect(result.outcome).toBe("knowledge_recorded");
    // Only the copied template Session (one file) and the good row are comparable.
    expect(result.appliesToBreadth).toMatchObject({ share: 0.5, sessions: 2, truncated: false });
  });

  it("is reported by an update only when appliesTo changes", () => {
    const { store, root, finalize, record, tick } = setup();
    for (let index = 0; index < 12; index += 1) finalize(`s${index}`, [`src/field/${index}.ts`]);
    const knowledge = record("update", ["docs/readme.md"]).knowledge;

    tick();
    const titled = store.updateKnowledge({ projectRoot: root, knowledgeId: knowledge.id, title: "Clover rule" });
    expect(titled).toMatchObject({ outcome: "knowledge_updated" });
    expect(titled).not.toHaveProperty("appliesToBreadth");
    tick();
    const confirmed = store.updateKnowledge({ projectRoot: root, knowledgeId: knowledge.id, confirm: true });
    expect(confirmed).not.toHaveProperty("appliesToBreadth");
    tick();
    const same = store.updateKnowledge({
      projectRoot: root,
      knowledgeId: knowledge.id,
      appliesTo: ["docs/readme.md"],
    });
    expect(same).not.toHaveProperty("appliesToBreadth");

    tick();
    const widened = store.updateKnowledge({ projectRoot: root, knowledgeId: knowledge.id, appliesTo: ["src/**"] });
    if (widened.outcome !== "knowledge_updated") throw new Error("Expected an update");
    expect(widened.appliesToBreadth).toEqual({ share: 1, sessions: 12, truncated: false, broad: true });
    expect(widened.warnings).toEqual([expect.stringContaining("touches 100% of this project's recent Sessions")]);

    tick();
    const narrowed = store.updateKnowledge({
      projectRoot: root,
      knowledgeId: knowledge.id,
      appliesTo: ["src/field/3.ts"],
    });
    if (narrowed.outcome !== "knowledge_updated") throw new Error("Expected an update");
    expect(narrowed.appliesToBreadth).toMatchObject({ sessions: 12, truncated: false });
    expect(narrowed.warnings).toBeUndefined();
  });

  it("leaves the result without a breadth, and says so, when the comparison budget runs out", () => {
    const { finalize, record } = setup();
    for (let index = 0; index < 12; index += 1) finalize(`s${index}`, [`src/field/${index}.ts`]);
    setStalenessUnitLimits({ history: 1 });
    const result = record("unchecked", ["src/**"]);
    expect(result.outcome).toBe("knowledge_recorded");
    expect(result.appliesToBreadth).toBeUndefined();
    expect(result.warnings).toEqual([expect.stringContaining("appliesTo breadth was not checked")]);
  });
});
