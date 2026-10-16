import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
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
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-prune-"));
  tempDirs.push(root);
  const databasePath = join(root, "test.sqlite");
  const store = new WorkIntelligenceStore(databasePath);
  stores.push(store);
  const project = store.addProject("Prune fixture", root);
  store.updateProject(project.id, { status: "tracked" });
  const finalized = store.finalizeSession({
    projectRoot: root,
    idempotencyKey: "prune-base",
    title: "Base",
    summary: "Base summary",
    workSummary: { outcomes: ["原始成果"], scope: [], decisions: [], verification: [], nextSteps: [] },
    verification: { status: "passed" },
  });
  if (finalized.outcome !== "finalized") {
    throw new Error("Expected a finalized Session.");
  }
  const input = (key: string, outcome: string) => ({
    sessionId: finalized.session.id,
    idempotencyKey: key,
    mode: "patch" as const,
    workSummary: { outcomes: [outcome] },
  });
  const ageRow = (key: string, createdAt: string) => {
    const db = new DatabaseSync(databasePath);
    db.prepare("UPDATE session_work_summary_updates SET created_at = ? WHERE idempotency_key = ?").run(createdAt, key);
    db.close();
  };
  const readRow = (key: string) => {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    const row = db.prepare("SELECT * FROM session_work_summary_updates WHERE idempotency_key = ?").get(key) as Record<
      string,
      string
    >;
    db.close();
    return row;
  };
  return { store, input, ageRow, readRow };
}

describe("work summary update history prune", () => {
  it("empties only rows older than the retention window and keeps the request", () => {
    const { store, input, ageRow, readRow } = setup();
    store.updateSessionWorkSummary(input("old-key", "舊更新"));
    store.updateSessionWorkSummary(input("new-key", "新更新"));
    ageRow("old-key", "2030-01-01T00:00:00.000Z");
    ageRow("new-key", "2030-01-09T00:00:00.000Z");

    expect(store.pruneWorkSummaryUpdateHistory(new Date("2030-01-10T00:00:00.000Z"))).toBe(1);

    const old = readRow("old-key");
    expect(old.previous_work_summary_json).toBe("{}");
    expect(old.resulting_work_summary_json).toBe("{}");
    expect(old.work_summary_json).toContain("舊更新");
    expect(readRow("new-key").resulting_work_summary_json).toContain("新更新");
    expect(store.pruneWorkSummaryUpdateHistory(new Date("2030-01-10T00:00:00.000Z"))).toBe(0);
  });

  it("replays a pruned key from the current work summary and still detects conflicts", () => {
    const { store, input, ageRow } = setup();
    store.updateSessionWorkSummary(input("old-key", "舊更新"));
    ageRow("old-key", "2030-01-01T00:00:00.000Z");
    store.pruneWorkSummaryUpdateHistory(new Date("2030-01-10T00:00:00.000Z"));

    const replay = store.updateSessionWorkSummary(input("old-key", "舊更新"));
    expect(replay).toMatchObject({
      outcome: "work_summary_updated",
      duplicate: true,
      appliedWorkSummary: { outcomes: expect.arrayContaining(["舊更新"]) },
    });
    expect(replay).not.toHaveProperty("previousWorkSummary");

    expect(store.updateSessionWorkSummary(input("old-key", "不同內容"))).toMatchObject({
      outcome: "work_summary_update_idempotency_conflict",
    });
  });
});
