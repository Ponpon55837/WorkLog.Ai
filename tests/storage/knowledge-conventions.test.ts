import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KNOWLEDGE_CONVENTION_LIMIT, type KnowledgeRecord } from "../../packages/core/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];
const longTitle = "Fictional crate stacking rule that keeps going well beyond the sixty character title bound";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-conventions-"));
  tempDirs.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject("Warehouse", root);
  store.updateProject(project.id, { status: "tracked" });
  const db = (store as unknown as { db: DatabaseSync }).db;
  const record = (key: string, extra: { title?: string; supersedesId?: string } = {}): KnowledgeRecord => {
    const result = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: key,
      kind: "pattern",
      title: extra.title ?? `Crate rule ${key}`,
      body: `Stack crates ${key} by weight.`,
      ...(extra.supersedesId ? { supersedesId: extra.supersedesId } : {}),
    });
    if (result.outcome !== "knowledge_recorded") throw new Error("Expected Knowledge.");
    return result.knowledge;
  };
  const mark = (item: KnowledgeRecord, confirmed = true) =>
    store.setKnowledgeConvention({ projectRoot: root, knowledgeId: item.id, confirmed });
  const read = (id: string): KnowledgeRecord => {
    const result = store.getKnowledgeHistory({ projectRoot: root, knowledgeId: id });
    if (result.outcome !== "knowledge_history") throw new Error("Expected history.");
    return result.knowledge;
  };
  return { store, root, project, db, record, mark, read };
}

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("project conventions: marking", () => {
  it("marks and unmarks without moving updatedAt, and audits an updated entry with a convention field", () => {
    const { store, root, record, mark, read } = setup();
    const item = record("a");

    const marked = mark(item);
    expect(marked).toMatchObject({ outcome: "knowledge_updated", conventionCount: 1 });
    expect(read(item.id)).toMatchObject({ updatedAt: item.updatedAt, conventionConfirmedAt: expect.any(String) });

    const unmarked = mark(item, false);
    expect(unmarked).toMatchObject({ outcome: "knowledge_updated", conventionCount: 0 });
    const after = read(item.id);
    expect(after.conventionConfirmedAt).toBeUndefined();
    expect(after.conventionWithdrawal).toMatchObject({ by: "user", reason: "unmarked" });
    expect(after.updatedAt).toBe(item.updatedAt);

    const history = store.getKnowledgeHistory({ projectRoot: root, knowledgeId: item.id });
    if (history.outcome !== "knowledge_history") throw new Error("Expected history.");
    const entries = history.history.filter((entry) => entry.changedFields.includes("convention"));
    expect(entries.map((entry) => entry.action)).toEqual(["updated", "updated"]);
  });

  it("is idempotent when the state already matches", () => {
    const { record, mark, read } = setup();
    const item = record("a");
    mark(item);
    const first = read(item.id).conventionConfirmedAt;
    expect(mark(item)).toMatchObject({ outcome: "knowledge_updated", conventionCount: 1 });
    expect(read(item.id).conventionConfirmedAt).toBe(first);
    expect(mark(record("b"), false)).toMatchObject({ outcome: "knowledge_updated", conventionCount: 1 });
  });

  it("refuses a sixth convention in one project and counts projects separately", () => {
    const { store, record, mark } = setup();
    const items = Array.from({ length: KNOWLEDGE_CONVENTION_LIMIT + 1 }, (_, index) => record(`k${index}`));
    for (const item of items.slice(0, KNOWLEDGE_CONVENTION_LIMIT)) {
      expect(mark(item)).toMatchObject({ outcome: "knowledge_updated" });
    }
    expect(mark(items.at(-1)!)).toMatchObject({ outcome: "rejected", reason: "convention_limit_reached" });

    const otherRoot = mkdtempSync(join(tmpdir(), "work-intelligence-conventions-other-"));
    tempDirs.push(otherRoot);
    const other = store.addProject("Dock", otherRoot);
    store.updateProject(other.id, { status: "tracked" });
    const otherItem = store.recordKnowledge({
      projectRoot: otherRoot,
      idempotencyKey: "dock-a",
      kind: "pattern",
      title: "Dock rule",
      body: "Dock rule body.",
    });
    if (otherItem.outcome !== "knowledge_recorded") throw new Error("Expected Knowledge.");
    expect(
      store.setKnowledgeConvention({ projectRoot: otherRoot, knowledgeId: otherItem.knowledge.id, confirmed: true }),
    ).toMatchObject({ outcome: "knowledge_updated", conventionCount: 1 });
  });

  it("frees a slot when one is unmarked", () => {
    const { record, mark } = setup();
    const items = Array.from({ length: KNOWLEDGE_CONVENTION_LIMIT + 1 }, (_, index) => record(`k${index}`));
    for (const item of items.slice(0, KNOWLEDGE_CONVENTION_LIMIT)) mark(item);
    mark(items[0]!, false);
    expect(mark(items.at(-1)!)).toMatchObject({ outcome: "knowledge_updated", conventionCount: 5 });
  });

  it("counts only active, undoubted, non-empty flags against the limit", () => {
    const { db, record, mark } = setup();
    const ghosts = [record("archived-ghost"), record("doubted-ghost"), record("empty-ghost")];
    db.prepare(
      "UPDATE knowledge SET convention_confirmed_at = '2030-01-01T00:00:00.000Z', status = 'archived' WHERE id = ?",
    ).run(ghosts[0]!.id);
    db.prepare(
      "UPDATE knowledge SET convention_confirmed_at = '2030-01-01T00:00:00.000Z', review_json = ? WHERE id = ?",
    ).run(JSON.stringify({ reason: "contradicted", at: "2030-01-01T00:00:00.000Z" }), ghosts[1]!.id);
    db.prepare("UPDATE knowledge SET convention_confirmed_at = '' WHERE id = ?").run(ghosts[2]!.id);

    const items = Array.from({ length: KNOWLEDGE_CONVENTION_LIMIT }, (_, index) => record(`real-${index}`));
    for (const item of items) expect(mark(item)).toMatchObject({ outcome: "knowledge_updated" });
    expect(mark(record("over"))).toMatchObject({ outcome: "rejected", reason: "convention_limit_reached" });
    expect(mark(items[0]!)).toMatchObject({ conventionCount: KNOWLEDGE_CONVENTION_LIMIT });
  });

  it("accepts only active Knowledge that is not marked for review", () => {
    const { store, root, record, mark } = setup();
    const archived = record("archived");
    store.updateKnowledge({ projectRoot: root, knowledgeId: archived.id, status: "archived" }, "user");
    expect(mark(archived)).toMatchObject({ outcome: "rejected", reason: "not_active" });

    const doubted = record("doubted");
    store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "doubt",
      title: "Doubt Session",
      summary: "Found the rule wrong.",
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles: [],
      verification: { status: "passed" },
      contradictedKnowledgeIds: [doubted.id],
    });
    expect(mark(doubted)).toMatchObject({ outcome: "rejected", reason: "needs_review" });
    expect(mark({ ...doubted, id: "missing" })).toMatchObject({ outcome: "not_found" });
  });

  it("skips a project that is not tracked", () => {
    const { store, record, mark, project } = setup();
    const item = record("a");
    store.updateProject(project.id, { status: "paused" });
    expect(mark(item)).toMatchObject({ outcome: "skipped" });
  });
});

describe("project conventions: withdrawal", () => {
  it("withdraws on archive with the actor, and does not come back on restore", () => {
    const { store, root, record, mark, read } = setup();
    const item = record("a");
    mark(item);

    store.updateKnowledge({ projectRoot: root, knowledgeId: item.id, status: "archived" }, "user");
    expect(read(item.id)).toMatchObject({ conventionWithdrawal: { by: "user", reason: "archived" } });
    expect(read(item.id).conventionConfirmedAt).toBeUndefined();

    store.updateKnowledge({ projectRoot: root, knowledgeId: item.id, status: "active" }, "user");
    expect(read(item.id).conventionConfirmedAt).toBeUndefined();
  });

  it("withdraws on an Agent title or body edit, but not on a user edit or an Agent tag edit", () => {
    const { store, root, record, mark, read } = setup();
    const edited = record("edited");
    const userEdited = record("user-edited");
    const tagged = record("tagged");
    for (const item of [edited, userEdited, tagged]) mark(item);

    store.updateKnowledge({ projectRoot: root, knowledgeId: userEdited.id, title: "User retitled rule" }, "user");
    store.updateKnowledge({ projectRoot: root, knowledgeId: tagged.id, tags: ["harbor"] });
    expect(read(userEdited.id).conventionConfirmedAt).toBeDefined();
    expect(read(tagged.id).conventionConfirmedAt).toBeDefined();

    store.updateKnowledge({ projectRoot: root, knowledgeId: edited.id, body: "Agent rewrote this rule." });
    expect(read(edited.id).conventionConfirmedAt).toBeUndefined();
    expect(read(edited.id).conventionWithdrawal).toMatchObject({ by: "agent", reason: "agent_edit" });
    const history = store.getKnowledgeHistory({ projectRoot: root, knowledgeId: edited.id });
    if (history.outcome !== "knowledge_history") throw new Error("Expected history.");
    expect(history.history.some((entry) => entry.changedFields.includes("convention"))).toBe(true);
  });

  it("keeps a convention on a tags-only edit and on confirm, even when stored text would be redacted today", () => {
    const { store, root, record, mark, read, db } = setup();
    const item = record("secret");
    db.prepare("UPDATE knowledge SET body = ? WHERE id = ?").run(
      "Call with password=hunter2hunter2 and token sk-abcdefghijklmnopqrstuvwx1234.",
      item.id,
    );
    mark(item);

    store.updateKnowledge({ projectRoot: root, knowledgeId: item.id, tags: ["harbor"] });
    expect(read(item.id).conventionConfirmedAt).toBeDefined();
    store.updateKnowledge({ projectRoot: root, knowledgeId: item.id, confirm: true });
    expect(read(item.id).conventionConfirmedAt).toBeDefined();
    store.updateKnowledge({ projectRoot: root, knowledgeId: item.id, body: "A new body." });
    expect(read(item.id).conventionConfirmedAt).toBeUndefined();
  });

  it("warns the Agent when its edit or archive withdrew a convention, and not when the user did", () => {
    const { store, root, record, mark } = setup();
    const edited = record("edited");
    const archivedByUser = record("archived-by-user");
    const plain = record("plain");
    mark(edited);
    mark(archivedByUser);

    const warned = store.updateKnowledge({ projectRoot: root, knowledgeId: edited.id, title: "Agent retitle" });
    expect(warned).toMatchObject({ outcome: "knowledge_updated", warnings: [expect.stringContaining("convention")] });
    const user = store.updateKnowledge(
      { projectRoot: root, knowledgeId: archivedByUser.id, status: "archived" },
      "user",
    );
    expect(user).not.toHaveProperty("warnings");
    expect(
      store.updateKnowledge({ projectRoot: root, knowledgeId: plain.id, title: "Plain retitle" }),
    ).not.toHaveProperty("warnings");
  });

  it("withdraws when a newer Knowledge supersedes it", () => {
    const { record, mark, read } = setup();
    const item = record("old");
    mark(item);

    const successor = record("new", { supersedesId: item.id });
    expect(read(item.id)).toMatchObject({ status: "archived", conventionWithdrawal: { reason: "superseded" } });
    expect(read(item.id).conventionConfirmedAt).toBeUndefined();
    expect(read(successor.id).conventionConfirmedAt).toBeUndefined();
  });

  it("withdraws when a Session reports it contradicted", () => {
    const { store, root, record, mark, read } = setup();
    const item = record("doubted");
    mark(item);

    store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "doubt",
      title: "Doubt Session",
      summary: "Found the rule wrong.",
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles: [],
      verification: { status: "passed" },
      contradictedKnowledgeIds: [item.id],
    });
    expect(read(item.id)).toMatchObject({
      review: { reason: "contradicted" },
      conventionWithdrawal: { by: "system", reason: "needs_review" },
    });
    expect(read(item.id).conventionConfirmedAt).toBeUndefined();

    store.updateKnowledge({ projectRoot: root, knowledgeId: item.id, confirm: true });
    expect(read(item.id).conventionConfirmedAt).toBeUndefined();
  });
});

describe("project conventions: context pointers", () => {
  function contextOf(store: WorkIntelligenceStore, root: string, focus?: { task?: string; paths?: string[] }) {
    const context = store.getContext(root, focus);
    if (context.outcome !== "context") throw new Error("Expected context.");
    return context;
  }

  it("omits the key when the project has no conventions", () => {
    const { store, root, record } = setup();
    record("a");
    expect("conventions" in contextOf(store, root)).toBe(false);
  });

  it("lists id and title pointers, oldest confirmation first, and not for a cross-project call", () => {
    const { store, root, record, mark } = setup();
    vi.useFakeTimers({ toFake: ["Date"] });
    const first = record("first");
    const second = record("second", { title: longTitle });
    vi.setSystemTime(Date.now() + 60_000);
    mark(second);
    vi.setSystemTime(Date.now() + 60_000);
    mark(first);

    const { conventions } = contextOf(store, root);
    expect(conventions).toEqual({
      readWith: "work_get_knowledge_history",
      items: [
        { id: second.id, title: expect.stringMatching(/^Fictional crate stacking rule.{0,40}…$/u) },
        { id: first.id, title: first.title },
      ],
    });
    expect(conventions!.items[0]!.title.length).toBeLessThanOrEqual(60);
    const global = store.getContext();
    expect(global.outcome === "context" && "conventions" in global).toBe(false);
  });

  it("keeps conventions out of recentKnowledge and its omission list", () => {
    const { store, root, record, mark } = setup();
    const items = Array.from({ length: 14 }, (_, index) => record(`k${index}`));
    const marked = items.slice(-2);
    for (const item of marked) mark(item);

    const context = contextOf(store, root);
    const shown = new Set(context.recentKnowledge.map((item) => item.id));
    for (const item of marked) expect(shown.has(item.id)).toBe(false);
    expect(context.recentKnowledge).toHaveLength(10);
    expect(JSON.stringify(context.omitted ?? [])).not.toContain(marked[0]!.id);
  });

  it("drops a convention that was imported onto an archived or doubted row", () => {
    const { store, root, db, record, mark } = setup();
    const item = record("a");
    mark(item);
    db.prepare("UPDATE knowledge SET status = 'archived' WHERE id = ?").run(item.id);
    expect("conventions" in contextOf(store, root)).toBe(false);
    db.prepare("UPDATE knowledge SET status = 'active', review_json = ? WHERE id = ?").run(
      JSON.stringify({ reason: "contradicted", at: "2030-01-01T00:00:00.000Z" }),
      item.id,
    );
    expect("conventions" in contextOf(store, root)).toBe(false);
  });

  it("stays within the budget with five longest conventions, with and without a task", () => {
    const { store, root, record, mark } = setup();
    for (let index = 0; index < 14; index += 1) {
      store.recordKnowledge({
        projectRoot: root,
        idempotencyKey: `filler-${index}`,
        kind: "pattern",
        title: `Dock filler ${index}`,
        body: "A fictional dock procedure that is repeated to fill the context. ".repeat(20),
      });
    }
    for (let index = 0; index < KNOWLEDGE_CONVENTION_LIMIT; index += 1) {
      mark(record(`long-${index}`, { title: `${longTitle} ${"x".repeat(40)}${index}` }));
    }

    for (const focus of [undefined, { task: "dock procedure" }]) {
      const context = contextOf(store, root, focus);
      const block = JSON.stringify(context.conventions);
      expect(context.conventions!.items).toHaveLength(KNOWLEDGE_CONVENTION_LIMIT);
      expect(block.length).toBeLessThanOrEqual(700);
      expect(JSON.stringify(context).length).toBeLessThanOrEqual(focus ? 9_800 : 15_800);
      expect(context.conventions!.items.map((item) => item.id)).toHaveLength(KNOWLEDGE_CONVENTION_LIMIT);
    }
  });

  it("skips a convention with an oversized id and never cuts a surrogate pair in a title", () => {
    const { store, root, db, record, mark } = setup();
    const huge = record("huge");
    mark(huge);
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("UPDATE knowledge SET id = ? WHERE id = ?").run("k".repeat(900), huge.id);
    db.exec("PRAGMA foreign_keys = ON");
    expect("conventions" in contextOf(store, root)).toBe(false);

    for (let index = 0; index < KNOWLEDGE_CONVENTION_LIMIT; index += 1) {
      mark(record(`emoji-${index}`, { title: `${"😀".repeat(70)}${index}` }));
    }
    const { conventions } = contextOf(store, root);
    expect(JSON.stringify(conventions).length).toBeLessThanOrEqual(700);
    for (const item of conventions!.items)
      expect(item.title).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u);
    expect(Array.from(conventions!.items[0]!.title).length).toBeLessThanOrEqual(60);
  });

  it("does not list a convention again among omitted path Knowledge", () => {
    const { store, root, record, mark } = setup();
    const ids = Array.from({ length: 16 }, (_, index) => {
      const result = store.recordKnowledge({
        projectRoot: root,
        idempotencyKey: `path-rule-${index}`,
        kind: "pattern",
        title: `Crate path rule ${index}`,
        body: `Crates live under src/crates ${index}.`,
        appliesTo: ["src/crates/**"],
      });
      if (result.outcome !== "knowledge_recorded") throw new Error("Expected Knowledge.");
      return result.knowledge;
    });
    record("other");
    const focus = { paths: ["src/crates/a.ts"] };
    const omittedBefore = JSON.stringify(contextOf(store, root, focus).omitted ?? []);
    const target = ids.find((item) => omittedBefore.includes(item.id));
    expect(target).toBeDefined();

    mark(target!);
    const context = contextOf(store, root, focus);
    expect(JSON.stringify(context.omitted ?? [])).not.toContain(target!.id);
    expect(context.conventions!.items.map((entry) => entry.id)).toEqual([target!.id]);
  });

  it("fits five conventions whose titles are exactly 60 characters without shortening any", () => {
    const { store, root, record, mark } = setup();
    for (let index = 0; index < KNOWLEDGE_CONVENTION_LIMIT; index += 1) {
      mark(record(`edge-${index}`, { title: `${"規".repeat(59)}${index}` }));
    }
    const { conventions } = contextOf(store, root);
    expect(conventions!.items.every((item) => Array.from(item.title).length === 60 && !item.title.endsWith("…"))).toBe(
      true,
    );
    expect(JSON.stringify(conventions).length).toBeLessThanOrEqual(700);
  });

  it("terminates and stays within 700 characters with pathological imported ids and short titles", () => {
    const { store, root, db, record, mark } = setup();
    const items = Array.from({ length: KNOWLEDGE_CONVENTION_LIMIT }, (_, index) =>
      record(`path-${index}`, { title: `${"規".repeat(80)}${index}` }),
    );
    for (const item of items) mark(item);
    db.exec("PRAGMA foreign_keys = OFF");
    items.forEach((item, index) => {
      const id = index === 0 ? '"'.repeat(64) : `${"k".repeat(63)}${index}`;
      db.prepare("UPDATE knowledge SET id = ? WHERE id = ?").run(id, item.id);
    });
    db.exec("PRAGMA foreign_keys = ON");
    const { conventions } = contextOf(store, root);
    expect(conventions!.items.map((item) => item.id)).not.toContain('"'.repeat(64));
    expect(conventions!.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(conventions).length).toBeLessThanOrEqual(700);
  });

  it("keeps a convention out of relevant.supplements while the Session that applied it still lists it", () => {
    const { store, root, record, mark } = setup();
    const rule = record("hive", { title: "Zebra stripe rule" });
    const finalize = () =>
      store.finalizeSession({
        projectRoot: root,
        idempotencyKey: "applied",
        title: "Pallet jack inspection",
        summary: "Inspected the pallet jack fleet.",
        workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
        changedFiles: [],
        verification: { status: "passed" },
        appliedKnowledgeIds: [rule.id],
      });
    expect(finalize().outcome).toBe("finalized");
    const supplementIds = () =>
      (contextOf(store, root, { task: "pallet jack inspection" }).relevant?.supplements ?? []).map((item) => item.id);
    expect(supplementIds()).toContain(rule.id);

    mark(rule);
    const context = contextOf(store, root, { task: "pallet jack inspection" });
    expect(context.conventions!.items.map((item) => item.id)).toEqual([rule.id]);
    expect(supplementIds()).not.toContain(rule.id);
  });

  it("keeps the block within 700 characters for titles that JSON escapes", () => {
    const { store, root, record, mark } = setup();
    for (let index = 0; index < KNOWLEDGE_CONVENTION_LIMIT; index += 1) {
      mark(record(`quote-${index}`, { title: `"${'\\"'.repeat(40)}" rule ${index}` }));
    }
    const { conventions } = contextOf(store, root);
    expect(JSON.stringify(conventions).length).toBeLessThanOrEqual(700);
  });
});
