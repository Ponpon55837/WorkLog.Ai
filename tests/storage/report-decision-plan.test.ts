import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

const roots: string[] = [];
const stores: WorkIntelligenceStore[] = [];

function seed() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2026, 2, 11, 12));
  const root = mkdtempSync(join(tmpdir(), "wi-report-plan-"));
  roots.push(root);
  const projectRoot = join(root, "orchard");
  mkdirSync(projectRoot);
  const databasePath = join(root, "fictional.sqlite");
  const store = new WorkIntelligenceStore(databasePath);
  stores.push(store);
  const project = store.addProject("Orchard", projectRoot);
  store.updateProject(project.id, { status: "tracked" });
  for (let index = 0; index < 30; index += 1) {
    vi.setSystemTime(Date.now() + 3_600_000);
    const result = store.finalizeSession({
      projectRoot,
      idempotencyKey: `session-${index}`,
      title: `Fictional session ${index}`,
      summary: "Saved fictional work.",
      workSummary: {
        outcomes: [],
        scope: [],
        decisions:
          index % 3 === 0 ? [{ text: `Fictional decision ${index}`, origin: "agent_autonomous" as const }] : [],
        verification: [],
        nextSteps: [],
      },
      changedFiles: [],
      verification: { status: "passed" as const },
    });
    if (result.outcome !== "finalized") throw new Error("Expected fixture Session");
  }
  return { store, databasePath };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

describe("report decision queries with planner statistics", () => {
  it("returns the same year report with and without ANALYZE, and keeps session_decisions as the outer loop", () => {
    const { store, databasePath } = seed();
    const before = store.getReport({ period: "year", date: "2026-03-11" });
    expect("agentAutonomousDecisions" in before && before.agentAutonomousDecisions.total).toBeGreaterThan(0);

    const db = new DatabaseSync(databasePath);
    try {
      db.exec("ANALYZE;");
    } finally {
      db.close();
    }
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const analyzed = new WorkIntelligenceStore(databasePath);
    stores.push(analyzed);

    const captured: Array<{ sql: string; params: unknown[] }> = [];
    const original = DatabaseSync.prototype.prepare;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
      const statement = original.call(this, sql);
      if (sql.includes("agent_autonomous") && sql.includes("session_decisions d")) {
        for (const method of ["get", "all"] as const) {
          const run = statement[method].bind(statement) as (...args: never[]) => unknown;
          (statement as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
            captured.push({ sql, params: args });
            return run(...(args as never[]));
          };
        }
      }
      return statement;
    });
    const after = analyzed.getReport({ period: "year", date: "2026-03-11" });
    vi.restoreAllMocks();
    expect(after).toEqual(before);

    const decisionQueries = captured.filter((entry) => entry.sql.includes("d.origin = 'agent_autonomous'"));
    expect(decisionQueries.length).toBeGreaterThanOrEqual(2);
    const check = new DatabaseSync(databasePath, { readOnly: true });
    try {
      for (const { sql, params } of decisionQueries) {
        const plan = (
          check.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as Array<{ detail: string }>
        ).map((row) => row.detail);
        const first = plan.find((detail) => /^(SCAN|SEARCH)/.test(detail));
        expect(first, plan.join("\n")).toMatch(/^(SCAN|SEARCH) d\b/);
        expect(plan.join("\n")).not.toMatch(/(SCAN|SEARCH) s\b[^\n]*completed_at/);
      }
    } finally {
      check.close();
    }
  });
});
