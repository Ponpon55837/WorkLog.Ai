import { mkdtempSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appliesToStrength,
  createAppliesToBudget,
  setAppliesToBudgetProbe,
  type AppliesToBudget,
} from "../../packages/storage/src/applies-to-match.js";
import { normalizePath } from "../../packages/storage/src/search-text.js";
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

  it("equals the test-every-pair reference on seeded synthetic entries and files", () => {
    const { project, record, rank } = setup();
    const random = seededRandom(20_260_101);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const dirs = ["src", "lib", "App", "docs", "packages"];
    const mods = ["mod1", "mod2", "Mod3", "part-a"];
    const leaves = ["index.ts", "Loom.TS", "heddle.vue", "a.json", "b.md"];
    const filePaths = new Set<string>();
    while (filePaths.size < 70) {
      const segments = [
        pick(dirs),
        ...Array.from({ length: Math.floor(random() * 3) }, () => pick(mods)),
        pick(leaves),
      ];
      filePaths.add(segments.join("/"));
    }
    const files = [...filePaths];
    const entryFor = (): string => {
      const file = pick(files);
      const segments = file.split("/");
      const kind = Math.floor(random() * 14);
      const dir = pick(dirs);
      const mod = pick(mods);
      switch (kind) {
        case 0:
          return `${dir}/${mod}/**`;
        case 1:
          return `${dir}/**/${pick(leaves)}`;
        case 2:
          return `**/${pick(leaves)}`;
        case 3:
          return `${dir}/*/${pick(leaves).replace("index", "?ndex")}`;
        case 4:
          return `**/${mod}/*.ts`;
        case 5:
          return "**";
        case 6:
          return `*.vue`;
        case 7:
          return file;
        case 8:
          return segments.slice(0, Math.max(1, segments.length - 1)).join("/");
        case 9:
          return segments.slice(1).join("/") || file;
        case 10:
          return `${mod}/${pick(leaves)}`;
        case 11:
          return `./${file.toUpperCase()}:12`;
        case 12:
          return mod;
        default:
          return `${dir}/${mod}/${pick(mods)}/**/*.TS`;
      }
    };
    const entries: Array<{ id: string; appliesTo: string[] }> = [];
    for (let index = 0; index < 120; index += 1) {
      const appliesTo = Array.from({ length: 1 + Math.floor(random() * 4) }, entryFor);
      const knowledge = record(`Synthetic rule ${index}`, appliesTo);
      entries.push({ id: knowledge.id, appliesTo: knowledge.appliesTo });
    }
    const weights: Array<[string, number]> = files.map((file) => [
      random() < 0.3 ? file.toUpperCase().replace(/^\.?\//, "") : file,
      1 + Math.floor(random() * 5),
    ]);

    // Reference: every (entry, file) pair through appliesToStrength, in the implementation's file order.
    const contexts = [{ name: project.name, rootPath: project.rootPath }];
    const spelling = new Map<string, string>();
    const merged = new Map<string, number>();
    for (const [path, weight] of weights) {
      const normalized = normalizePath(path, contexts);
      if (!spelling.has(normalized)) spelling.set(normalized, path);
      merged.set(normalized, (merged.get(normalized) ?? 0) + weight);
    }
    const ordered = [...merged].sort(([lp, lw], [rp, rw]) => rw - lw || (lp < rp ? -1 : 1));
    const budget = createAppliesToBudget(Number.MAX_SAFE_INTEGER);
    const expected = entries
      .flatMap(({ id, appliesTo }) => {
        const patterns = appliesTo.map((entry) => normalizePath(entry, contexts)).filter(Boolean);
        let score = 0;
        let best = 0;
        let matchedPath = "";
        const covered: string[] = [];
        for (const [file, weight] of ordered) {
          const strength = Math.max(0, ...patterns.map((pattern) => appliesToStrength(pattern, file, budget)));
          if (strength <= 0) continue;
          const contribution = weight * strength;
          score += contribution;
          covered.push(spelling.get(file)!);
          if (contribution > best) {
            best = contribution;
            matchedPath = spelling.get(file)!;
          }
        }
        return covered.length === 0 ? [] : [{ id, matchedPath, score, files: covered }];
      })
      .sort((left, right) => right.score - left.score || (left.id < right.id ? -1 : 1));
    expect(expected.length).toBeGreaterThan(20);

    const actual = rank(weights, 1_000).map(({ id, matchedPath, score, files: covered }) => ({
      id,
      matchedPath,
      score,
      files: covered,
    }));
    expect(actual).toEqual(expected);
  });

  it("does not exhaust the match budget on 2,000 Knowledge of 10 globs against 100 files", () => {
    const { store, project, rank } = setup();
    const db = (store as unknown as { db: DatabaseSync }).db;
    const insert = db.prepare(
      `INSERT INTO knowledge (id, project_id, idempotency_key, title, body, kind, status, created_at, updated_at,
         references_json, tags_json, applies_to_json) VALUES (?, ?, ?, ?, 'b', 'pattern', 'active', ?, ?, '[]', '[]', ?)`,
    );
    const now = new Date().toISOString();
    for (let index = 0; index < 2_000; index += 1) {
      const globs = Array.from({ length: 10 }, (_, part) => `src/mod${index % 50}/**/part${part}/*.ts`);
      insert.run(`stress-${index}`, project.id, `stress-${index}`, `Stress ${index}`, now, now, JSON.stringify(globs));
    }
    const weights: Array<[string, number]> = Array.from({ length: 100 }, (_, file) => [
      `src/mod${file % 50}/a/b/part${file % 10}/file${file}.ts`,
      1 + (file % 7),
    ]);
    const budgets: AppliesToBudget[] = [];
    setAppliesToBudgetProbe(budgets);

    const result = rank(weights, 15);

    expect(result).toHaveLength(15);
    expect(budgets).toHaveLength(1);
    expect(budgets[0]?.exhausted).toBe(false);
    // Testing every pair spent the whole 20M units here; the index leaves a third of it unused.
    expect(budgets[0]!.units).toBeLessThan(budgets[0]!.limit * 0.7);
  });
});

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
