import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { KnowledgeRecord, KnowledgeStaleness } from "../../packages/core/src/index.js";
import { setAppliesToBudgetProbe, type AppliesToBudget } from "../../packages/storage/src/applies-to-match.js";
import {
  setStalenessUnitLimits,
  STALENESS_HISTORY_UNIT_LIMIT,
  STALENESS_MATCH_UNIT_LIMIT,
} from "../../packages/storage/src/later-change-index.js";
import { normalizePath, pathMatchStrength, type PathContext } from "../../packages/storage/src/search-text.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional data only. The staleness check resolves each appliesTo entry against an index of the paths later Sessions
// changed; these tests compare it with a plain reference that checks every entry against every changed file, and
// check its two fixed ceilings by their deterministic unit counters, never by time.

interface StoredSession {
  id: string;
  title: string;
  completedAt: string;
  files: string[];
  voided: boolean;
}

const PROJECT_NAME = "Synthetic Index";
const SEGMENTS = ["src", "lib", "api", "auth", "Auth", "x.ts", "index.ts", "a", "b", "docs", "readme.md", "App.vue"];
const cleanups: Array<() => void> = [];

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function trackedStore(): { store: WorkIntelligenceStore; root: string; db: DatabaseSync; projectId: string } {
  const store = new WorkIntelligenceStore(":memory:");
  const root = mkdtempSync(join(tmpdir(), "wi-later-index-"));
  cleanups.push(
    () => rmSync(root, { recursive: true, force: true }),
    () => store.close(),
  );
  const project = store.addProject(PROJECT_NAME, root);
  store.updateProject(project.id, { status: "tracked" });
  return { store, root, db: (store as unknown as { db: DatabaseSync }).db, projectId: project.id };
}

/** Inserts Sessions by copying one finalized row, so a test can hold thousands without finalizing each. */
function insertSessions(store: WorkIntelligenceStore, db: DatabaseSync, root: string, sessions: StoredSession[]): void {
  const template = store.finalizeSession({
    projectRoot: root,
    idempotencyKey: "template",
    title: "Synthetic template",
    summary: "Synthetic.",
    workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
    changedFiles: ["template.ts"],
    verification: { status: "passed" },
    completedAt: "2025-01-01T00:00:00.000Z",
  });
  if (template.outcome !== "finalized") throw new Error("Could not finalize the template Session.");
  const row = db.prepare("SELECT * FROM sessions WHERE idempotency_key = 'template'").get() as Record<string, unknown>;
  const columns = Object.keys(row);
  const insert = db.prepare(
    `INSERT INTO sessions (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  );
  db.exec("BEGIN");
  for (const session of sessions) {
    const copy: Record<string, unknown> = {
      ...row,
      id: session.id,
      idempotency_key: session.id,
      title: session.title,
      completed_at: session.completedAt,
      changed_files_json: JSON.stringify(session.files),
      voided_at: session.voided ? session.completedAt : null,
    };
    insert.run(...(columns.map((column) => copy[column]) as Array<string | number | null>));
  }
  db.exec("COMMIT");
}

/** An independent glob rule: `*` one segment, `**` (with a following `/`) anything, `?` one non-separator. */
function globReference(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += pattern[index + 2] === "/" ? 2 : 1;
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/** The rule as written in docs/mcp-tools.md, every entry against every changed file of every later Session. */
function referenceStaleness(
  knowledge: KnowledgeRecord,
  sessions: StoredSession[],
  contexts: PathContext[],
): KnowledgeStaleness | undefined {
  const since = knowledge.lastConfirmedAt ?? knowledge.createdAt;
  const patterns = [...new Set(knowledge.appliesTo.map((raw) => normalizePath(raw, contexts)).filter(Boolean))];
  const own = new Set([knowledge.sessionId, knowledge.lastConfirmedSessionId].filter(Boolean));
  const covers = (file: string): boolean => {
    const path = normalizePath(file, contexts);
    return (
      path !== "" &&
      patterns.some((pattern) =>
        /[*?]/.test(pattern) ? globReference(pattern).test(path) : pathMatchStrength(path, pattern) > 0,
      )
    );
  };
  const touching = sessions
    .filter((session) => !session.voided && session.completedAt > since && !own.has(session.id))
    .sort((left, right) =>
      left.completedAt === right.completedAt
        ? left.id < right.id
          ? -1
          : 1
        : left.completedAt < right.completedAt
          ? -1
          : 1,
    )
    .filter((session) => session.files.some(covers));
  const first = touching[0];
  if (!first) return undefined;
  return {
    sessionId: first.id,
    sessionTitle: first.title,
    completedAt: first.completedAt,
    paths: first.files.filter(covers).slice(0, 5),
    sessionCount: touching.length,
  };
}

/** A changed file as Agents write them: separators, case, `./`, the project root or name, and line anchors vary. */
function randomFile(next: () => number, root: string): string {
  const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!;
  const segments = Array.from({ length: 1 + Math.floor(next() * 4) }, () => pick(SEGMENTS));
  let file = segments
    .map((segment) => (next() < 0.1 ? segment.toUpperCase() : segment))
    .join(next() < 0.15 ? "\\" : "/");
  const prefix = next();
  if (prefix < 0.1) file = `./${file}`;
  else if (prefix < 0.2) file = `${root}${sep}${file}`;
  else if (prefix < 0.25) file = `${PROJECT_NAME}/${file}`;
  const suffix = next();
  if (suffix < 0.05) file += "#L12";
  else if (suffix < 0.1) file += ":7:3";
  else if (suffix < 0.13) file += "/";
  return file;
}

/** An appliesTo entry: a file, a directory, a suffix, a path longer than the files, or a one- or two-star glob. */
function randomEntry(next: () => number, root: string): string {
  const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!;
  const file = randomFile(next, root);
  const parts = normalizePath(file, [{ name: PROJECT_NAME, rootPath: root }]).split("/");
  const one = pick(SEGMENTS);
  const two = pick(SEGMENTS);
  const kind = Math.floor(next() * 12);
  if (kind <= 2) return file;
  if (kind === 3) return parts.slice(0, Math.max(1, parts.length - 1)).join("/");
  if (kind === 4) return parts.slice(-1 - Math.floor(next() * 2)).join("/");
  if (kind === 5) return `deep/${parts.join("/")}`;
  return pick([
    `${one}/*`,
    `**/${one}`,
    "*.ts",
    `${one}/**/*.ts`,
    `?${one.slice(1)}/*`,
    `*${one.slice(0, 2)}*`,
    `${one}/*/${two}`,
    `${one.toUpperCase()}/**`,
  ]);
}

afterEach(() => {
  setAppliesToBudgetProbe(undefined);
  setStalenessUnitLimits(undefined);
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe("staleness index", () => {
  it("gives the reference answer on seeded random Knowledge and Sessions", () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const next = random(seed);
      const { store, root, db } = trackedStore();
      const contexts = [{ name: PROJECT_NAME, rootPath: root }];
      const sessions: StoredSession[] = [];
      const previous: string[] = [];
      for (let index = 0; index < 40; index += 1) {
        const files = Array.from({ length: 1 + Math.floor(next() * 6) }, () => randomFile(next, root));
        // A rename: an earlier file listed again under a new last segment, both names in the same Session.
        if (previous.length > 0 && next() < 0.2) {
          const old = previous[Math.floor(next() * previous.length)]!;
          files.push(old, `${old.replace(/[^/\\]*$/, "")}renamed-${index}.ts`);
        }
        previous.push(...files);
        // Some Sessions share a completion time, so the order falls back to the id.
        const minute = String(Math.floor(index / 2)).padStart(2, "0");
        sessions.push({
          id: `session-${seed}-${String(index).padStart(2, "0")}`,
          title: `Synthetic Session ${index}`,
          completedAt: `2026-02-01T00:${minute}:${next() < 0.5 ? "00" : "30"}.000Z`,
          files,
          voided: next() < 0.05,
        });
      }
      insertSessions(store, db, root, sessions);
      for (let item = 0; item < 12; item += 1) {
        const appliesTo = [
          ...new Set(Array.from({ length: 1 + Math.floor(next() * 5) }, () => randomEntry(next, root))),
        ];
        const recorded = store.recordKnowledge({
          projectRoot: root,
          idempotencyKey: `k${item}`,
          kind: "gotcha",
          title: `Synthetic rule ${item}`,
          body: "Synthetic.",
          appliesTo,
        });
        if (recorded.outcome !== "knowledge_recorded") throw new Error("Could not record Knowledge.");
        const since = next() < 0.3 ? "2026-01-01T00:00:00.000Z" : sessions[Math.floor(next() * 40)]!.completedAt;
        const own = sessions[Math.floor(next() * 40)]!.id;
        const confirmed = next() < 0.3;
        db.prepare(
          `UPDATE knowledge SET created_at = ?, updated_at = ?, session_id = ?, last_confirmed_at = ?,
             last_confirmed_session_id = ? WHERE id = ?`,
        ).run(
          since,
          `2026-03-01T00:00:${String(item).padStart(2, "0")}.000Z`,
          next() < 0.5 ? own : null,
          confirmed ? since : null,
          confirmed && next() < 0.5 ? sessions[Math.floor(next() * 40)]!.id : null,
          recorded.knowledge.id,
        );
      }
      const result = store.searchKnowledge({ projectRoot: root, pageSize: 50 });
      if (result.outcome !== "knowledge") throw new Error("Expected Knowledge.");
      expect(result.items).toHaveLength(12);
      for (const item of result.items) {
        expect(item.stalenessUnchecked, `seed ${seed} ${item.title}`).toBeUndefined();
        const expected = referenceStaleness(item, sessions, contexts);
        expect(item.possiblyStale, `seed ${seed} ${item.title} ${JSON.stringify(item.appliesTo)}`).toEqual(expected);
        // A single read resolves one or two patterns by testing every distinct path instead (no segment index).
        const single = store.getKnowledgeHistory({ projectRoot: root, knowledgeId: item.id });
        if (single.outcome !== "knowledge_history") throw new Error("Expected the history.");
        expect(single.knowledge.possiblyStale, `seed ${seed} single ${item.title}`).toEqual(expected);
      }
    }
  });

  it("is built per call and per project: another project's Sessions never count", () => {
    const first = trackedStore();
    const other = first.store.addProject("Synthetic Other", mkdtempSync(join(tmpdir(), "wi-later-other-")));
    first.store.updateProject(other.id, { status: "tracked" });
    const id = first.store.recordKnowledge({
      projectRoot: first.root,
      idempotencyKey: "k",
      kind: "gotcha",
      title: "Synthetic rule",
      body: "Synthetic.",
      appliesTo: ["src/shared.ts"],
    });
    if (id.outcome !== "knowledge_recorded") throw new Error("Could not record Knowledge.");
    first.db.prepare("UPDATE knowledge SET created_at = '2026-01-01T00:00:00.000Z'").run();
    insertSessions(first.store, first.db, first.root, [
      {
        id: "s1",
        title: "Synthetic",
        completedAt: "2026-02-01T00:00:00.000Z",
        files: ["src/shared.ts"],
        voided: false,
      },
    ]);
    first.db.prepare("UPDATE sessions SET project_id = ? WHERE id = 's1'").run(other.id);
    const result = first.store.searchKnowledge({ projectRoot: first.root });
    expect(result).toMatchObject({ items: [{ appliesTo: ["src/shared.ts"] }] });
    expect(result.outcome === "knowledge" && result.items[0]!.possiblyStale).toBeFalsy();
  });
});

describe("staleness ceilings", () => {
  it("leaves legitimate distinct-path history three times below both ceilings", () => {
    const { store, root, db } = trackedStore();
    // 200 Sessions of 50 distinct paths of about 100 characters, the shape of the 1.6.27 gate review.
    insertSessions(
      store,
      db,
      root,
      Array.from({ length: 200 }, (_, index) => ({
        id: `s${index}`,
        title: `Synthetic ${index}`,
        completedAt: new Date(Date.parse("2026-02-01T00:00:00.000Z") + index * 1_000).toISOString(),
        files: Array.from({ length: 50 }, (_, file) => `src/d${index}/${"f".repeat(85)}${file}.ts`),
        voided: false,
      })),
    );
    for (let item = 0; item < 50; item += 1) {
      store.recordKnowledge({
        projectRoot: root,
        idempotencyKey: `k${item}`,
        kind: "gotcha",
        title: `Synthetic rule ${item}`,
        body: "Synthetic.",
        appliesTo: [`src/m${item}/*.ts`, `src/d${item * 3}/*.ts`, `src/zz${item}.ts`, `src/d${item}`, `lib/q${item}`],
      });
    }
    db.prepare("UPDATE knowledge SET created_at = '2026-01-01T00:00:00.000Z'").run();
    const budgets: AppliesToBudget[] = [];
    setAppliesToBudgetProbe(budgets);
    const result = store.searchKnowledge({ projectRoot: root, pageSize: 50 });
    if (result.outcome !== "knowledge") throw new Error("Expected Knowledge.");
    expect(result.items.filter((item) => item.stalenessUnchecked)).toHaveLength(0);
    expect(result.items.filter((item) => item.possiblyStale)).toHaveLength(50);
    const [history, match] = budgets;
    // History is linear in the Sessions read: 5,000 such Sessions (25 times these) still leave three times headroom.
    expect(history!.units * 25 * 3).toBeLessThanOrEqual(STALENESS_HISTORY_UNIT_LIMIT);
    // Resolving 250 entries costs what their candidates cost, not what the history holds: under 2% of the ceiling.
    expect(match!.units * 50).toBeLessThanOrEqual(STALENESS_MATCH_UNIT_LIMIT);
  });

  it("stops a 15-star entry tested against every long path at the match ceiling, and marks it unchecked", () => {
    const { store, root, db } = trackedStore();
    insertSessions(
      store,
      db,
      root,
      Array.from({ length: 10 }, (_, index) => ({
        id: `s${index}`,
        title: `Synthetic ${index}`,
        completedAt: new Date(Date.parse("2026-02-01T00:00:00.000Z") + index * 1_000).toISOString(),
        files: Array.from({ length: 200 }, (_, file) => `${index}-${file}-${"a".repeat(990)}`),
        voided: false,
      })),
    );
    for (let item = 0; item < 20; item += 1) {
      store.recordKnowledge({
        projectRoot: root,
        idempotencyKey: `k${item}`,
        kind: "gotcha",
        title: `Synthetic rule ${item}`,
        body: "Synthetic.",
        // No literal prefix or suffix segment: every distinct path is a candidate and costs the full simulation.
        appliesTo: ["*a".repeat(15)],
      });
    }
    db.prepare("UPDATE knowledge SET created_at = '2026-01-01T00:00:00.000Z'").run();
    const budgets: AppliesToBudget[] = [];
    setAppliesToBudgetProbe(budgets);
    const result = store.searchKnowledge({ projectRoot: root, pageSize: 20 });
    if (result.outcome !== "knowledge") throw new Error("Expected Knowledge.");
    const [history, match] = budgets;
    expect(history!.exhausted).toBe(false);
    expect(match!.exhausted).toBe(true);
    expect(match!.units).toBeLessThanOrEqual(STALENESS_MATCH_UNIT_LIMIT);
    const unchecked = result.items.filter((item) => item.stalenessUnchecked);
    expect(unchecked.length).toBeGreaterThan(0);
    // An unchecked item is never reported current or stale, and every item after the cut is unchecked too.
    expect(unchecked.every((item) => !item.possiblyStale)).toBe(true);
    expect(result.items.slice(result.items.indexOf(unchecked[0]!))).toEqual(unchecked);
    // It runs to the real 50M-unit ceiling on purpose (about 0.2 s, 4.4 s under coverage), so it has its own timeout.
  }, 60_000);

  it("stops at the history ceiling when the later Sessions cannot all be read, and marks the group unchecked", () => {
    const { store, root, db } = trackedStore();
    insertSessions(
      store,
      db,
      root,
      Array.from({ length: 30 }, (_, index) => ({
        id: `s${index}`,
        title: `Synthetic ${index}`,
        completedAt: new Date(Date.parse("2026-02-01T00:00:00.000Z") + index * 1_000).toISOString(),
        files: Array.from({ length: 20 }, (_, file) => `src/${index}/${file}.ts`),
        voided: false,
      })),
    );
    store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: "k",
      kind: "gotcha",
      title: "Synthetic rule",
      body: "Synthetic.",
      appliesTo: ["src/0/0.ts"],
    });
    db.prepare("UPDATE knowledge SET created_at = '2026-01-01T00:00:00.000Z'").run();
    const budgets: AppliesToBudget[] = [];
    setAppliesToBudgetProbe(budgets);
    expect(store.searchKnowledge({ projectRoot: root })).toMatchObject({
      items: [{ possiblyStale: { sessionId: "s0", sessionCount: 1 } }],
    });
    // A ceiling below what reading these 30 Sessions costs (an injected limit, so the test stays small).
    setStalenessUnitLimits({ history: Math.floor(budgets[0]!.units / 2) });
    budgets.length = 0;
    const cut = store.searchKnowledge({ projectRoot: root });
    expect(cut).toMatchObject({ items: [{ stalenessUnchecked: true }] });
    expect(cut.outcome === "knowledge" && cut.items[0]!.possiblyStale).toBeFalsy();
    expect(budgets[0]!.exhausted).toBe(true);
    expect(budgets[0]!.units).toBeLessThanOrEqual(budgets[0]!.limit);
  });
});
