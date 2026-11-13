import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only.
const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

function setup() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-context-applies-to-"));
  tempDirs.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject("Fictional Apiary", root);
  store.updateProject(project.id, { status: "tracked" });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2031, 2, 1));
  const tick = () => vi.setSystemTime(Date.now() + 60_000);
  const record = (key: string, title: string, appliesTo: string[]) => {
    tick();
    const result = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: key,
      kind: "pattern",
      title,
      body: `${title} body about nothing the task will mention.`,
      appliesTo,
    });
    if (result.outcome !== "knowledge_recorded") throw new Error("Expected Knowledge.");
    return result.knowledge;
  };
  const finalize = (key: string, changedFiles: string[]) => {
    tick();
    const result = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: key,
      title: `Apiary session ${key}`,
      summary: `Apiary session ${key} touched hive files.`,
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles,
      verification: { status: "passed" },
    });
    if (result.outcome !== "finalized") throw new Error("Expected a finalized Session.");
    return result.session;
  };
  return { store, root, record, finalize };
}

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("work_get_context with Knowledge linked only through appliesTo", () => {
  it("offers possiblyStale Knowledge covering a focus path as a relevant record, not a pointer", () => {
    const { store, root, record, finalize } = setup();
    const stale = record("stale", "Queen cell spacing rule", ["src/hive/**"]);
    finalize("touch", ["src/hive/queen.ts"]);
    for (let index = 0; index < 14; index += 1) record(`recent-${index}`, `Unrelated bookkeeping note ${index}`, []);

    const context = store.getContext(root, { task: "adjust drone comb layout", paths: ["src/hive/drone.ts"] });
    if (context.outcome !== "context") throw new Error("Expected context.");

    const relevant = context.relevant?.knowledge.find((item) => item.id === stale.id);
    expect(relevant).toMatchObject({ type: "knowledge", title: "Queen cell spacing rule", possiblyStale: true });
    expect(relevant?.excerpt).toContain("Queen cell spacing rule");
    // Offered once: not repeated in recentKnowledge or as an omission pointer.
    expect(context.recentKnowledge.some((item) => item.id === stale.id)).toBe(false);
    const omittedIds = (context.omitted ?? []).flatMap((omission) => [
      ...(omission.ids ?? []),
      ...(omission.entries ?? []).map((entry) => entry.id),
    ]);
    expect(omittedIds).not.toContain(stale.id);
  });

  it("matches an exact path, a directory, and a glob, and not a sibling directory", () => {
    const { store, root, record } = setup();
    const exact = record("exact", "Exact file rule", ["src/comb/frame.ts"]);
    const directory = record("directory", "Directory rule", ["src/wax/"]);
    const glob = record("glob", "Glob rule", ["src/honey/**/*.press.ts"]);
    const sibling = record("sibling", "Sibling rule", ["src/waxy/"]);

    const knowledgeFor = (path: string) => {
      const context = store.getContext(root, { paths: [path] });
      if (context.outcome !== "context") throw new Error("Expected context.");
      return (context.relevant?.knowledge ?? []).map((item) => item.id);
    };
    expect(knowledgeFor("src/comb/frame.ts")).toContain(exact.id);
    expect(knowledgeFor("src/wax/cap/seal.ts")).toContain(directory.id);
    expect(knowledgeFor("src/wax/cap/seal.ts")).not.toContain(sibling.id);
    expect(knowledgeFor("src/honey/east/jar.press.ts")).toContain(glob.id);
    expect(knowledgeFor("src/honey/east/jar.pour.ts")).not.toContain(glob.id);
  });

  it("does not match appliesTo for a task without paths", () => {
    const { store, root, record } = setup();
    record("only", "Smoker fuel rule", ["src/smoker/**"]);
    const context = store.getContext(root, { task: "bellows repair wording" });
    if (context.outcome !== "context") throw new Error("Expected context.");
    expect(context.relevant?.knowledge.map((item) => item.title) ?? []).not.toContain("Smoker fuel rule");
  });
});
