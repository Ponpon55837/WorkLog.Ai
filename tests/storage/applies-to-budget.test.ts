import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  appliesToEntries,
  appliesToStrength,
  compileAppliesTo,
  createAppliesToBudget,
  setAppliesToWorkCounter,
  type AppliesToBudget,
} from "../../packages/storage/src/applies-to-match.js";
import { normalizePath, projectRelativePath } from "../../packages/storage/src/search-text.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional patterns and paths only. The limits the product enforces on what reaches matching:
const MAX_PATTERN = 1_000;
const MAX_STARS = 16;
const MAX_ENTRIES = 30;
const MAX_PATH = 1_000;
const MAX_PATHS = 20;
// Every loop comparison is charged at least once: examined <= K x charged, with K = 1.
const K = 1;
const CASES = 140;
const CONTEXTS = [{ name: "fictional-project", rootPath: "/fictional/root/fictional-project" }];

interface HostileCase {
  shape: string;
  patterns: string[];
  paths: string[];
}

const cleanups: Array<() => void> = [];

/** Small deterministic generator so every run and platform sees the same cases. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

/** Stars as the bound counts them, worked out independently: `**` (with its slash) runs fold, a lone `*` is one. */
function starCount(pattern: string): number {
  return (pattern.replace(/\*\*\/?/g, "§").match(/§+|\*/g) ?? []).length;
}

/** Hostile combinations within the limits: the shapes earlier reviews found plus random ones. */
function hostileCase(random: () => number, index: number): HostileCase {
  const int = (max: number) => Math.floor(random() * (max + 1));
  const a = (count: number) => "a".repeat(Math.max(0, count));
  const nearMiss = (length: number) => {
    const chars = a(length).split("");
    for (let flips = int(3); flips > 0; flips -= 1) chars[int(Math.max(0, length - 1))] = random() < 0.5 ? "b" : "/";
    return chars.join("");
  };
  const many = <T>(count: number, make: (item: number) => T) => Array.from({ length: count }, (_, item) => make(item));
  const shapes = [
    () => {
      // The first finding: two stars around long near-miss literal runs, so every rejection but the search passes.
      const run = 1 + int(495);
      return {
        shape: "near-miss literal runs",
        patterns: many(1 + int(MAX_ENTRIES - 1), (item) => `x*${a(run - (item % 3))}b${a(run)}*y`),
        paths: many(1 + int(MAX_PATHS - 1), (item) => `x${a(MAX_PATH - 2 - item)}y`),
      };
    },
    () => {
      const stars = 1 + int(MAX_STARS - 1);
      return {
        shape: "alternating ?*",
        patterns: many(1 + int(3), (item) => `${"?*".repeat(stars)}${a(int(MAX_PATTERN - 2 * stars - 2))}${item}`),
        paths: many(1 + int(4), () => nearMiss(1 + int(MAX_PATH - 1))),
      };
    },
    () => {
      // Maximal stars between long literals a long path contains in order: the simulation reads the whole path.
      const run = 1 + int(Math.floor((MAX_PATTERN - MAX_STARS) / (MAX_STARS - 1)) - 1);
      const pattern = `${`*${a(run)}`.repeat(MAX_STARS - 1)}*`;
      return {
        shape: "maximal stars, long literals",
        patterns: many(1 + int(1), (item) => (item ? `*${pattern}` : pattern)),
        paths: many(1 + int(1), () => (random() < 0.5 ? a(MAX_PATH) : nearMiss(MAX_PATH))),
      };
    },
    () => ({
      shape: "repeated prefixes and suffixes",
      patterns: many(1 + int(MAX_ENTRIES - 1), (item) =>
        item % 2 ? `${a(MAX_PATTERN - 1 - (item % 7))}*` : `**${a(MAX_PATTERN - 2 - (item % 5))}`,
      ),
      paths: many(1 + int(MAX_PATHS - 1), (item) => `${a(MAX_PATH - 1 - (item % 3))}${item % 2 ? "b" : "a"}`),
    }),
    () => ({
      // Distinct entries of exactly the length limit, so the compile cache cannot help.
      shape: "distinct long patterns",
      patterns: many(MAX_ENTRIES, (item) => {
        const head = `${index}-${item}-*`;
        return `${head}${a(MAX_PATTERN - head.length - 2)}*z`.slice(0, MAX_PATTERN);
      }),
      paths: many(1 + int(2), () => `${index}-${int(MAX_ENTRIES)}-${a(MAX_PATH - 8)}z`.slice(0, MAX_PATH)),
    }),
    () => ({
      // Long plain entries with many segments against paths that share them: the suffix, prefix and segment checks.
      shape: "plain entries with many segments",
      patterns: many(1 + int(MAX_ENTRIES - 1), (item) => `${"a/".repeat(int(MAX_PATTERN / 2 - 2))}a${item}`),
      paths: many(1 + int(MAX_PATHS - 1), () => `${"a/".repeat(int(MAX_PATH / 2 - 1))}a`),
    }),
    () => {
      const alphabet = ["a", "b", "/", "*", "**", "**/", "?", ".", "ab", "aaaa", "a/"];
      let pattern = "";
      while (pattern.length < 1 + int(MAX_PATTERN - 1)) pattern += alphabet[int(alphabet.length - 1)];
      pattern = pattern.slice(0, MAX_PATTERN);
      while (starCount(pattern) > MAX_STARS) pattern = pattern.replace("*", "a");
      return {
        shape: "random glob",
        patterns: [pattern],
        paths: many(1 + int(5), () => nearMiss(int(MAX_PATH))),
      };
    },
  ];
  return shapes[index % shapes.length]!();
}

/** One record's scan the way the read paths run it: the stored list through the entry gate, then every pair. */
function scan(record: HostileCase, budget: AppliesToBudget): { examined: number; gateUnits: number } {
  const counter = { examined: 0 };
  setAppliesToWorkCounter(counter);
  try {
    const before = budget.units;
    const patterns = appliesToEntries(JSON.stringify(record.patterns), CONTEXTS, budget);
    const gateUnits = budget.units - before;
    for (const pattern of patterns) {
      const matcher = compileAppliesTo(pattern, budget);
      for (const path of record.paths) {
        matcher(path, budget);
        appliesToStrength(pattern, path, budget);
      }
    }
    return { examined: counter.examined, gateUnits };
  } finally {
    setAppliesToWorkCounter(undefined);
  }
}

/** The RegExp normalization the linear one replaced, kept as the reference for its results. */
function legacyNormalizePath(raw: string, projects: Array<{ name: string; rootPath: string }>): string {
  let value = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  value = value.replace(/#L\d+.*$/i, "").replace(/:\d+(?::\d+)?$/, "");
  const lower = value.toLowerCase();
  for (const project of projects) {
    const root = project.rootPath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (root && (lower === root || lower.startsWith(`${root}/`)))
      return lower.slice(root.length + 1).replace(/\/+$/, "");
  }
  for (const project of projects) {
    const name = project.name.toLowerCase();
    if (name && lower.startsWith(`${name}/`)) return lower.slice(name.length + 1).replace(/\/+$/, "");
  }
  return lower.replace(/\/+$/, "");
}

function legacyProjectRelativePath(
  raw: string,
  projects: Array<{ name: string; rootPath: string }>,
): string | undefined {
  let value = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  value = value
    .replace(/#L\d+.*$/i, "")
    .replace(/:\d+(?::\d+)?$/, "")
    .replace(/\/+$/, "");
  const lower = value.toLowerCase();
  if (lower.length !== value.length) return undefined;
  for (const project of projects) {
    const root = project.rootPath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (root && lower.startsWith(`${root}/`)) return value.slice(root.length + 1);
  }
  for (const project of projects) {
    const name = project.name.toLowerCase();
    if (name && lower.startsWith(`${name}/`)) return value.slice(name.length + 1);
  }
  return value;
}

function trackedStore(): { store: WorkIntelligenceStore; root: string; db: DatabaseSync } {
  const store = new WorkIntelligenceStore(":memory:");
  const root = mkdtempSync(join(tmpdir(), "wi-budget-"));
  cleanups.push(
    () => rmSync(root, { recursive: true, force: true }),
    () => store.close(),
  );
  const project = store.addProject("Synthetic Budget", root);
  store.updateProject(project.id, { status: "tracked" });
  return { store, root, db: (store as unknown as { db: DatabaseSync }).db };
}

afterEach(() => {
  setAppliesToWorkCounter(undefined);
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("appliesTo accounting invariant", () => {
  it("charges at least every comparison the matcher makes, on hostile cases within the enforced limits", () => {
    const random = seeded(20_261_112);
    const shapes = new Set<string>();
    for (let index = 0; index < CASES; index += 1) {
      const record = hostileCase(random, index);
      shapes.add(record.shape);
      for (const pattern of record.patterns) {
        expect(pattern.length).toBeLessThanOrEqual(MAX_PATTERN);
        expect(starCount(pattern)).toBeLessThanOrEqual(MAX_STARS);
      }
      for (const path of record.paths) expect(path.length).toBeLessThanOrEqual(MAX_PATH);
      expect(record.patterns.length).toBeLessThanOrEqual(MAX_ENTRIES);
      expect(record.paths.length).toBeLessThanOrEqual(MAX_PATHS);

      const budget = createAppliesToBudget(Number.MAX_SAFE_INTEGER);
      const { examined, gateUnits } = scan(record, budget);
      // The gate's units pay for JSON parsing and normalization, which run in native code and are not counted, so
      // the comparison uses only what the matcher itself was charged.
      expect({ shape: record.shape, index, over: examined > K * (budget.units - gateUnits) }).toEqual({
        shape: record.shape,
        index,
        over: false,
      });
      expect(examined).toBeGreaterThan(0);
    }
    expect(shapes.size).toBe(7);
  }, 60_000);

  it("charges each pair before it runs, never after: a budget one unit short does none of the pair's checks", () => {
    const random = seeded(7);
    for (let index = 0; index < 42; index += 1) {
      const record = hostileCase(random, index);
      const pattern = normalizePath(record.patterns[0]!, CONTEXTS);
      const path = record.paths[0]!;
      const full = createAppliesToBudget(Number.MAX_SAFE_INTEGER);
      const matcher = compileAppliesTo(pattern, full);
      // Once first, so a plain entry's lazily cached segment table is in place for both measured calls.
      matcher(path, full);
      const compiled = full.units;
      matcher(path, full);
      const pairUnits = full.units - compiled;
      if (pairUnits === 0) continue; // an empty path or entry never matches and costs nothing
      const counter = { examined: 0 };
      setAppliesToWorkCounter(counter);
      const short = createAppliesToBudget(pairUnits - 1);
      expect(matcher(path, short)).toBe(false);
      setAppliesToWorkCounter(undefined);
      expect(short.exhausted).toBe(true);
      expect(short.units).toBeLessThanOrEqual(short.limit);
      expect(counter.examined).toBeLessThanOrEqual(short.units);
    }
  });

  it("stops every hostile scan at its limit, does no further work, and reports the cut", () => {
    const random = seeded(20_261_113);
    for (let index = 0; index < 42; index += 1) {
      const record = hostileCase(random, index);
      // Scanned twice, so the measured scan finds its globs cached exactly like the cut scan after it.
      scan(record, createAppliesToBudget(Number.MAX_SAFE_INTEGER));
      const full = createAppliesToBudget(Number.MAX_SAFE_INTEGER);
      scan(record, full);
      const limit = Math.max(1, Math.floor(full.units / 3));
      const budget = createAppliesToBudget(limit);
      const { examined } = scan(record, budget);
      expect(budget.exhausted).toBe(true);
      expect(budget.units).toBeLessThanOrEqual(limit);
      expect(examined).toBeLessThanOrEqual(limit);
      // Once spent, a whole further scan of the same record examines nothing.
      expect(scan(record, budget).examined).toBe(0);
    }
  }, 60_000);

  it("never tokenizes or normalizes an entry above the length or count limit, and counts it as skipped", () => {
    const budget = createAppliesToBudget();
    const counter = { examined: 0 };
    setAppliesToWorkCounter(counter);
    const huge = `src/*${"a".repeat(5_000_000)}*.ts`;
    expect(compileAppliesTo(huge, budget)("src/a.ts", budget)).toBe(false);
    expect(appliesToStrength(huge, "src/a.ts", budget)).toBe(0);
    expect(appliesToEntries(JSON.stringify([`${"b".repeat(MAX_PATTERN + 1)}*`, "src/*.ts"]), [], budget)).toEqual([
      "src/*.ts",
    ]);
    const listed = Array.from({ length: MAX_ENTRIES + 5 }, (_, item) => `src/${item}/*.ts`);
    expect(appliesToEntries(JSON.stringify(listed), [], budget)).toHaveLength(MAX_ENTRIES);
    setAppliesToWorkCounter(undefined);
    expect(counter.examined).toBe(0);
    expect(budget.skippedEntries).toBe(3 + 5);
    expect(budget.exhausted).toBe(false);
  });

  it("charges a cache miss for every distinct pattern, so evicting cannot turn into unpaid recompiling", () => {
    const patterns = Array.from({ length: 1_200 }, (_, item) => `${item}-*${"a".repeat(MAX_PATTERN - 10)}`);
    const first = createAppliesToBudget(Number.MAX_SAFE_INTEGER);
    for (const pattern of patterns) compileAppliesTo(pattern, first);
    const second = createAppliesToBudget(Number.MAX_SAFE_INTEGER);
    for (const pattern of patterns) compileAppliesTo(pattern, second);
    // The cache holds far fewer than 1,200 such patterns, so the second pass recompiles and pays like the first.
    expect(second.units).toBeGreaterThan(first.units / 2);
    const counter = { examined: 0 };
    setAppliesToWorkCounter(counter);
    const third = createAppliesToBudget(Number.MAX_SAFE_INTEGER);
    for (const pattern of patterns) compileAppliesTo(pattern, third);
    setAppliesToWorkCounter(undefined);
    expect(counter.examined).toBeLessThanOrEqual(third.units);
    // A small working set stays cached and costs one unit per lookup.
    const hot = createAppliesToBudget(Number.MAX_SAFE_INTEGER);
    for (let round = 0; round < 50; round += 1) compileAppliesTo("src/**/*.ts", hot);
    // The first lookup also pays for telling the glob apart (its length); later ones find it compiled in the cache.
    expect(hot.units).toBeLessThanOrEqual(17 * "src/**/*.ts".length + 1 + 49);
  });
});

describe("path normalization", () => {
  it("gives the RegExp normalization's results in linear time", () => {
    const random = seeded(99);
    const alphabet = ["#", "L", "l", "1", "9", ":", "/", "\\", ".", "\n", "\u2028", "a", " ", "./", "#L1", "İ"];
    const contexts = [
      { name: "Fictional", rootPath: "C:\\fictional\\root\\" },
      { name: "other", rootPath: "/srv/other//" },
    ];
    const cases = [
      `a${"/".repeat(998)}b`,
      `${"#L1".repeat(333)}\n`,
      `#L${"1".repeat(997)}\n`,
      `#L${"1".repeat(997)}`,
      `src/a.ts#L12-L40`,
      `C:\\fictional\\root\\src\\a.ts:12:4`,
      "fictional/src//",
    ];
    for (let round = 0; round < 20_000; round += 1) {
      cases.push(
        Array.from({ length: Math.floor(random() * 24) }, () => alphabet[Math.floor(random() * alphabet.length)]).join(
          "",
        ),
      );
    }
    for (const raw of cases) {
      expect([raw, normalizePath(raw, contexts)]).toEqual([raw, legacyNormalizePath(raw, contexts)]);
      expect([raw, projectRelativePath(raw, contexts)]).toEqual([raw, legacyProjectRelativePath(raw, contexts)]);
    }
  });
});

describe("stored appliesTo above the write-time limits", () => {
  it("loads and shows unchanged, never matches, and marks every scan that skipped it", () => {
    const { store, root, db } = trackedStore();
    const recorded = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: "over-limit",
      kind: "gotcha",
      title: "Fictional over-limit scope",
      body: "Synthetic Knowledge whose stored appliesTo a crafted file enlarged.",
      appliesTo: ["src/a.ts"],
    });
    if (recorded.outcome !== "knowledge_recorded") throw new Error("Expected Knowledge.");
    const stored = [`src/${"a".repeat(MAX_PATTERN)}*`, ...Array.from({ length: MAX_ENTRIES }, (_, item) => `x${item}`)];
    stored.push("src/a.ts");
    // An older build or a crafted import could have stored this; the public write path cannot.
    db.prepare("UPDATE knowledge SET applies_to_json = ? WHERE id = ?").run(
      JSON.stringify(stored),
      recorded.knowledge.id,
    );
    const listed = store.searchKnowledge({ projectRoot: root, limit: 10 });
    expect(listed).toMatchObject({
      items: [{ id: recorded.knowledge.id, appliesTo: stored, stalenessUnchecked: true }],
    });
    // "src/a.ts" sits past the 30th entry, so it is not considered either; both skips are reported.
    expect(store.getFileHistory({ projectRoot: root, paths: ["src/a.ts"] })).toMatchObject({
      knowledge: [],
      appliesToScanTruncated: true,
    });
    expect(store.searchKnowledgeForAgent({ projectRoot: root, q: "src/a.ts zzyzx" })).toMatchObject({
      appliesToScanTruncated: true,
    });
  });

  it("survives redaction that lengthens it past the write limit: exports, re-imports and reads back unchanged", () => {
    const { store, root } = trackedStore();
    // A 1,000-character entry the write path accepts; each fictional connection-string password is masked with a
    // longer marker, so the stored entry is longer than the write limit.
    const secret = "pg://fictional:abcdefgh@host ";
    const raw = `src/${secret.repeat(Math.floor((MAX_PATTERN - 5) / secret.length))}x`;
    expect(raw.length).toBeLessThanOrEqual(MAX_PATTERN);
    const recorded = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: "redacted-scope",
      kind: "gotcha",
      title: "Fictional redacted scope",
      body: "Synthetic Knowledge whose appliesTo held fictional credentials.",
      appliesTo: [raw, "src/a.ts"],
    });
    if (recorded.outcome !== "knowledge_recorded") throw new Error("Expected Knowledge.");
    const stored = recorded.knowledge.appliesTo;
    expect(stored[0]).toContain("[REDACTED:connection_string_password]");
    expect(stored[0]!.length).toBeGreaterThan(MAX_PATTERN);
    expect(stored[0]!.length).toBeLessThanOrEqual(4_096);

    const project = store.listProjects().find((candidate) => candidate.name === "Synthetic Budget");
    if (!project) throw new Error("Expected the synthetic project.");
    const bundle = store.exportProjectData({ type: "project", projectId: project.id });
    const destination = new WorkIntelligenceStore(":memory:");
    cleanups.push(() => destination.close());
    const preview = destination.previewProjectDataImport({ bundle, remap: [] });
    expect(preview).toMatchObject({ additions: { knowledge: 1 } });
    expect(Object.values(preview.conflicts).reduce((total, value) => total + value, 0)).toBe(0);
    expect(destination.importProjectData({ bundle, remap: [] }).additions.knowledge).toBe(1);
    const imported = destination.listProjects().find((candidate) => candidate.id === project.id);
    if (!imported) throw new Error("Expected the imported project.");
    destination.updateProject(imported.id, { status: "tracked" });
    expect(destination.searchKnowledge({ projectRoot: imported.rootPath, limit: 10 })).toMatchObject({
      items: [{ id: recorded.knowledge.id, appliesTo: stored }],
    });
    // The long entry never matches and the scan says it skipped one; the entry within the limit still matches.
    expect(destination.getFileHistory({ projectRoot: imported.rootPath, paths: ["src/a.ts"] })).toMatchObject({
      knowledge: [{ id: recorded.knowledge.id }],
      appliesToScanTruncated: true,
    });
  });

  it("imports lists up to the structural bound and refuses only lists beyond it, with the reason", () => {
    const { store, root } = trackedStore();
    const recorded = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: "import-limit",
      kind: "gotcha",
      title: "Fictional import scope",
      body: "Synthetic Knowledge exported and imported again.",
      appliesTo: ["src/a.ts"],
    });
    if (recorded.outcome !== "knowledge_recorded") throw new Error("Expected Knowledge.");
    const project = store.listProjects().find((candidate) => candidate.name === "Synthetic Budget");
    if (!project) throw new Error("Expected the synthetic project.");
    const bundle = store.exportProjectData({ type: "project", projectId: project.id });
    const knowledge = bundle.tables.knowledge as Array<Record<string, unknown>>;
    const reason = "knowledge.applies_to_json 必須是最多 100 筆、每筆最多 4,096 字元的文字清單。";
    for (const crafted of [
      JSON.stringify([`src/${"a".repeat(4_097)}`]),
      JSON.stringify(Array.from({ length: 101 }, (_, item) => `src/${item}`)),
      JSON.stringify([7]),
      JSON.stringify({ src: "a.ts" }),
    ]) {
      knowledge[0]!.applies_to_json = crafted;
      const destination = new WorkIntelligenceStore(":memory:");
      cleanups.push(() => destination.close());
      expect(() => destination.previewProjectDataImport({ bundle, remap: [] })).toThrow(reason);
    }
    // At the bound (beyond the write limits) the list imports byte for byte; matching skips what is over them.
    const atBound = [
      `src/${"a".repeat(4_092)}`,
      ...Array.from({ length: 99 }, (_, item) => `src/${item}/${"b".repeat(MAX_PATTERN)}`),
    ];
    expect(atBound.every((entry) => entry.length <= 4_096)).toBe(true);
    knowledge[0]!.applies_to_json = JSON.stringify(atBound);
    const destination = new WorkIntelligenceStore(":memory:");
    cleanups.push(() => destination.close());
    expect(destination.importProjectData({ bundle, remap: [] }).additions.knowledge).toBe(1);
    const imported = destination.listProjects().find((candidate) => candidate.id === project.id);
    if (!imported) throw new Error("Expected the imported project.");
    destination.updateProject(imported.id, { status: "tracked" });
    expect(destination.searchKnowledge({ projectRoot: imported.rootPath, limit: 10 })).toMatchObject({
      items: [{ appliesTo: atBound, stalenessUnchecked: true }],
    });
    // Every read of the largest importable list is charged: one scan reads it within its budget and reports the skip.
    expect(destination.getFileHistory({ projectRoot: imported.rootPath, paths: ["src/a.ts"] })).toMatchObject({
      knowledge: [],
      appliesToScanTruncated: true,
    });
    const budget = createAppliesToBudget();
    expect(appliesToEntries(JSON.stringify(atBound), [], budget)).toEqual([]);
    expect(budget.exhausted).toBe(false);
    // JSON.parse is charged four units per character, its measured cost against a plain character read.
    expect(budget.units).toBeLessThanOrEqual(4 * JSON.stringify(atBound).length + 1);
    expect(budget.skippedEntries).toBe(100);
  });
});
