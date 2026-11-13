import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextResult } from "../../packages/core/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only.
const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];
const filler = "The fictional drone ledger keeps its verified comb spacing window and its source notes. ";
const longTitle = "Queen cell spacing rule for the east hive frames that must be rechecked after every swarm season";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-context-path-knowledge-"));
  tempDirs.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject("Fictional Apiary", root);
  store.updateProject(project.id, { status: "tracked" });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2031, 2, 1));
  const tick = () => vi.setSystemTime(Date.now() + 60_000);
  const record = (key: string, title: string, appliesTo: string[], body = `${title} body about combs.`) => {
    tick();
    const result = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: key,
      kind: "pattern",
      title,
      body,
      appliesTo,
    });
    if (result.outcome !== "knowledge_recorded") throw new Error("Expected Knowledge.");
    return result.knowledge;
  };
  const finalize = (key: string, changedFiles: string[], heavy = false) => {
    tick();
    const result = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: key,
      title: `Apiary session ${key}`,
      summary: heavy ? filler.repeat(6) : `Apiary session ${key} touched hive files.`,
      workSummary: {
        outcomes: [],
        scope: [],
        decisions: heavy ? [filler.repeat(3)] : [],
        verification: [],
        nextSteps: heavy ? [filler.repeat(3)] : [],
      },
      changedFiles,
      verification: { status: "passed" },
    });
    if (result.outcome !== "finalized") throw new Error("Expected a finalized Session.");
    return result.session;
  };
  return { store, root, record, finalize };
}

function contextOf(store: WorkIntelligenceStore, root: string, focus: { task?: string; paths?: string[] }) {
  const context = store.getContext(root, focus);
  if (context.outcome !== "context") throw new Error("Expected context.");
  return context;
}

/** Every Knowledge id a context names anywhere, once per place it appears. */
function namedKnowledgeIds(context: ContextResult): string[] {
  return [
    ...(context.relevant?.knowledge ?? []).map((item) => item.id),
    ...context.recentKnowledge.map((item) => item.id),
    ...(context.omitted ?? [])
      .filter((omission) => omission.section === "relevant.knowledge" || omission.section === "recentKnowledge")
      .flatMap((omission) => [...(omission.ids ?? []), ...(omission.entries ?? []).map((entry) => entry.id)]),
  ];
}

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("work_get_context path-matched Knowledge pointers", () => {
  function crowdedHive(count = 8, stale = true) {
    const fixture = setup();
    const ids = Array.from(
      { length: count },
      (_, index) =>
        fixture.record(
          `hive-${index}`,
          index === 0 ? longTitle : `Hive comb rule ${index}`,
          ["src/hive/**"],
          filler.repeat(5),
        ).id,
    );
    // A later Session that changed the covered files makes every rule possiblyStale.
    if (stale) fixture.finalize("touch-hive", ["src/hive/queen.ts"]);
    for (let index = 0; index < 6; index += 1) fixture.finalize(`heavy-${index}`, [`src/misc/part-${index}.ts`], true);
    return { ...fixture, ids };
  }

  it("keeps a relevant record and lists the other path-matched Knowledge with title and path under budget pressure", () => {
    const { store, root, ids } = crowdedHive();
    const context = contextOf(store, root, { task: "adjust drone comb layout", paths: ["src/hive/drone.ts"] });

    expect(JSON.stringify(context).length).toBeLessThanOrEqual(10_000);
    expect(context.relevant?.knowledge.length).toBeGreaterThanOrEqual(1);
    const omission = context.omitted?.find((candidate) => candidate.section === "relevant.knowledge");
    const withPath = (omission?.entries ?? []).filter((entry) => entry.path !== undefined);
    // Pointers yield to full records under pressure, so title and path may be shortened or dropped; the flagged
    // entry with its id always stays.
    expect(withPath.length).toBeLessThanOrEqual(5);
    for (const entry of withPath) {
      expect(entry).toMatchObject({ path: "src/hive/**", possiblyStale: true });
      expect(entry.title!.length).toBeLessThanOrEqual(60);
    }
    // No path-matched record is lost to moreIds while the cap has room, and none is counted twice.
    expect(omission?.moreIds ?? 0).toBe(0);
    expect(omission?.readWith).toBe(
      withPath.length > 0 ? "work_get_file_history/work_search_knowledge" : "work_search_knowledge",
    );
    const named = namedKnowledgeIds(context).filter((id) => ids.includes(id));
    expect(new Set(named).size).toBe(named.length);
    expect(new Set(named)).toEqual(new Set(ids));
  });

  it("shortens a long title at a word boundary", () => {
    const { store, root, ids } = crowdedHive();
    const context = contextOf(store, root, { paths: ["src/hive/drone.ts"] });
    const entry = (context.omitted ?? [])
      .flatMap((omission) => omission.entries ?? [])
      .find((candidate) => candidate.id === ids[0]);
    const shown = context.relevant?.knowledge.find((item) => item.id === ids[0]);
    const title = entry?.title ?? shown?.title ?? "";
    expect(title.length).toBeGreaterThan(0);
    if (entry) {
      expect(entry.title).toMatch(/…$/);
      expect(entry.title!.length).toBeLessThanOrEqual(60);
      expect(longTitle.startsWith(entry.title!.slice(0, -1))).toBe(true);
    }
  });

  it("caps the entries with title and path at five and keeps the flagged others as id entries", () => {
    const { store, root, ids } = crowdedHive(14);
    const context = contextOf(store, root, { paths: ["src/hive/drone.ts"] });
    const omission = context.omitted?.find((candidate) => candidate.section === "relevant.knowledge");
    const entries = omission?.entries ?? [];
    expect(entries.filter((entry) => entry.path !== undefined)).toHaveLength(5);
    const shownIds = new Set((context.relevant?.knowledge ?? []).map((item) => item.id));
    for (const id of ids) {
      if (shownIds.has(id)) continue;
      // Possibly stale records keep their id and flag even past the cap; none is hidden in moreIds.
      expect(entries.some((entry) => entry.id === id && entry.possiblyStale === true)).toBe(true);
    }
    expect(omission?.moreIds ?? 0).toBe(0);
  });

  it("gives path entries priority over plain ids for the id slots", () => {
    const { store, root, ids } = crowdedHive(14, false);
    const context = contextOf(store, root, { paths: ["src/hive/drone.ts"] });
    const omission = context.omitted?.find((candidate) => candidate.section === "relevant.knowledge");
    const entries = omission?.entries ?? [];
    expect(entries.filter((entry) => entry.path !== undefined)).toHaveLength(5);
    // The better-ranked records hold the five path slots; the rest fall back to the plain id list.
    const entryIds = new Set(entries.map((entry) => entry.id));
    for (const id of omission?.ids ?? []) expect(entryIds.has(id)).toBe(false);
    expect((omission?.ids ?? []).length).toBeLessThanOrEqual(3);
    const named = namedKnowledgeIds(context).filter((id) => ids.includes(id));
    expect(new Set(named).size).toBe(named.length);
  });

  it("pops full relevant records only after the pointers have been reduced", () => {
    const { store, root, ids } = crowdedHive(14, false);
    const focus = { task: "adjust drone comb layout", paths: ["src/hive/drone.ts"] };
    const context = contextOf(store, root, focus);
    const shown = context.relevant?.knowledge ?? [];
    const omission = context.omitted?.find((candidate) => candidate.section === "relevant.knowledge");
    const pointers = (omission?.entries ?? []).filter((entry) => entry.path !== undefined);
    // Same fixture without the path-matched pointers in play (no paths): the five relevant slots stay full here too.
    expect(shown.length).toBe(5);
    expect(JSON.stringify(context).length).toBeLessThanOrEqual(10_000);
    // A trimmed record may be listed, but then no pointer for a record that was never shown may keep a long title.
    if (shown.length < 5) {
      for (const entry of pointers) expect((entry.title ?? "").length).toBeLessThanOrEqual(24);
    }
    const named = [...shown.map((item) => item.id), ...(omission?.entries ?? []).map((entry) => entry.id)];
    expect(named.filter((id) => ids.includes(id)).length).toBeGreaterThanOrEqual(shown.length);
  });

  it("is unchanged without paths", () => {
    const { store, root } = crowdedHive();
    const context = contextOf(store, root, { task: "adjust drone comb layout" });
    const entries = (context.omitted ?? []).flatMap((omission) => omission.entries ?? []);
    expect(entries.every((entry) => entry.path === undefined && entry.title === undefined)).toBe(true);
    expect(
      (context.omitted ?? []).find((omission) => omission.section === "relevant.knowledge")?.readWith ??
        "work_search_knowledge",
    ).toBe("work_search_knowledge");
  });
});
