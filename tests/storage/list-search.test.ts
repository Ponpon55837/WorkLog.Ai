import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { FinalizeSessionInput } from "../../packages/core/src/index.js";
import { splitSearchTerms } from "../../packages/storage/src/sql-like.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only.
const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-list-search-"));
  tempDirs.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject("Apiary", root);
  store.updateProject(project.id, { status: "tracked" });
  const finalize = (key: string, overrides: Partial<FinalizeSessionInput>) => {
    const result = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: key,
      title: `Session ${key}`,
      summary: "Tended the hives.",
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles: [],
      verification: { status: "passed" },
      ...overrides,
    });
    if (result.outcome !== "finalized") {
      throw new Error("Expected finalize");
    }
    return result.session.id;
  };
  return { store, root, finalize };
}

const titles = (store: WorkIntelligenceStore, query: string) =>
  store
    .listSessionsPage({ query })
    .items.map((session) => session.title)
    .sort();

describe("list search terms", () => {
  it("splits on spaces, keeps quoted phrases, lowercases, dedupes and caps the count", () => {
    expect(splitSearchTerms('  Queen "Honey Flow"  queen 蜂巢 ')).toEqual(["queen", "honey flow", "蜂巢"]);
    expect(splitSearchTerms("a b c d e f g h i j")).toHaveLength(8);
    expect(splitSearchTerms('   ""  ')).toEqual([]);
  });
});

describe("Session list search", () => {
  it("requires every word, found in any text field including workSummary and changed files", () => {
    const { store, finalize } = setup();
    finalize("both", {
      title: "Queen rearing",
      workSummary: {
        outcomes: [],
        scope: [],
        decisions: ["Split the colony in spring."],
        verification: [],
        nextSteps: [],
      },
      changedFiles: ["hives/queen-cells.md"],
    });
    finalize("one", { title: "Queen inspection" });

    expect(titles(store, "queen spring")).toEqual(["Queen rearing"]);
    expect(titles(store, "queen-cells")).toEqual(["Queen rearing"]);
    expect(titles(store, "queen")).toEqual(["Queen inspection", "Queen rearing"]);
    expect(titles(store, '"queen rearing"')).toEqual(["Queen rearing"]);
    expect(titles(store, "queen winter")).toEqual([]);
  });

  it("does not match workSummary section names or LIKE wildcards", () => {
    const { store, finalize } = setup();
    finalize("plain", { title: "Hive log" });
    expect(titles(store, "decisions")).toEqual([]);
    expect(titles(store, "outcomes")).toEqual([]);
    expect(titles(store, "%")).toEqual([]);
  });
});

describe("Knowledge list search", () => {
  it("requires every word across title, body, tags and references", () => {
    const { store, root } = setup();
    const record = (key: string, title: string, tags: string[]) =>
      store.recordKnowledge({
        projectRoot: root,
        idempotencyKey: key,
        kind: "pattern",
        title,
        body: "Smoke calms bees.",
        tags,
      });
    record("k1", "Smoker technique", ["inspection"]);
    record("k2", "Smoker fuel", ["supplies"]);
    const found = store.searchKnowledge({ query: "smoker inspection" });
    expect(found.outcome === "knowledge" ? found.items.map((item) => item.title) : found).toEqual(["Smoker technique"]);
  });
});
