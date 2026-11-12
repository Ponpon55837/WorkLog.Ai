import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OutstandingItem } from "../../packages/core/src/index.js";
import type { OutstandingItemFocus } from "../../packages/storage/src/outstanding-item-service.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

/** The store's connection and service, which this test reaches past the public facade. */
type StoreInternals = {
  db: DatabaseSync;
  outstandingItems: {
    relatedPending(input: OutstandingItemFocus): { items: OutstandingItem[]; total: number; truncated?: true };
  };
};

// Fictional records only. The service reads at most this many pending items per call.
const CANDIDATE_LIMIT = 2_000;

const cleanups: Array<() => void> = [];

/** A tracked project whose one source Session holds `count` pending items that all mention "lease". */
function setup(count: number) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-01T08:00:00.000Z"));
  const store = new WorkIntelligenceStore(":memory:");
  const root = mkdtempSync(join(tmpdir(), "wi-pending-limit-"));
  cleanups.push(
    () => rmSync(root, { recursive: true, force: true }),
    () => store.close(),
  );
  const project = store.addProject("Synthetic pending limit", root);
  store.updateProject(project.id, { status: "tracked" });
  const source = store.finalizeSession({
    projectRoot: root,
    idempotencyKey: "pending-limit-source",
    title: "Synthetic source",
    summary: "Left fictional lease work.",
    changedFiles: ["src/lease.ts"],
    workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: ["Check lease renewal 0"] },
    verification: { status: "passed" },
  });
  if (source.outcome !== "finalized") throw new Error("Expected the source Session.");
  // Copies of the one recorded item, one per position, so the scope holds `count` pending items.
  const { db } = store as unknown as StoreInternals;
  const columns = (db.prepare("PRAGMA table_info(outstanding_items)").all() as Array<{ name: string }>).map(
    (column) => column.name,
  );
  const values = columns.map((name) =>
    name === "id"
      ? "id || '-' || n.x"
      : name === "position"
        ? "n.x"
        : name === "text"
          ? "text || ' copy ' || n.x"
          : name,
  );
  db.prepare(
    `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < ?)
       INSERT INTO outstanding_items (${columns.join(", ")})
       SELECT ${values.join(", ")} FROM outstanding_items CROSS JOIN n`,
  ).run(count - 1);
  vi.setSystemTime(new Date("2026-06-01T09:00:00.000Z"));
  const { outstandingItems } = store as unknown as StoreInternals;
  return { store, root, projectId: project.id, outstandingItems };
}

afterEach(() => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("related pending candidate limit", () => {
  it("scores every pending item up to the limit and says nothing", () => {
    const { projectId, outstandingItems } = setup(CANDIDATE_LIMIT);
    const result = outstandingItems.relatedPending({ projectId, task: "lease renewal" });
    expect(result.total).toBe(CANDIDATE_LIMIT);
    expect(result.items).toHaveLength(5);
    expect(result).not.toHaveProperty("truncated");
  });

  it("reads only the limit when more qualify and reports it to finalize", () => {
    const { store, root, projectId, outstandingItems } = setup(CANDIDATE_LIMIT + 1);
    const result = outstandingItems.relatedPending({ projectId, task: "lease renewal" });
    expect(result).toMatchObject({ total: CANDIDATE_LIMIT, truncated: true });
    // Equal scores fall back to position: the first five items are still the five shown.
    expect(result.items.map((item) => item.position)).toEqual([0, 1, 2, 3, 4]);
    const finalized = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "pending-limit-closing",
      title: "Synthetic lease renewal",
      summary: "Worked on the fictional lease renewal.",
      changedFiles: ["src/lease.ts"],
      verification: { status: "passed" },
    });
    expect(finalized).toMatchObject({
      outcome: "finalized",
      relatedOutstandingItems: { total: CANDIDATE_LIMIT, truncated: true },
    });
  });
});
