import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

type Category = "K" | "S" | "R" | "N" | "P";

interface KnowledgeFixture {
  type: "knowledge";
  kind: "gotcha" | "pattern";
  title: string;
  body: string;
  tags: string[];
}

interface SessionFixture {
  type: "session";
  title: string;
  summary: string;
  handoffContent?: string;
  changedFiles?: string[];
}

interface EvaluationCase {
  key: string;
  category: Category;
  query: { q: string } | { paths: string[] };
  target: KnowledgeFixture | SessionFixture;
  nearMiss: Omit<SessionFixture, "type">;
}

// Fictional examples only. The private 36-question evaluation and its source data are not included.
const evaluationCases: EvaluationCase[] = [
  {
    key: "k-orchard-frost",
    category: "K",
    query: { q: "orchard frost pruning" },
    target: {
      type: "knowledge",
      kind: "gotcha",
      title: "Gotcha: orchard frost pruning",
      body: "Delay orchard pruning until frost damage is visible on each branch.",
      tags: ["orchard", "frost", "pruning"],
    },
    nearMiss: { title: "Orchard frost watch", summary: "Record overnight temperatures before spring work." },
  },
  {
    key: "k-beehive-brood",
    category: "K",
    query: { q: "beehive brood spacing" },
    target: {
      type: "knowledge",
      kind: "pattern",
      title: "Pattern: beehive brood spacing",
      body: "Leave one empty frame between brood areas when combining two small colonies.",
      tags: ["beehive", "brood", "spacing"],
    },
    nearMiss: { title: "Beehive brood calendar", summary: "Schedule inspections after a warm afternoon." },
  },
  {
    key: "k-chinese-irrigation",
    category: "K",
    query: { q: "果園滴灌漏水" },
    target: {
      type: "knowledge",
      kind: "gotcha",
      title: "Gotcha：果園滴灌漏水檢查",
      body: "果園滴灌接頭漏水時，先關閉分區閥門再更換墊圈。",
      tags: ["果園", "滴灌", "漏水"],
    },
    nearMiss: { title: "果園滴灌巡檢", summary: "每週記錄水壓與土壤濕度。" },
  },
  {
    key: "k-cache-lock",
    category: "K",
    query: { q: "cache stampede lock" },
    target: {
      type: "knowledge",
      kind: "pattern",
      title: "Pattern: cache stampede lock",
      body: "Use a per-key lock so only one worker refreshes an expired cache entry.",
      tags: ["cache", "stampede", "lock"],
    },
    nearMiss: { title: "Cache warming guide", summary: "Warm popular keys before the traffic peak." },
  },
  {
    key: "s-migration-backup",
    category: "S",
    query: { q: "release candidate migration backup" },
    target: {
      type: "session",
      title: "Release candidate schema migration backup checklist",
      summary: "The rehearsal verified a backup before applying the candidate migration.",
    },
    nearMiss: { title: "Migration inventory", summary: "A short list of pending schema changes." },
  },
  {
    key: "s-harvest-import",
    category: "S",
    query: { q: "duplicate harvest import retry" },
    target: {
      type: "session",
      title: "Retry duplicate harvest import batches",
      summary: "The import retry became idempotent after duplicate batch detection.",
    },
    nearMiss: { title: "Harvest import notes", summary: "Review the seasonal source file format." },
  },
  {
    key: "s-future-schema",
    category: "S",
    query: { q: "future schema version reject" },
    target: {
      type: "session",
      title: "Reject a future schema version safely",
      summary: "A database from a newer schema version now returns a classified error.",
    },
    nearMiss: { title: "Schema version report", summary: "Summarize migration versions for a release." },
  },
  {
    key: "s-firefox-health",
    category: "S",
    query: { q: "firefox health route same origin" },
    target: {
      type: "session",
      title: "Firefox health route same-origin smoke test",
      summary: "The browser checked the health route through the production web server.",
    },
    nearMiss: { title: "Firefox browser notes", summary: "Record the supported browser version." },
  },
  {
    key: "r-copper-lantern",
    category: "R",
    query: { q: "copper lantern lease drift" },
    target: {
      type: "session",
      title: "Imported handoff R1",
      summary: "Imported historical handoff notes.",
      handoffContent:
        "# Fictional incident\n## Copper lantern relay\nThe copper lantern lease drifted because its renewal clock used a local timezone.",
    },
    nearMiss: { title: "Copper lantern lease monitor", summary: "A dashboard shows the latest lease heartbeat." },
  },
  {
    key: "r-quartz-relay",
    category: "R",
    query: { q: "quartz relay retry interval" },
    target: {
      type: "session",
      title: "Imported handoff R2",
      summary: "Imported historical handoff notes.",
      handoffContent:
        "# Fictional incident\n## Quartz relay recovery\nThe quartz relay retry interval doubled after three consecutive timeouts.",
    },
    nearMiss: { title: "Quartz relay status", summary: "The relay is monitored every minute." },
  },
  {
    key: "r-midnight-invoice",
    category: "R",
    query: { q: "midnight invoice offset" },
    target: {
      type: "session",
      title: "Imported handoff R3",
      summary: "Imported historical handoff notes.",
      handoffContent:
        "# Fictional incident\n## Invoice export\nThe midnight invoice offset came from a daylight-saving boundary in the export window.",
    },
    nearMiss: { title: "Midnight invoice ledger", summary: "The ledger closes at midnight each day." },
  },
  {
    key: "r-wal-checkpoint",
    category: "R",
    query: { q: "wal checkpoint stalled writer" },
    target: {
      type: "session",
      title: "Imported handoff R4",
      summary: "Imported historical handoff notes.",
      handoffContent:
        "# Fictional incident\n## Storage pressure\nA stalled writer prevented the WAL checkpoint from completing until the reader closed.",
    },
    nearMiss: { title: "WAL checkpoint report", summary: "A routine checkpoint completed after compaction." },
  },
  {
    key: "n-worker-clock",
    category: "N",
    query: { q: "Why did the worker queue repeat after clock change?" },
    target: {
      type: "session",
      title: "Worker queue duplicate execution",
      summary: "A clock change caused the worker queue to repeat the scheduled job.",
    },
    nearMiss: { title: "Worker queue dashboard", summary: "The queue depth graph updates each minute." },
  },
  {
    key: "n-harvest-rollover",
    category: "N",
    query: { q: "How can harvest report skip month when crossing year?" },
    target: {
      type: "session",
      title: "Harvest report year rollover",
      summary: "When crossing a year boundary, the harvest report can skip a month.",
    },
    nearMiss: { title: "Harvest report styling", summary: "Adjust the table headings and print margins." },
  },
  {
    key: "n-chinese-backup",
    category: "N",
    query: { q: "為什麼夜間排程在停電後漏掉備份？" },
    target: {
      type: "session",
      title: "夜間排程備份修正",
      summary: "停電後夜間排程漏掉備份，因為恢復程序沒有重新建立計時器。",
    },
    nearMiss: { title: "夜間排程狀態", summary: "狀態頁每分鐘更新一次。" },
  },
  {
    key: "n-deploy-key",
    category: "N",
    query: { q: "Can deploy key rotation avoid a server restart?" },
    target: {
      type: "session",
      title: "Hot reload deployment credentials",
      summary: "Deploy key rotation is hot-reloaded, so the server restart is unnecessary.",
    },
    nearMiss: { title: "Deployment key checklist", summary: "Review key ownership before the release." },
  },
  {
    key: "p-backup-rotation",
    category: "P",
    query: { paths: ["@ROOT@/apps/server/src/backup/rotation.ts"] },
    target: {
      type: "session",
      title: "Synthetic path change P1",
      summary: "Updated one fictional source file.",
      changedFiles: ["apps/server/src/backup/rotation.ts"],
    },
    nearMiss: {
      title: "Backup rotation test file",
      summary: "Updated a neighboring fixture.",
      changedFiles: ["tests/server/src/backup/rotation.ts"],
    },
  },
  {
    key: "p-router-absolute",
    category: "P",
    query: { paths: ["@ROOT@/apps/web/src/router.ts"] },
    target: {
      type: "session",
      title: "Synthetic path change P2",
      summary: "Updated one fictional source file.",
      changedFiles: ["apps/web/src/router.ts"],
    },
    nearMiss: {
      title: "Router test fixture",
      summary: "Updated a neighboring fixture.",
      changedFiles: ["tests/web/src/router.ts"],
    },
  },
  {
    key: "p-search-repository",
    category: "P",
    query: { paths: ["Fictional Grove/packages/storage/src/search-repository.ts"] },
    target: {
      type: "session",
      title: "Synthetic path change P3",
      summary: "Updated one fictional source file.",
      changedFiles: ["packages/storage/src/search-repository.ts"],
    },
    nearMiss: {
      title: "Core search fixture",
      summary: "Updated a neighboring module.",
      changedFiles: ["packages/core/src/search-repository.ts"],
    },
  },
  {
    key: "p-mcp-recall",
    category: "P",
    query: { paths: [".\\apps\\mcp\\src\\tools\\recall.ts"] },
    target: {
      type: "session",
      title: "Synthetic path change P4",
      summary: "Updated one fictional source file.",
      changedFiles: ["apps/mcp/src/tools/recall.ts"],
    },
    nearMiss: {
      title: "Server recall fixture",
      summary: "Updated a neighboring module.",
      changedFiles: ["apps/server/src/tools/recall.ts"],
    },
  },
];

const categories: Category[] = ["K", "S", "R", "N", "P"];
const expectedIds = new Map<string, string>();
const tempDirs: string[] = [];
let store: WorkIntelligenceStore;
let root: string;
let measured: Array<{ category: Category; rank: number }> = [];

function createSession(key: string, rootPath: string, fixture: Omit<SessionFixture, "type">): string {
  const result = store.finalizeSession({
    projectRoot: rootPath,
    idempotencyKey: key,
    title: fixture.title,
    summary: fixture.summary,
    workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
    changedFiles: fixture.changedFiles ?? [],
    handoffContent: fixture.handoffContent,
    verification: { status: "passed" },
  });
  if (result.outcome !== "finalized") {
    throw new Error(`Expected synthetic fixture ${key} to finalize; got ${result.outcome}.`);
  }
  return result.session.id;
}

function measure(): Array<{ category: Category; rank: number }> {
  return evaluationCases.map((evaluationCase) => {
    const query =
      "q" in evaluationCase.query
        ? { q: evaluationCase.query.q }
        : {
            paths: evaluationCase.query.paths.map((path) => path.replaceAll("@ROOT@", root)),
          };
    const result = store.recall({ ...query, projectRoot: root, limit: 5 });
    if (result.outcome !== "recall") {
      throw new Error(`Expected synthetic recall for ${evaluationCase.key}; got ${result.outcome}.`);
    }
    const rank = result.hits.findIndex((hit) => hit.id === expectedIds.get(evaluationCase.key)) + 1;
    return { category: evaluationCase.category, rank };
  });
}

function summarize(rows: Array<{ category: Category; rank: number }>) {
  return Object.fromEntries(
    categories.map((category) => {
      const subset = rows.filter((row) => row.category === category);
      const hits = subset.filter((row) => row.rank > 0 && row.rank <= 5);
      return [
        category,
        {
          count: subset.length,
          hitAt5: hits.length / subset.length,
          mrr: subset.reduce((sum, row) => sum + (row.rank > 0 ? 1 / row.rank : 0), 0) / subset.length,
        },
      ];
    }),
  ) as Record<Category, { count: number; hitAt5: number; mrr: number }>;
}

describe("synthetic retrieval quality regression", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "work-intelligence-retrieval-eval-"));
    tempDirs.push(root);
    store = new WorkIntelligenceStore(":memory:");
    const project = store.addProject("Fictional Grove", root);
    store.updateProject(project.id, { status: "tracked" });

    for (const evaluationCase of evaluationCases) {
      if (evaluationCase.target.type === "knowledge") {
        const fixture = evaluationCase.target;
        const result = store.recordKnowledge({
          projectRoot: root,
          idempotencyKey: evaluationCase.key,
          kind: fixture.kind,
          title: fixture.title,
          body: fixture.body,
          tags: fixture.tags,
        });
        if (result.outcome !== "knowledge_recorded") {
          throw new Error(`Expected synthetic Knowledge ${evaluationCase.key}; got ${result.outcome}.`);
        }
        expectedIds.set(evaluationCase.key, result.knowledge.id);
      } else {
        const fixture: Omit<SessionFixture, "type"> = {
          title: evaluationCase.target.title,
          summary: evaluationCase.target.summary,
          ...(evaluationCase.target.handoffContent ? { handoffContent: evaluationCase.target.handoffContent } : {}),
          ...(evaluationCase.target.changedFiles ? { changedFiles: evaluationCase.target.changedFiles } : {}),
        };
        expectedIds.set(evaluationCase.key, createSession(evaluationCase.key, root, fixture));
      }
      createSession(`${evaluationCase.key}-near-miss`, root, evaluationCase.nearMiss);
    }

    measured = measure();
    const metrics = summarize(measured);
    console.info(
      `Synthetic retrieval quality: ${categories
        .map(
          (category) =>
            `${category} hit@5=${metrics[category].hitAt5.toFixed(2)} MRR=${metrics[category].mrr.toFixed(2)}`,
        )
        .join("; ")}`,
    );
  });

  afterAll(() => {
    store?.close();
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("meets the overall hit@5 and MRR gates across 20 fictional queries", () => {
    expect(evaluationCases).toHaveLength(20);
    const metrics = summarize(measured);
    const allRows = measured;
    const overallHitAt5 = allRows.filter((row) => row.rank > 0 && row.rank <= 5).length / allRows.length;
    const overallMrr = allRows.reduce((sum, row) => sum + (row.rank > 0 ? 1 / row.rank : 0), 0) / allRows.length;

    expect(overallHitAt5).toBeGreaterThanOrEqual(0.95);
    expect(overallMrr).toBeGreaterThanOrEqual(0.9);
    expect(Object.keys(metrics)).toEqual(categories);
  });

  it.each(categories)("category %s meets its retrieval floor", (category) => {
    const metric = summarize(measured)[category];
    expect(metric.count).toBe(4);
    expect(metric.hitAt5).toBeGreaterThanOrEqual(0.75);
    // Raw-only answers use the deliberately lower-weight raw field and rank behind a close title match.
    expect(metric.mrr).toBeGreaterThanOrEqual(category === "R" ? 0.5 : 0.7);
  });

  it("keeps the R answers exclusive to the fictional raw handoff snapshots", () => {
    const rawCases = evaluationCases.filter((evaluationCase) => evaluationCase.category === "R");
    expect(rawCases).toHaveLength(4);
    for (const evaluationCase of rawCases) {
      expect(evaluationCase.target.type).toBe("session");
      if (evaluationCase.target.type !== "session") {
        continue;
      }
      expect(evaluationCase.target.title).toMatch(/^Imported handoff/);
      expect(evaluationCase.target.summary).toBe("Imported historical handoff notes.");
      expect(evaluationCase.target.handoffContent).toBeTruthy();
    }
  });
});
