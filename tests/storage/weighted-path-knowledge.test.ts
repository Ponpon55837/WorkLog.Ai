import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setAppliesToBudgetProbe, type AppliesToBudget } from "../../packages/storage/src/applies-to-match.js";
import type { WeightedPathKnowledge } from "../../packages/storage/src/search-repository.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only.
interface SearchInternals {
  syncIndex: () => void;
  knowledgeForWeightedPaths: (
    weights: ReadonlyMap<string, number>,
    projectId: string,
    count: number,
    matched?: Set<string>,
  ) => WeightedPathKnowledge[];
}

const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

function setup() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-weighted-paths-"));
  tempDirs.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject("Fictional Weaving Works", root);
  store.updateProject(project.id, { status: "tracked" });
  let counter = 0;
  const record = (title: string, appliesTo: string[], references: string[] = [], projectRoot = root) => {
    const result = store.recordKnowledge({
      projectRoot,
      idempotencyKey: `weighted-${counter++}`,
      kind: "pattern",
      title,
      body: "Follow the posted loom tension.",
      appliesTo,
      references,
    });
    if (result.outcome !== "knowledge_recorded") throw new Error("Expected Knowledge.");
    return result.knowledge;
  };
  const search = (store as unknown as { contextRecallService: { searchIndex: SearchInternals } }).contextRecallService
    .searchIndex;
  const rank = (weights: Array<[string, number]>, count = 5, projectId = project.id, matched?: Set<string>) => {
    search.syncIndex();
    return search.knowledgeForWeightedPaths(new Map(weights), projectId, count, matched);
  };
  return { store, root, project, record, rank };
}

afterEach(() => {
  setAppliesToBudgetProbe(undefined);
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SearchRepository.knowledgeForWeightedPaths", () => {
  it("ranks by the summed weight of the files a Knowledge covers and names its best matched pattern", () => {
    const { record, rank } = setup();
    const heavy = record("Warp thread gauge", ["src/warp/**"]);
    const wide = record("Shared loom rule", ["src/warp/**", "src/weft/**"]);
    const light = record("Weft shuttle speed", ["src/weft/**"]);

    const result = rank([
      ["src/warp/a.ts", 3],
      ["src/warp/b.ts", 2],
      ["src/weft/c.ts", 1],
    ]);

    // heavy: 3 + 2 = 5; wide: 3 + 2 + 1 = 6 (each file counted once with its best entry); light: 1.
    expect(result.map((item) => item.id)).toEqual([wide.id, heavy.id, light.id]);
    // matchedPath is the heaviest file the Knowledge covers, not the stored pattern.
    expect(result[1]).toMatchObject({ title: "Warp thread gauge", matchedPath: "src/warp/a.ts" });
    expect(result[0]?.matchedPath).toBe("src/warp/a.ts");
    expect(result[2]?.matchedPath).toBe("src/weft/c.ts");
  });

  it("matches references through the basename index and counts each file once", () => {
    const { record, rank } = setup();
    const reference = record("Heddle note", [], ["src/heddle/frame.ts"]);
    record("Unrelated note", [], ["src/other/loom.ts"]);

    const result = rank([["src/heddle/frame.ts", 1]]);

    expect(result).toEqual([
      {
        id: reference.id,
        title: "Heddle note",
        matchedPath: "src/heddle/frame.ts",
        score: 1,
        files: ["src/heddle/frame.ts"],
      },
    ]);
  });

  it("reports the score and every contributing file, breaks ties by id, and lists every scored id in `matched`", () => {
    const { record, rank } = setup();
    const first = record("Tie rule one", ["src/loom/**"]);
    const second = record("Tie rule two", ["src/loom/**"]);
    const third = record("Tie rule three", ["src/loom/**"]);
    const matched = new Set<string>();

    const result = rank(
      [
        ["src/loom/a.ts", 2],
        ["src/loom/b.ts", 1],
        ["src/none/c.ts", 5],
      ],
      2,
      undefined,
      matched,
    );

    expect(result.map((item) => item.id)).toEqual([first.id, second.id, third.id].sort().slice(0, 2));
    expect(result[0]?.score).toBeCloseTo(2.4);
    expect([...(result[0]?.files ?? [])].sort()).toEqual(["src/loom/a.ts", "src/loom/b.ts"]);
    expect([...matched].sort()).toEqual([first.id, second.id, third.id].sort());
  });

  it("limits the answer to the requested count and returns nothing for no usable weights", () => {
    const { record, rank } = setup();
    for (let index = 0; index < 4; index += 1) record(`Rule ${index}`, ["src/loom/**"]);

    expect(rank([["src/loom/a.ts", 1]], 2)).toHaveLength(2);
    expect(rank([["src/loom/a.ts", 1]], 0)).toEqual([]);
    expect(rank([])).toEqual([]);
    expect(rank([["src/loom/a.ts", 0]])).toEqual([]);
  });

  it("scopes to the project and to active Knowledge", () => {
    const { store, record, rank, project, root } = setup();
    const active = record("Active rule", ["src/loom/**"]);
    const archived = record("Archived rule", ["src/loom/**"]);
    store.updateKnowledge({ projectRoot: root, knowledgeId: archived.id, status: "archived" });
    const otherRoot = mkdtempSync(join(tmpdir(), "work-intelligence-weighted-other-"));
    tempDirs.push(otherRoot);
    const other = store.addProject("Fictional Other Works", otherRoot);
    store.updateProject(other.id, { status: "tracked" });
    const foreign = record("Other project rule", ["src/loom/**"], [], otherRoot);

    const result = rank([["src/loom/a.ts", 1]], 5, project.id);

    expect(result.map((item) => item.id)).toEqual([active.id]);
    expect(rank([["src/loom/a.ts", 1]], 5, other.id).map((item) => item.id)).toEqual([foreign.id]);
  });

  it("stops at the first row the match budget cuts short and ranks nothing from it", () => {
    const { record, rank } = setup();
    record("Budgeted rule", ["src/loom/**"]);
    record("Second budgeted rule", ["src/loom/**"]);
    const budgets: AppliesToBudget[] = [];
    setAppliesToBudgetProbe({
      push: (budget: AppliesToBudget) => {
        budget.limit = 1;
        budgets.push(budget);
        return budgets.length;
      },
    } as unknown as AppliesToBudget[]);

    expect(rank([["src/loom/a.ts", 1]])).toEqual([]);
    expect(budgets).toHaveLength(1);
    expect(budgets[0]?.exhausted).toBe(true);
  });

  it("keeps the files bounded to the 100 heaviest", () => {
    const { record, rank } = setup();
    const only = record("Light file rule", ["src/light/**"]);
    const weights: Array<[string, number]> = Array.from({ length: 100 }, (_, index) => [`src/heavy/f${index}.ts`, 5]);
    weights.push(["src/light/a.ts", 1]);

    expect(rank(weights)).toEqual([]);
    expect(rank([["src/light/a.ts", 1]]).map((item) => item.id)).toEqual([only.id]);
  });
});
