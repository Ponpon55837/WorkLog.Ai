import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";
import {
  appliesToStrength,
  compileAppliesTo,
  createAppliesToBudget,
  matchesAppliesTo,
} from "../../packages/storage/src/applies-to-match.js";

// Fictional paths and patterns only.
const ORDINARY_PATTERNS = [
  "src/*.ts",
  "src/**",
  "src/**/*.ts",
  "src/**/index.ts",
  "**/*.md",
  "**",
  "*",
  "docs/?.md",
  "apps/web/src/components/*/Ui*.vue",
  "packages/*/src/**/*-service.ts",
  "tests/**/fixtures/**",
  "a**b",
  "src/***",
  "src/*/**/x?.ts",
  "file.name+(1).ts*",
  "[draft]/*.md",
  "$weird^/path|*.ts",
  "ab*ba",
  "a*a",
  "**/x.ts",
  "src/*/x?.ts*",
  "*.ts",
  "?b?",
];
const ORDINARY_PATHS = [
  "",
  "src/a.ts",
  "src/a.tsx",
  "src/nested/a.ts",
  "src/index.ts",
  "src/x/y/index.ts",
  "src/abcindex.ts",
  "README.md",
  "docs/a.md",
  "docs/ab.md",
  "docs/guide/a.md",
  "apps/web/src/components/ui/UiButton.vue",
  "apps/web/src/components/ui/deep/UiButton.vue",
  "packages/storage/src/deep/knowledge-service.ts",
  "packages/storage/src/knowledge-service.ts",
  "tests/storage/fixtures/one.json",
  "tests/fixtures",
  "ab",
  "a/b",
  "a/x/b",
  "src/q/xa.ts",
  "src/q/r/xa.ts",
  "file.name+(1).ts",
  "file.name+(1).tsx",
  "fileXname+(1).ts",
  "[draft]/note.md",
  "$weird^/path|a.ts",
  "src/line\nbreak.ts",
  "aba",
  "a",
  "abba",
  "ababa",
  "x.ts",
  "src/q/x1.tsx",
];
const ADVERSARIAL_PATTERN = "**a**a**a**a**a**a**a**b";
// The second review's input: 500 stars per entry, 30 entries, against 20 paths at the 1,000-character limit.
const STAR_FLOOD_PATTERN = "a*".repeat(500);
const LONG_PATHS = Array.from({ length: 20 }, () => "a".repeat(1_000));
// The costliest shape the star bound still allows: 16 stars between literal runs that a long path contains in order,
// so every exact rejection passes and the simulation reads the whole path (466 tokens x 480 characters per match).
const HEAVY_PATTERN = `${`**${"a".repeat(30)}`.repeat(15)}**`;
const HEAVY_PATH = "a".repeat(480);
const HEAVY_TOKENS = 466;
const HEAVY_PATH_STEPS = 1 + HEAVY_TOKENS * HEAVY_PATH.length;
// Distinct entries (a stored list keeps one of each); every suffix is a run of "a" the long path ends with.
const HEAVY_PATTERNS = Array.from({ length: 30 }, (_, index) => `${HEAVY_PATTERN}${"a".repeat(index)}`);

/** The anchored RegExp the matcher replaced, kept here as the reference for its semantics. */
function legacyGlobMatches(pattern: string, path: string): boolean {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += pattern[index + 2] === "/" ? 2 : 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return Boolean(path) && new RegExp(`^${source}$`).test(path);
}

const cleanups: Array<() => void> = [];

/** Small deterministic generator so the random table is the same on every run and platform. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

function randomGlobTable(seed: number, rounds: number, maxPattern: number, maxPath: number): Array<[string, string]> {
  const random = seeded(seed);
  const alphabet = ["a", "b", "/", "*", "**", "?", ".", "ab", "ba", "a/"];
  const pathAlphabet = ["a", "b", "/", ".", "ab"];
  const table: Array<[string, string]> = [];
  while (table.length < rounds) {
    const pattern = Array.from(
      { length: 1 + Math.floor(random() * maxPattern) },
      () => alphabet[Math.floor(random() * alphabet.length)],
    ).join("");
    const path = Array.from(
      { length: Math.floor(random() * maxPath) },
      () => pathAlphabet[Math.floor(random() * pathAlphabet.length)],
    ).join("");
    // Plain entries use path-segment rules, not the glob.
    if (/[*?]/.test(pattern)) table.push([pattern, path]);
  }
  return table;
}

function syntheticStore(): { store: WorkIntelligenceStore; root: string; otherRoot: string } {
  const store = new WorkIntelligenceStore(":memory:");
  const roots = ["wi-glob-a-", "wi-glob-b-"].map((prefix) => mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(
    () => roots.forEach((root) => rmSync(root, { recursive: true, force: true })),
    () => store.close(),
  );
  for (const [index, root] of roots.entries()) {
    const project = store.addProject(`Synthetic Glob ${index}`, root);
    store.updateProject(project.id, { status: "tracked" });
  }
  return { store, root: roots[0]!, otherRoot: roots[1]! };
}

function recordScoped(store: WorkIntelligenceStore, projectRoot: string, key: string, appliesTo: string[]): string {
  const result = store.recordKnowledge({
    projectRoot,
    idempotencyKey: `glob-${key}`,
    kind: "gotcha",
    title: `Fictional ${key} scope`,
    body: `Synthetic Knowledge scoped by ${key} globs.`,
    appliesTo,
  });
  if (result.outcome !== "knowledge_recorded") throw new Error(`Expected Knowledge ${key}.`);
  return result.knowledge.id;
}

afterEach(() => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("appliesTo glob matching", () => {
  it("matches ordinary patterns exactly as the previous RegExp did", () => {
    for (const pattern of ORDINARY_PATTERNS)
      for (const path of ORDINARY_PATHS)
        expect([pattern, path, matchesAppliesTo(path, pattern)]).toEqual([
          pattern,
          path,
          legacyGlobMatches(pattern, path),
        ]);
  });

  it("pins the supported glob rules", () => {
    expect(matchesAppliesTo("src/a.ts", "src/*.ts")).toBe(true);
    expect(matchesAppliesTo("src/nested/a.ts", "src/*.ts")).toBe(false);
    expect(matchesAppliesTo("src/nested/a.ts", "src/**/*.ts")).toBe(true);
    expect(matchesAppliesTo("src/a.ts", "src/**/*.ts")).toBe(true);
    expect(matchesAppliesTo("docs/a.md", "docs/?.md")).toBe(true);
    expect(matchesAppliesTo("docs/ab.md", "docs/?.md")).toBe(false);
    expect(matchesAppliesTo("src/a.ts", "src")).toBe(true);
    expect(matchesAppliesTo("src/a.ts", "src/a.ts")).toBe(true);
    expect(matchesAppliesTo("lib/src/a.ts", "src/a.ts")).toBe(true);
    expect(matchesAppliesTo("src/b.ts", "src/a.ts")).toBe(false);
    expect(matchesAppliesTo("", "**")).toBe(false);
    expect(appliesToStrength("src/**", "src/a.ts")).toBe(0.8);
    expect(appliesToStrength("src", "src/a.ts")).toBe(0.6);
  });

  it("agrees with the previous RegExp on a fixed random table of star-heavy patterns", () => {
    const random = seeded(20_261_112);
    const alphabet = ["a", "b", "/", "*", "**", "?", "."];
    const pathAlphabet = ["a", "b", "/", "."];
    for (let round = 0; round < 2_000; round += 1) {
      const pattern = Array.from(
        { length: 1 + Math.floor(random() * 8) },
        () => alphabet[Math.floor(random() * 7)],
      ).join("");
      const path = Array.from(
        { length: 1 + Math.floor(random() * 10) },
        () => pathAlphabet[Math.floor(random() * 4)],
      ).join("");
      // Plain entries use path-segment rules, not the glob.
      if (!/[*?]/.test(pattern)) continue;
      expect([pattern, path, compileAppliesTo(pattern)(path)]).toEqual([
        pattern,
        path,
        legacyGlobMatches(pattern, path),
      ]);
    }
  });

  it("stays linear on star-heavy stored patterns against long caller paths", () => {
    const paths = ["a".repeat(500), `${"a/".repeat(249)}a`, "ba".repeat(250)];
    const started = performance.now();
    for (const path of paths) {
      expect(matchesAppliesTo(path, ADVERSARIAL_PATTERN)).toBe(false);
      expect(appliesToStrength(ADVERSARIAL_PATTERN, path)).toBe(0);
    }
    expect(matchesAppliesTo(`${"a".repeat(499)}b`, ADVERSARIAL_PATTERN)).toBe(true);
    // A generous bound: the previous RegExp needed seconds at 60 characters and hung at this length.
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("keeps file history and relaxed Knowledge search fast when stored appliesTo is star-heavy", () => {
    const root = mkdtempSync(join(tmpdir(), "wi-glob-"));
    const store = new WorkIntelligenceStore(":memory:");
    cleanups.push(
      () => rmSync(root, { recursive: true, force: true }),
      () => store.close(),
    );
    const project = store.addProject("Synthetic Glob", root);
    store.updateProject(project.id, { status: "tracked" });
    expect(
      store.recordKnowledge({
        projectRoot: root,
        idempotencyKey: "star-heavy-applies-to",
        kind: "gotcha",
        title: "Fictional star-heavy scope",
        body: "Synthetic Knowledge whose appliesTo is all stars.",
        appliesTo: [ADVERSARIAL_PATTERN],
      }).outcome,
    ).toBe("knowledge_recorded");
    const longPath = `src/${"a".repeat(480)}.ts`;
    const started = performance.now();
    expect(store.getFileHistory({ projectRoot: root, paths: [longPath] })).toMatchObject({
      outcome: "file_history",
      knowledge: [],
    });
    store.searchKnowledgeForAgent({ projectRoot: root, q: `${longPath} zzyzx` });
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("appliesTo exact rejections", () => {
  it("leave every result of a larger random table of literal-rich globs unchanged", () => {
    for (const [pattern, path] of randomGlobTable(20_261_113, 6_000, 14, 14))
      expect([pattern, path, compileAppliesTo(pattern)(path)]).toEqual([
        pattern,
        path,
        legacyGlobMatches(pattern, path),
      ]);
  });

  it("reject before the simulation, so a rejected pair costs one step", () => {
    const cases: Array<[string, string]> = [
      ["src/**/*.ts", "docs/a.ts"], // literal prefix
      ["src/**/*.ts", "src/a.md"], // literal suffix
      ["ab*ba", "aba"], // shorter than the pattern's literals
      ["src/*needle*/x.ts", "src/haystack/x.ts"], // a literal run absent between prefix and suffix
      ["src/*b*a*/x.ts", "src/ab/x.ts"], // literal runs present, but not in pattern order
    ];
    for (const [pattern, path] of cases) {
      const budget = createAppliesToBudget();
      expect([pattern, compileAppliesTo(pattern)(path, budget), budget.steps]).toEqual([pattern, false, 1]);
      expect(legacyGlobMatches(pattern, path)).toBe(false);
    }
    // A pair that reaches the simulation pays one step per middle token per middle character: here `**`, `*` and "a/b".
    const budget = createAppliesToBudget();
    expect(compileAppliesTo("src/**/*.ts")("src/a/b.ts", budget)).toBe(true);
    expect(budget.steps).toBe(1 + 2 * 3);
  });
});

describe("appliesTo complexity bound", () => {
  it("matches up to 16 stars as before and never matches above it", () => {
    const allowed = "*a".repeat(16);
    expect(matchesAppliesTo("a".repeat(16), allowed)).toBe(legacyGlobMatches(allowed, "a".repeat(16)));
    expect(matchesAppliesTo("a".repeat(16), allowed)).toBe(true);
    // Adjacent stars of one kind fold into one, so they do not count twice.
    expect(matchesAppliesTo("src/a.ts", `src/${"*".repeat(40)}.ts`)).toBe(true);
    const overComplex = "*a".repeat(17);
    expect(legacyGlobMatches(overComplex, "a".repeat(17))).toBe(true);
    expect(matchesAppliesTo("a".repeat(17), overComplex)).toBe(false);
    expect(appliesToStrength(overComplex, "a".repeat(17))).toBe(0);
  });

  it("answers the second review's 600 pattern-path pairs in one step each", () => {
    const budget = createAppliesToBudget();
    for (const pattern of Array.from({ length: 30 }, () => STAR_FLOOD_PATTERN))
      for (const path of LONG_PATHS) expect(appliesToStrength(pattern, path, budget)).toBe(0);
    expect(budget).toMatchObject({ steps: 600, exhausted: false });
  });
});

describe("appliesTo match budget", () => {
  it("stops a scan of allowed but costly globs at its step limit, deterministically", () => {
    const budget = createAppliesToBudget();
    let matched = 0;
    for (const path of LONG_PATHS.map(() => HEAVY_PATH))
      for (let index = 0; index < 30; index += 1) if (compileAppliesTo(HEAVY_PATTERN)(path, budget)) matched += 1;
    expect(budget.exhausted).toBe(true);
    expect(budget.steps).toBeLessThanOrEqual(budget.limit);
    expect(matched).toBe(Math.floor(budget.limit / HEAVY_PATH_STEPS));
    // The cut pair paid its own step and every character it could still afford, then stopped.
    const left = budget.limit - matched * HEAVY_PATH_STEPS - 1;
    expect(budget.steps).toBe(matched * HEAVY_PATH_STEPS + 1 + HEAVY_TOKENS * Math.floor(left / HEAVY_TOKENS));
    // A spent budget answers every later pair "no match" without work.
    expect(compileAppliesTo("src/**")("src/a.ts", budget)).toBe(false);
    expect(appliesToStrength("src", "src/a.ts", budget)).toBe(0);
  });

  it("reports the cut in file history, the relaxed Knowledge search, finalize, and staleness", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T08:00:00.000Z"));
    const { store, root } = syntheticStore();
    recordScoped(store, root, "heavy", HEAVY_PATTERNS);
    vi.setSystemTime(new Date("2026-06-01T09:00:00.000Z"));
    expect(store.getFileHistory({ projectRoot: root, paths: [HEAVY_PATH] })).toMatchObject({
      outcome: "file_history",
      knowledge: [],
      appliesToScanTruncated: true,
    });
    expect(store.searchKnowledgeForAgent({ projectRoot: root, q: `a/${HEAVY_PATH} zzyzx` })).toMatchObject({
      appliesToScanTruncated: true,
    });
    const finalized = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "glob-heavy-finalize",
      title: "Synthetic long-file change",
      summary: "Changed fictional files with long names.",
      changedFiles: Array.from({ length: 10 }, (_, index) => "a".repeat(HEAVY_PATH.length - index)),
      verification: { status: "passed" },
    });
    expect(finalized).toMatchObject({ outcome: "finalized", knowledgeToReviewTruncated: true });
    expect(finalized).not.toHaveProperty("knowledgeToReview");
    const listed = store.searchKnowledge({ projectRoot: root, limit: 10 });
    if (listed.outcome !== "knowledge") throw new Error("Expected a Knowledge list.");
    expect(listed.items[0]).toMatchObject({ stalenessUnchecked: true });
    expect(listed.items[0]).not.toHaveProperty("possiblyStale");
  });

  it("keeps ordinary scans of another project whole and unflagged", () => {
    const { store, root, otherRoot } = syntheticStore();
    recordScoped(store, root, "heavy", HEAVY_PATTERNS);
    const ordinary = recordScoped(store, otherRoot, "ordinary", ["src/**/*.ts"]);
    const history = store.getFileHistory({ projectRoot: otherRoot, paths: ["src/a.ts"] });
    expect(history).toMatchObject({ knowledge: [{ id: ordinary }] });
    expect(history).not.toHaveProperty("appliesToScanTruncated");
    const search = store.searchKnowledgeForAgent({ projectRoot: otherRoot, q: "src/a.ts zzyzx" });
    expect(search).not.toHaveProperty("appliesToScanTruncated");
  });
});

describe("stored appliesTo above the star bound", () => {
  it("loads, survives export and import, and never matches", () => {
    const { store, root } = syntheticStore();
    const overComplex = "*a".repeat(17);
    const id = recordScoped(store, root, "over-complex", [overComplex]);
    const listed = store.searchKnowledge({ projectRoot: root, limit: 10 });
    expect(listed).toMatchObject({ items: [{ id, appliesTo: [overComplex] }] });
    expect(store.getFileHistory({ projectRoot: root, paths: ["a".repeat(17)] })).toMatchObject({ knowledge: [] });

    // Look the project up by name: storage canonicalizes the root (lowercase on Windows), so the temp path differs.
    const project = store.listProjects().find((candidate) => candidate.name === "Synthetic Glob 0");
    if (!project) throw new Error("Expected the synthetic project.");
    const bundle = store.exportProjectData({ type: "project", projectId: project.id });
    const destination = new WorkIntelligenceStore(":memory:");
    cleanups.push(() => destination.close());
    expect(destination.importProjectData({ bundle, remap: [] }).additions.knowledge).toBe(1);
    // Import applies no write-time rule: the row arrives byte for byte.
    const imported = destination.listProjects().find((candidate) => candidate.id === project.id);
    if (!imported) throw new Error("Expected the imported project.");
    destination.updateProject(imported.id, { status: "tracked" });
    expect(destination.searchKnowledge({ projectRoot: imported.rootPath, limit: 10 })).toMatchObject({
      items: [{ id, appliesTo: [overComplex] }],
    });
  });

  it("can be archived or edited without touching appliesTo, and warns when the entry is kept", () => {
    const { store, root } = syntheticStore();
    const overComplex = "*a".repeat(17);
    const id = recordScoped(store, root, "over-complex-update", ["src/a.ts", overComplex]);
    const renamed = store.updateKnowledge({ projectRoot: root, knowledgeId: id, title: "Renamed fictional scope" });
    expect(renamed).toMatchObject({
      outcome: "knowledge_updated",
      knowledge: { appliesTo: ["src/a.ts", overComplex] },
    });
    expect(renamed).not.toHaveProperty("warnings");
    // The Web form re-sends every field; keeping the stored entry succeeds and says how to fix it.
    const resent = store.updateKnowledge({
      projectRoot: root,
      knowledgeId: id,
      body: "Edited synthetic body.",
      appliesTo: ["src/a.ts", overComplex],
    });
    expect(resent).toMatchObject({ outcome: "knowledge_updated" });
    expect(resent.outcome === "knowledge_updated" ? resent.warnings : undefined).toEqual([
      expect.stringContaining("positions 1 (from 0) never match. Use at most 16"),
    ]);
    expect(store.updateKnowledge({ projectRoot: root, knowledgeId: id, status: "archived" })).toMatchObject({
      outcome: "knowledge_updated",
      knowledge: { status: "archived" },
    });
    const fixed = store.updateKnowledge({ projectRoot: root, knowledgeId: id, appliesTo: ["src/a.ts"] });
    expect(fixed).not.toHaveProperty("warnings");
  });
});
