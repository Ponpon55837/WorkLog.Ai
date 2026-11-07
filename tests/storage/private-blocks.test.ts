import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { redactDatabase } from "../../packages/storage/src/database-redaction.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

const SECRET = "zephyrquill";
const PRIVATE = `<private>${SECRET} plan</private>`;

const tempDirs: string[] = [];
const stores: WorkIntelligenceStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createFileStore(): { store: WorkIntelligenceStore; directory: string; databasePath: string; root: string } {
  const directory = mkdtempSync(join(tmpdir(), "work-intelligence-private-"));
  tempDirs.push(directory);
  const root = join(directory, "project");
  mkdirSync(root);
  const databasePath = join(directory, "test.sqlite");
  const store = new WorkIntelligenceStore(databasePath);
  stores.push(store);
  return { store, directory, databasePath, root };
}

function searchChunkHits(databasePath: string): number {
  const read = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return (
      read.prepare("SELECT COUNT(*) AS count FROM search_chunks WHERE content LIKE ?").get(`%${SECRET}%`) as {
        count: number;
      }
    ).count;
  } finally {
    read.close();
  }
}

describe("private blocks", () => {
  it("never stores a private block from any write and reports only counts", () => {
    const { store, databasePath, root } = createFileStore();
    const project = store.addProject("Private block fixture", root);
    store.updateProject(project.id, { status: "tracked" });

    const finalized = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "private-finalize",
      title: "Private block Session",
      summary: `Shipped the parser. ${PRIVATE}`,
      workSummary: {
        outcomes: [`Parser ready ${PRIVATE}`],
        scope: [],
        decisions: [`Keep scanning linear ${PRIVATE}`],
        verification: [],
        nextSteps: [`Ship release ${PRIVATE}`],
      },
      events: [{ type: "execution", summary: `Ran tests ${PRIVATE}`, details: { note: PRIVATE } }],
      handoffContent: `# Handoff\n${PRIVATE}\nVisible tail`,
    });
    if (finalized.outcome !== "finalized") throw new Error("Expected a finalized Session.");
    expect(finalized.redactions).toEqual({ total: 7, byKind: { private_block: 7 } });
    expect(JSON.stringify(finalized)).not.toContain(SECRET);

    const evidence = store.attachEvidence({
      sessionId: finalized.session.id,
      kind: "test",
      reference: "tests/parser.test.ts",
      summary: `Passed ${PRIVATE}`,
    });
    expect(evidence).toMatchObject({ redactions: { total: 1, byKind: { private_block: 1 } } });
    const knowledge = store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: "private-knowledge",
      kind: "procedure",
      title: "Parser procedure",
      body: `Run the parser. ${PRIVATE}`,
      sessionId: finalized.session.id,
    });
    expect(JSON.stringify(knowledge)).not.toContain(SECRET);
    const page = store.requestKnowledgePageUpdate({
      projectRoot: root,
      slug: "private-page",
      title: `Parser page ${PRIVATE}`,
      question: `How does it work? ${PRIVATE}`,
    });
    expect(page).toMatchObject({ redactions: { total: 2, byKind: { private_block: 2 } } });

    const detail = store.getSessionDetailForAgent({ sessionId: finalized.session.id, includeRawSnapshots: true });
    expect(JSON.stringify(detail)).toContain("[REDACTED:private_block]");
    expect(JSON.stringify(detail)).toContain("Visible tail");
    expect(JSON.stringify(detail)).not.toContain(SECRET);
    expect(store.recall({ q: SECRET, projectRoot: root })).toMatchObject({ outcome: "recall", hits: [] });
    const recall = store.recall({ q: "parser", projectRoot: root });
    expect(recall.outcome === "recall" ? recall.hits.length : 0).toBeGreaterThan(0);
    expect(JSON.stringify(recall)).not.toContain(SECRET);
    expect(JSON.stringify(store.searchForAgent("parser", root))).not.toContain(SECRET);
    expect(searchChunkHits(databasePath)).toBe(0);
    expect(JSON.stringify(store.exportProjectData({ type: "project", projectId: project.id }))).not.toContain(SECRET);
  });

  it("masks private blocks that already exist in a database through db:redact", () => {
    const { store, directory, databasePath, root } = createFileStore();
    const project = store.addProject("Legacy private fixture", root);
    store.updateProject(project.id, { status: "tracked" });
    const finalized = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "private-legacy",
      title: "Legacy Session",
      summary: "Safe summary",
      workSummary: { outcomes: ["Safe outcome"], scope: [], decisions: [], verification: [], nextSteps: [] },
    });
    if (finalized.outcome !== "finalized") throw new Error("Expected a finalized Session.");
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const seed = new DatabaseSync(databasePath);
    try {
      seed.prepare("UPDATE sessions SET title = ?, summary = ?, work_summary_json = ? WHERE id = ?").run(
        "1.6.9：<private> 不保存標記",
        `Legacy ${PRIVATE}`,
        JSON.stringify({
          outcomes: [`Hidden <private>${SECRET}</private> done`, "1.6.9：<private> 不保存標記", "Later outcome stays"],
          scope: [],
          decisions: [],
          verification: [],
          nextSteps: [],
        }),
        finalized.session.id,
      );
    } finally {
      seed.close();
    }

    expect(redactDatabase({ databasePath }).redactions).toEqual({ total: 2, byKind: { private_block: 2 } });
    const applied = redactDatabase({ databasePath, apply: true, backup: { directory: join(directory, "backups") } });
    expect(applied).toMatchObject({ affectedSessions: 1, redactions: { total: 2, byKind: { private_block: 2 } } });

    const verify = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = verify
        .prepare("SELECT title, summary, work_summary_json FROM sessions WHERE id = ?")
        .get(finalized.session.id) as { title: string; summary: string; work_summary_json: string };
      expect(row.title).toBe("1.6.9：<private> 不保存標記");
      expect(row.summary).toBe("Legacy [REDACTED:private_block]");
      expect(JSON.parse(row.work_summary_json).outcomes).toEqual([
        "Hidden [REDACTED:private_block] done",
        "1.6.9：<private> 不保存標記",
        "Later outcome stays",
      ]);
    } finally {
      verify.close();
    }
  });

  it("removes a private block that straddles the handoff length cut before cutting", () => {
    const { store, root } = createFileStore();
    const project = store.addProject("Handoff cut fixture", root);
    store.updateProject(project.id, { status: "tracked" });
    const handoffDirectory = join(root, ".openspec", "handoffs");
    mkdirSync(handoffDirectory, { recursive: true });
    const header = "# Straddling handoff\n\nRecorded date: 2026-09-17\nStatus: complete\n\nImplemented the parser.\n\n";
    // The block opens 30 characters before the 200,000-character cut and closes after it.
    const filler = "filler line\n".repeat(Math.ceil(200_000 / 12)).slice(0, 200_000 - header.length - 30);
    const straddling = `${header}${filler}<private>${SECRET} ${"y".repeat(100)}</private> after`;
    writeFileSync(join(handoffDirectory, "straddling.md"), straddling, "utf8");

    const captured = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "private-handoff-path",
      title: "Captured handoff",
      summary: "Read from the handoff path",
      handoffPath: ".openspec/handoffs/straddling.md",
    });
    if (captured.outcome !== "finalized") throw new Error("Expected a finalized Session.");
    expect(captured.redactions).toEqual({ total: 1, byKind: { private_block: 1 } });
    const capturedDetail = store.getSessionDetailForAgent({
      sessionId: captured.session.id,
      includeRawSnapshots: true,
    });
    expect(JSON.stringify(capturedDetail)).not.toContain(SECRET);
    expect(JSON.stringify(capturedDetail)).toContain("[REDACTED:private_block]");

    const imported = store.importHandoffs({ projectRoot: root, sourcePaths: [".openspec/handoffs/straddling.md"] });
    if (imported.outcome !== "imported") throw new Error("Expected a handoff import result.");
    expect(imported.imported).toHaveLength(1);
    const importedDetail = store.getSessionDetailForAgent({
      sessionId: imported.imported[0]!.id,
      includeRawSnapshots: true,
    });
    expect(JSON.stringify(importedDetail)).not.toContain(SECRET);
    expect(JSON.stringify(importedDetail)).toContain("[REDACTED:private_block]");
  });
});
