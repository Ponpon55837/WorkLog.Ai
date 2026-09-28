import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

  it("signals no evidence or only one common-word match as low evidence", () => {
    const missing = store.recall({ q: "interstellar quantum memory accelerator", projectRoot: root, limit: 5 });
    expect(missing).toMatchObject({ outcome: "recall", confidence: "none", hits: [] });

    for (let index = 0; index < 6; index += 1) {
      createSession(`quality-weak-saffron-${index}`, root, {
        title: `Saffron harvest note ${index}`,
        summary: `The saffron beds were checked during routine harvest note ${index}.`,
      });
    }
    const weak = store.recall({ q: "interstellar saffron", projectRoot: root, limit: 5 });
    expect(weak.outcome).toBe("recall");
    if (weak.outcome !== "recall") throw new Error("Expected synthetic recall for weak evidence.");
    expect(weak.confidence).toBe("low");
    expect(weak.hits.length).toBeGreaterThan(0);
    expect(weak.termHits?.find((entry) => entry.term === "saffron")?.count).toBe(6);

    const strong = store.recall({ q: "release candidate migration backup", projectRoot: root, limit: 5 });
    expect(strong.outcome).toBe("recall");
    if (strong.outcome !== "recall") throw new Error("Expected synthetic recall for strong evidence.");
    expect(strong.confidence).toBe("high");
    expect(strong.hits[0]?.id).toBe(expectedIds.get("s-migration-backup"));
  });

  it("keeps a query that is only quoted in raw planning notes at low confidence", () => {
    const quotedId = createSession("quality-quoted-query-plan", root, {
      title: "Retrieval test plan for the next round",
      summary: "The next round checks how recall behaves for queries with no recorded answer.",
      handoffContent: [
        "# Plan",
        "",
        "## Missing answers",
        "",
        "A made-up query such as heliotrope lattice defragmenter must not look like a confident answer.",
      ].join("\n"),
    });
    const quoted = store.recall({ q: "heliotrope lattice defragmenter", projectRoot: root, limit: 5 });
    expect(quoted.outcome).toBe("recall");
    if (quoted.outcome !== "recall") throw new Error("Expected synthetic recall for a quoted query.");
    expect(quoted.hits[0]?.id).toBe(quotedId);
    expect(quoted.hits[0]?.matchedIn).toEqual(["raw"]);
    expect(quoted.confidence).toBe("low");
  });

  it("makes a task miss explicit in relevant context", () => {
    const context = store.getContext(root, { task: "interstellar quantum memory accelerator" });
    expect(context.outcome).toBe("context");
    if (context.outcome !== "context") throw new Error("Expected synthetic task context.");
    expect(context.relevant).toMatchObject({ confidence: "none", knowledge: [], sessions: [] });
  });

  it("keeps the answer-bearing recall excerpt concise and preserves its source hit", () => {
    const targetId = createSession("quality-cobalt-pump-answer", root, {
      title: "Cobalt pump transfer repair record",
      summary:
        "Cobalt pump transfer repair: close the upstream valve, replace the blue gasket, and reopen at 40 kPa. " +
        "Unrelated field log details. ".repeat(24),
    });

    const recalled = store.recall({ q: "cobalt pump transfer", projectRoot: root, limit: 5 });
    if (recalled.outcome !== "recall") throw new Error("Expected synthetic recall for the cobalt pump answer.");
    const hit = recalled.hits[0];

    expect(hit?.id).toBe(targetId);
    expect(hit?.excerpt).toContain("replace the blue gasket");
    expect(hit?.excerpt.length).toBeLessThanOrEqual(112);
    expect(hit?.truncated).toBe(true);

    const searched = store.search("cobalt pump transfer", root);
    if (!Array.isArray(searched)) throw new Error("Expected synthetic Session search for the cobalt pump answer.");
    expect(searched[0]?.session.id).toBe(targetId);
    expect(searched[0]?.excerpt).toContain("replace the blue gasket");
  });

  it("ranks confirmed Knowledge above an equal match and a contradicted one below it (evidence strength)", () => {
    const recordTwin = (key: string) => {
      const result = store.recordKnowledge({
        projectRoot: root,
        idempotencyKey: key,
        kind: "gotcha",
        title: "Gotcha: kiln glaze crawling",
        body: "Wipe dust off bisque ware before glazing so the kiln glaze does not crawl.",
        tags: ["kiln", "glaze"],
      });
      if (result.outcome !== "knowledge_recorded") throw new Error(`Expected synthetic Knowledge ${key}.`);
      return result.knowledge.id;
    };
    const disputed = recordTwin("e-kiln-disputed");
    const neutral = recordTwin("e-kiln-neutral");
    const confirmed = recordTwin("e-kiln-confirmed");
    const feedbackSessions: Array<[string, { appliedKnowledgeIds?: string[]; contradictedKnowledgeIds?: string[] }]> = [
      ["e-kiln-applied-1", { appliedKnowledgeIds: [confirmed] }],
      ["e-kiln-applied-2", { appliedKnowledgeIds: [confirmed] }],
      ["e-kiln-contradicted", { contradictedKnowledgeIds: [disputed] }],
    ];
    for (const [key, feedback] of feedbackSessions) {
      const result = store.finalizeSession({
        projectRoot: root,
        idempotencyKey: key,
        title: "Studio maintenance",
        summary: "Routine studio upkeep.",
        workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
        changedFiles: [],
        verification: { status: "passed" },
        ...feedback,
      });
      if (result.outcome !== "finalized") throw new Error(`Expected synthetic feedback ${key}.`);
    }

    const result = store.recall({ q: "kiln glaze crawling", projectRoot: root, limit: 5 });
    const order = result.outcome === "recall" ? result.hits.map((hit) => hit.id) : [];
    expect(order.indexOf(confirmed)).toBe(0);
    expect(order.indexOf(neutral)).toBeLessThan(order.indexOf(disputed));
  });

  it("finds an older answer first when the query names its period (date range)", () => {
    const dated = (key: string, completedAt: string) => {
      const result = store.finalizeSession({
        projectRoot: root,
        idempotencyKey: key,
        title: "Greenhouse shade cloth replacement",
        summary: "Replaced the greenhouse shade cloth on the south wall.",
        workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
        changedFiles: [],
        verification: { status: "passed" },
        completedAt,
      });
      if (result.outcome !== "finalized") throw new Error(`Expected synthetic Session ${key}.`);
      return result.session.id;
    };
    const march = dated("d-shade-march", "2024-03-12T09:00:00.000Z");
    const recent = dated("d-shade-recent", new Date(Date.now() - 86_400_000).toISOString());

    const unranged = store.recall({ q: "greenhouse shade cloth", projectRoot: root, limit: 5 });
    expect(unranged.outcome === "recall" && unranged.hits[0]?.id).toBe(recent);
    const ranged = store.recall({
      q: "greenhouse shade cloth",
      projectRoot: root,
      from: "2024-03-01",
      to: "2024-03-31",
      limit: 5,
    });
    expect(ranged.outcome === "recall" && ranged.hits.map((hit) => hit.id)).toEqual([march]);
  });

  it("ranks completed REST and FTS fixes above duplicated old planning snippets", () => {
    const plan = [
      "# Round handoff",
      "## Deferred implementation plan",
      "新增 REST endpoint 的慣例：每次新增 REST endpoint，都先確認 REST endpoint 路由慣例，再更新 domain route table。",
      "FTS 效能問題：FTS 效能問題來自重複掃描，記錄 FTS 效能問題並規劃 CROSS JOIN 修正。",
    ].join("\n");
    for (let index = 0; index < 8; index += 1) {
      createSession(`b2-old-plan-${index}`, root, {
        title: `Imported planning handoff ${index}`,
        summary: "Carried forward an earlier project plan.",
        handoffContent: plan,
      });
    }

    const routes = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "b2-completed-rest-route-split",
      title: "Split REST endpoint dispatch into domain route tables",
      summary: "Added table-driven registration for new endpoint handlers and a centralized route manifest.",
      workSummary: {
        outcomes: ["新增 REST endpoint 的慣例已落實：domain route table 只需新增一個 typed entry."],
        scope: ["Moved route dispatch from server.ts into domain route modules."],
        decisions: [],
        verification: ["Route manifest and server route tests passed."],
        nextSteps: [],
      },
      changedFiles: ["apps/server/src/routes/index.ts"],
      verification: { status: "passed" },
    });
    if (routes.outcome !== "finalized") throw new Error("Expected the completed REST route Session.");

    const fts = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "b2-completed-fts-fix",
      title: "Fix FTS query plan repeated scans",
      summary: "Pinned the full-text scan as the outer loop with CROSS JOIN to resolve repeated query work.",
      workSummary: {
        outcomes: ["FTS 效能問題已修正：固定全文索引作為外層查詢，避免重複掃描."],
        scope: ["Changed the search query join order."],
        decisions: [],
        verification: ["The 5,000-Session search performance gate passed."],
        nextSteps: [],
      },
      changedFiles: ["packages/storage/src/search-repository.ts"],
      verification: { status: "passed" },
    });
    if (fts.outcome !== "finalized") throw new Error("Expected the completed FTS fix Session.");

    const routeRecall = store.recall({ q: "新增 REST endpoint 的慣例", projectRoot: root, limit: 20 });
    const ftsRecall = store.recall({ q: "FTS 效能問題", projectRoot: root, limit: 20 });
    expect(routeRecall.outcome).toBe("recall");
    expect(ftsRecall.outcome).toBe("recall");
    if (routeRecall.outcome !== "recall" || ftsRecall.outcome !== "recall") {
      throw new Error("Expected the B2 synthetic recall queries to complete.");
    }
    expect(routeRecall.hits[0]?.id).toBe(routes.session.id);
    expect(ftsRecall.hits[0]?.id).toBe(fts.session.id);
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

  it("puts task-matched sources and cited page sections first without repeating their primary content", () => {
    const session = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "context-sapphire-retry",
      title: "Verified sapphire retrieval capsule fix",
      summary:
        "The verified sapphire retrieval capsule fix keeps the retry window stable. It preserves the source decision.",
      workSummary: {
        outcomes: ["The sapphire retrieval capsule retry now stays stable."],
        scope: [],
        decisions: ["Keep the verified sapphire retrieval capsule retry window stable."],
        verification: [],
        nextSteps: ["Confirm the sapphire retry window against one production trace."],
      },
      changedFiles: ["packages/storage/src/sapphire-retrieval.ts"],
      verification: { status: "passed" },
    });
    if (session.outcome !== "finalized") throw new Error("Expected the synthetic task Session to finalize.");

    const knowledge = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: "context-sapphire-knowledge",
      kind: "gotcha",
      title: "Sapphire retrieval capsule retry gotcha",
      body: "Keep the retry window stable after a sapphire retrieval capsule timeout.",
      tags: ["sapphire", "retrieval", "capsule"],
    });
    if (knowledge.outcome !== "knowledge_recorded") throw new Error("Expected synthetic task Knowledge to record.");

    store.requestKnowledgePageUpdate({ projectRoot: root, slug: "architecture" });
    const page = store.saveKnowledgePage({
      projectRoot: root,
      slug: "architecture",
      idempotencyKey: "context-sapphire-page",
      sections: [
        {
          heading: "Sapphire retrieval capsule",
          content: "Keep the verified retry window stable. Preserve the source decision.",
          sourceSessionIds: [session.session.id],
        },
        {
          heading: "Rainwater storage",
          content: "Keep the orchard cistern covered through winter.",
          sourceSessionIds: [session.session.id],
        },
      ],
    });
    if (page.outcome !== "knowledge_page_saved") throw new Error("Expected the synthetic cited page to save.");

    const context = store.getContext(root, { task: "sapphire retrieval capsule" });
    if (context.outcome !== "context") throw new Error("Expected task context.");

    expect(context.relevant?.sessions[0]?.id).toBe(session.session.id);
    expect(context.relevant?.knowledge[0]?.id).toBe(knowledge.knowledge.id);
    expect(context.relevant?.decisions).toContainEqual(
      expect.objectContaining({
        sessionId: session.session.id,
        text: expect.stringContaining("sapphire retrieval capsule"),
      }),
    );
    expect(context.relevant?.knowledgePages).toEqual([
      expect.objectContaining({
        slug: "architecture",
        sections: [
          expect.objectContaining({
            heading: "Sapphire retrieval capsule",
            sourceSessionIds: [session.session.id],
          }),
        ],
      }),
    ]);
    expect(context.recentSessions.some((item) => item.id === session.session.id)).toBe(false);
    expect(context.recentKnowledge.some((item) => item.id === knowledge.knowledge.id)).toBe(false);
    expect(context.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ section: "recentSessions", readWith: "work_get_session", duplicates: 1 }),
        expect.objectContaining({ section: "recentKnowledge", readWith: "work_search_knowledge", duplicates: 1 }),
        expect.objectContaining({
          section: "knowledgePages",
          readWith: "work_get_knowledge_page_context",
          duplicates: 1,
        }),
      ]),
    );
  });

  it("surfaces cited Knowledge page sections when a source Session changes after the page was saved", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.UTC(2030, 0, 1));
      const sourceSessionId = createSession("c1-source-corrected", root, {
        title: "Verified lantern relay correction",
        summary: "The verified lantern relay uses the confirmed calibration window.",
      });
      store.requestKnowledgePageUpdate({
        projectRoot: root,
        slug: "source-review",
        title: "來源核對",
        question: "這些來源仍然可靠嗎？",
      });
      vi.setSystemTime(Date.now() + 60_000);
      const saved = store.saveKnowledgePage({
        projectRoot: root,
        slug: "source-review",
        idempotencyKey: "c1-source-review-save",
        sections: [
          {
            heading: "Lantern relay calibration",
            content: "Use the verified lantern relay calibration window.",
            sourceSessionIds: [sourceSessionId],
          },
          { heading: "Unrelated note", content: "資料不足", sourceSessionIds: [] },
        ],
      });
      if (saved.outcome !== "knowledge_page_saved") throw new Error("Expected the cited Knowledge page to save.");

      vi.setSystemTime(Date.now() + 60_000);
      store.updateSessionSummary({
        sessionId: sourceSessionId,
        idempotencyKey: "c1-source-review-corrected-summary",
        summary: "Corrected: the verified lantern relay uses a new calibration window.",
      });

      const context = store.getContext(root);
      if (context.outcome !== "context") throw new Error("Expected project context.");
      expect(context.knowledgePages).toContainEqual(
        expect.objectContaining({
          slug: "source-review",
          needsReview: true,
          reviewSections: [
            {
              heading: "Lantern relay calibration",
              sources: [
                {
                  sourceSessionId,
                  title: "Verified lantern relay correction",
                  reasons: ["source_updated_after_save"],
                },
              ],
            },
          ],
        }),
      );
      expect(context.pendingRequests.knowledgePages).toContainEqual(
        expect.objectContaining({ slug: "source-review", needsReview: true }),
      );
      const pageContext = store.getKnowledgePageContext({ projectRoot: root, slug: "source-review" });
      expect(pageContext).toMatchObject({
        outcome: "knowledge_page_context",
        page: {
          needsReview: true,
          reviewSections: [
            expect.objectContaining({
              heading: "Lantern relay calibration",
              sources: [expect.objectContaining({ sourceSessionId, reasons: ["source_updated_after_save"] })],
            }),
          ],
        },
      });

      const taskContext = store.getContext(root, { task: "lantern relay calibration" });
      expect(taskContext).toMatchObject({
        outcome: "context",
        relevant: {
          knowledgePages: [
            expect.objectContaining({
              slug: "source-review",
              needsReview: true,
              sections: [
                expect.objectContaining({
                  heading: "Lantern relay calibration",
                  reviewSources: [expect.objectContaining({ sourceSessionId, reasons: ["source_updated_after_save"] })],
                }),
              ],
            }),
          ],
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds cited-source IDs in context summaries while retaining omitted counts for full-page lookup", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2031, 0, 1));
    try {
      const sourceSessionIds = Array.from({ length: 20 }, (_, index) =>
        createSession(`c1-source-list-${index}`, root, {
          title: `C1 synthetic cited source ${index}`,
          summary: `C1 source list audit supports the verified rule ${index}.`,
        }),
      );
      store.requestKnowledgePageUpdate({
        projectRoot: root,
        slug: "source-list-audit",
        title: "Source list audit",
        question: "Which Kestrel citations changed?",
      });
      const saved = store.saveKnowledgePage({
        projectRoot: root,
        slug: "source-list-audit",
        idempotencyKey: "c1-source-list-save",
        sections: [
          {
            heading: "Kestrel source list audit",
            content: "Keep the Kestrel source list available.",
            sourceSessionIds,
          },
        ],
      });
      if (saved.outcome !== "knowledge_page_saved") throw new Error("Expected the source-list page to save.");

      for (const [index, sessionId] of sourceSessionIds.entries()) {
        vi.setSystemTime(Date.now() + 60_000);
        store.updateSessionSummary({
          sessionId,
          idempotencyKey: `c1-source-list-correction-${index}`,
          summary: `Corrected C1 source list audit detail ${index}.`,
        });
      }

      const context = store.getContext(root);
      if (context.outcome !== "context") throw new Error("Expected project context.");
      expect(context.knowledgePages).toContainEqual(
        expect.objectContaining({
          slug: "source-list-audit",
          needsReview: true,
          sourceSessionIds: expect.arrayContaining(sourceSessionIds.slice(0, 7)),
          sourceSessionIdsOmittedCount: 13,
          reviewSections: [expect.objectContaining({ omittedSourceCount: 13, reasons: ["source_updated_after_save"] })],
        }),
      );

      const taskContext = store.getContext(root, { task: "Kestrel" });
      expect(taskContext).toMatchObject({
        outcome: "context",
        relevant: {
          knowledgePages: [
            expect.objectContaining({
              slug: "source-list-audit",
              needsReview: true,
              sections: [expect.objectContaining({ sourceSessionIdsOmittedCount: 12, reviewOmittedSourceCount: 12 })],
            }),
          ],
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats later Sessions as new data that an Agent can check without creating a new page version", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2032, 0, 1));
    try {
      const sourceSessionId = createSession("c2-page-write-session", root, {
        title: "This Session records the page update",
        summary: "The page update itself is recorded here and cited as its source.",
      });
      store.requestKnowledgePageUpdate({
        projectRoot: root,
        slug: "review-checkpoint",
        title: "Review checkpoint",
        question: "What new data has been assessed?",
      });
      const saved = store.saveKnowledgePage({
        projectRoot: root,
        slug: "review-checkpoint",
        idempotencyKey: "c2-page-write-save",
        sections: [
          { heading: "Checkpoint", content: "The checkpoint source is recorded.", sourceSessionIds: [sourceSessionId] },
        ],
      });
      if (saved.outcome !== "knowledge_page_saved") throw new Error("Expected the checkpoint page to save.");
      expect(saved.page).toMatchObject({ version: 1, status: "fresh", newSessionCount: 0 });

      vi.setSystemTime(Date.now() + 60_000);
      const newSessionId = createSession("c2-new-session-after-save", root, {
        title: "Independent orchard note",
        summary: "This Session adds unrelated orchard information.",
      });
      const context = store.getContext(root);
      if (context.outcome !== "context") throw new Error("Expected project context.");
      expect(context.pendingRequests.knowledgePages).toContainEqual(
        expect.objectContaining({
          slug: "review-checkpoint",
          status: "has_new_data",
          newSessionCount: 1,
          updateRequested: false,
        }),
      );
      const focused = store.getContext(root, { task: "checkpoint" });
      expect(focused).toMatchObject({
        outcome: "context",
        relevant: {
          knowledgePages: [
            expect.objectContaining({ slug: "review-checkpoint", status: "has_new_data", newSessionCount: 1 }),
          ],
        },
      });

      const checked = store.markKnowledgePageChecked({
        projectRoot: root,
        slug: "review-checkpoint",
        throughSessionId: newSessionId,
      });
      expect(checked).toMatchObject({
        outcome: "knowledge_page_checked",
        page: {
          version: 1,
          status: "fresh",
          newSessionCount: 0,
          checkedThrough: { sessionId: newSessionId },
        },
      });
      store.requestKnowledgePageUpdate({ projectRoot: root, slug: "review-checkpoint" });
      const requestedAfterCheck = store.markKnowledgePageChecked({
        projectRoot: root,
        slug: "review-checkpoint",
        throughSessionId: newSessionId,
      });
      expect(requestedAfterCheck).toMatchObject({
        outcome: "knowledge_page_checked",
        page: { version: 1, status: "fresh", updateRequestedAt: expect.any(String) },
      });

      vi.setSystemTime(Date.now() + 60_000);
      createSession("c2-session-after-check", root, {
        title: "Later unrelated orchard note",
        summary: "A later Session remains visible as new data.",
      });
      const later = store.listKnowledgePages({ projectRoot: root });
      expect(later.outcome).toBe("knowledge_pages");
      if (later.outcome !== "knowledge_pages") throw new Error("Expected the page list.");
      expect(later.items.find((page) => page.slug === "review-checkpoint")).toMatchObject({
        version: 1,
        status: "has_new_data",
        newSessionCount: 1,
        checkedThrough: { sessionId: newSessionId },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
