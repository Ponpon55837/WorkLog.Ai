import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";
import { appliesToStrength, compileAppliesTo, matchesAppliesTo } from "../../packages/storage/src/search-text.js";

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
];
const ADVERSARIAL_PATTERN = "**a**a**a**a**a**a**a**b";

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

afterEach(() => {
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
