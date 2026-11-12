import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeRecord, KnowledgeStaleness } from "../../packages/core/src/index.js";
import { compileAppliesTo } from "../../packages/storage/src/applies-to-match.js";
import { normalizePath } from "../../packages/storage/src/search-text.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only. The oracle below is the original per-Knowledge × per-Session × per-file implementation
// of the staleness check; the indexed implementation must return exactly the same result for every Knowledge.
const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface OracleSession {
  id: string;
  title: string;
  completedAt: string;
  files: Array<{ raw: string; normalized: string }>;
}

function oracleStaleness(
  knowledge: KnowledgeRecord,
  sessions: OracleSession[],
  contexts: Array<{ name: string; rootPath: string }>,
): KnowledgeStaleness | undefined {
  const matchers = knowledge.appliesTo
    .map((pattern) => normalizePath(pattern, contexts))
    .filter(Boolean)
    .map((pattern) => compileAppliesTo(pattern));
  const excluded = new Set([knowledge.sessionId, knowledge.lastConfirmedSessionId].filter(Boolean));
  const since = knowledge.lastConfirmedAt ?? knowledge.createdAt;
  let first: KnowledgeStaleness | undefined;
  let sessionCount = 0;
  for (const session of sessions) {
    if (session.completedAt <= since || excluded.has(session.id)) {
      continue;
    }
    const paths = session.files
      .filter((file) => matchers.some((matches) => matches(file.normalized)))
      .map((file) => file.raw);
    if (paths.length === 0) {
      continue;
    }
    sessionCount += 1;
    first ??= {
      sessionId: session.id,
      sessionTitle: session.title,
      completedAt: session.completedAt,
      paths: paths.slice(0, 5),
      sessionCount: 0,
    };
  }
  return first ? { ...first, sessionCount } : undefined;
}

describe("Knowledge staleness index equivalence", () => {
  it("returns exactly what the per-file matcher returns across globs, literals, Windows paths, projects, void, and equal timestamps", () => {
    const directory = mkdtempSync(join(tmpdir(), "work-intelligence-staleness-eq-"));
    tempDirs.push(directory);
    const databasePath = join(directory, "eq.sqlite");
    const rootA = join(directory, "apiary");
    const rootB = join(directory, "burrow");
    const store = new WorkIntelligenceStore(databasePath);
    stores.push(store);
    const alpha = store.addProject("Apiary", rootA);
    const beta = store.addProject("Burrow", rootB);
    store.updateProject(alpha.id, { status: "tracked" });
    store.updateProject(beta.id, { status: "tracked" });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2030, 0, 1));
    const tick = () => vi.setSystemTime(Date.now() + 60_000);
    let counter = 0;
    const finalize = (root: string, changedFiles: string[], extra: Record<string, unknown> = {}, advance = true) => {
      if (advance) tick();
      counter += 1;
      const result = store.finalizeSession({
        projectRoot: root,
        idempotencyKey: `eq-${counter}`,
        title: `Session ${counter}`,
        summary: `Summary ${counter}.`,
        workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
        changedFiles,
        verification: { status: "passed" },
        ...extra,
      });
      if (result.outcome !== "finalized") throw new Error("Expected finalize");
      return result;
    };
    const record = (root: string, appliesTo: string[], advance = true) => {
      if (advance) tick();
      counter += 1;
      const result = store.recordKnowledge({
        projectRoot: root,
        idempotencyKey: `eq-k-${counter}`,
        kind: "gotcha",
        title: `Hive ${counter}`,
        body: "Queen excluder must be checked first.",
        appliesTo,
      });
      if (result.outcome !== "knowledge_recorded") throw new Error("Expected Knowledge");
      return result.knowledge;
    };

    // Knowledge created before any Session (whole history), then Sessions that touch a variety of paths.
    const early = [
      record(rootA, ["src/hive/**"]),
      record(rootA, ["src/hive/*.ts", "docs/readme.md"]),
      record(rootA, ["src/hive/queen.ts"]),
      record(rootA, ["src/**/queen.ts"]),
      record(rootA, ["src/a?c.ts"]),
      record(rootA, ["queen.ts"]),
      record(rootA, ["src/hive"]),
      record(rootA, ["feature-*/index.ts", "src/feature-*/index.ts"]),
      record(rootA, [`${rootA}/src/hive/queen.ts`]),
      record(rootA, ["Apiary/src/drone/"]),
      record(rootA, ["SRC\\Hive\\Drone.ts"]),
      record(rootA, ["src/hive/queen.ts", "src/hive/queen.ts", "  "]),
      record(rootA, ["**"]),
      record(rootA, ["*.md"]),
      record(rootA, ["src/a.b.ts", "src/(x)+[y].ts"]),
      record(rootB, ["src/hive/**"]),
    ];
    const sameInstant = record(rootA, ["src/hive/**"], false);
    // Sessions completed at the very same instant as the Knowledge above must not count as "later".
    finalize(rootA, ["src/hive/same-instant.ts"], {}, false);

    const touching = finalize(rootA, [
      "src/hive/queen.ts",
      "SRC\\Hive\\Queen.ts",
      "./src/hive/drone.ts:12",
      "src/hive/worker.ts#L10-L20",
      "Apiary/src/hive/nurse.ts",
      `${rootA}/src/hive/guard.ts`,
      "src/hive/forager.ts",
      "src/hive/scout.ts",
      "docs/readme.md",
    ]);
    finalize(rootA, ["docs/README.md", "src/abc.ts", "src/a.b.ts", "src/(x)+[y].ts", "README.md"]);
    finalize(rootA, ["packages/core/src/hive/queen.ts", "feature-one/index.ts", "src/feature-two/index.ts"]);
    finalize(rootA, ["src/drone/a.ts", "src/drone/deep/b.ts", "src/hive.ts", "queen.ts", "src/queen.ts"]);
    finalize(rootA, ["src/hive/queen.ts"]);
    finalize(rootB, ["src/hive/queen.ts", "src/hive/other.ts"]);
    const voided = finalize(rootA, ["src/hive/voided-only.ts", "src/hive/queen.ts"]);
    finalize(rootA, ["src/hive/queen.ts"]);

    // Knowledge that excludes its own Session and a confirming Session, plus one created after some Sessions.
    const late = record(rootA, ["src/hive/**", "src/**/queen.ts"]);
    const own = finalize(rootA, ["src/hive/own.ts"], {});
    const owning = store.recordKnowledge({
      projectRoot: rootA,
      idempotencyKey: "eq-owning",
      kind: "gotcha",
      title: "Owning",
      body: "Created from a Session.",
      sessionId: own.session.id,
      appliesTo: ["src/hive/**"],
    });
    if (owning.outcome !== "knowledge_recorded") throw new Error("Expected Knowledge");
    const confirmed = early[0]!;
    finalize(rootA, ["src/hive/confirming.ts"], { appliedKnowledgeIds: [confirmed.id] });
    finalize(rootA, ["src/hive/after-confirm.ts", "src/drone/after.ts"]);
    finalize(rootA, ["src/hive/final.ts"], { appliedKnowledgeIds: [late.id] });
    finalize(rootA, ["src/hive/final-2.ts"]);

    const reader = new DatabaseSync(databasePath);
    try {
      reader
        .prepare("UPDATE sessions SET voided_at = ? WHERE id = ?")
        .run("2030-02-01T00:00:00.000Z", voided.session.id);
      for (const [project, root] of [
        [alpha, rootA],
        [beta, rootB],
      ] as const) {
        const rows = reader
          .prepare(
            "SELECT id, title, completed_at, changed_files_json FROM sessions WHERE project_id = ? AND voided_at IS NULL ORDER BY completed_at ASC, id ASC",
          )
          .all(project.id) as Array<{ id: string; title: string; completed_at: string; changed_files_json: string }>;
        const contexts = [{ name: project.name, rootPath: project.rootPath }];
        const sessions: OracleSession[] = rows.map((row) => ({
          id: row.id,
          title: row.title,
          completedAt: row.completed_at,
          files: (JSON.parse(row.changed_files_json) as string[]).map((raw) => ({
            raw,
            normalized: normalizePath(raw, contexts),
          })),
        }));
        const result = store.searchKnowledge({ projectRoot: root, status: "active", limit: 100 });
        if (result.outcome !== "knowledge") throw new Error("Expected Knowledge result");
        expect(result.items.length).toBeGreaterThan(0);
        let stale = 0;
        for (const item of result.items) {
          const expected = oracleStaleness(item, sessions, contexts);
          expect(item.possiblyStale, `${item.title} ${JSON.stringify(item.appliesTo)}`).toEqual(expected);
          if (expected) stale += 1;
        }
        expect(stale).toBeGreaterThan(0);
        // Spot checks that the synthetic data really exercises the interesting branches.
        const byId = new Map(result.items.map((item) => [item.id, item]));
        if (project.id === alpha.id) {
          expect(byId.get(sameInstant.id)?.possiblyStale?.sessionId).not.toBe(undefined);
          expect(byId.get(sameInstant.id)?.possiblyStale?.paths).not.toContain("src/hive/same-instant.ts");
          expect(byId.get(early[0]!.id)?.possiblyStale?.sessionId).not.toBe(touching.session.id);
          expect(byId.get(owning.knowledge.id)?.possiblyStale?.sessionId).not.toBe(own.session.id);
        }
      }
    } finally {
      reader.close();
    }
  });
});
