import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { FinalizeSessionInput, VerificationStatus } from "../../packages/core/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only.
const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-hotspots-"));
  tempDirs.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject("Apiary", root);
  store.updateProject(project.id, { status: "tracked" });
  let day = 0;
  const finalize = (
    key: string,
    changedFiles: string[],
    status: VerificationStatus = "passed",
    overrides: Partial<FinalizeSessionInput> = {},
  ) => {
    day += 1;
    const result = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: key,
      title: `Session ${key}`,
      summary: `${key} summary.`,
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles,
      verification: { status },
      completedAt: new Date(Date.UTC(2026, 0, day, 12)).toISOString(),
      ...overrides,
    });
    if (result.outcome !== "finalized") throw new Error("Expected finalize");
    return result.session.id;
  };
  return { store, root, project, finalize };
}

describe("hotspots", () => {
  it("ranks files by Sessions that changed them, with failure counts and the newest five Sessions", () => {
    const { store, root, finalize } = setup();
    const ids = [
      finalize("a", ["src/hive/frames.ts", "src/hive/queen.ts"], "failed"),
      finalize("b", ["src/hive/frames.ts"], "not_run"),
      finalize("c", [join(root, "src/hive/frames.ts")]),
      finalize("d", ["src/hive/frames.ts", "README.md"]),
      finalize("e", ["src/hive/frames.ts"]),
      finalize("f", ["src/hive/frames.ts"], "failed"),
    ];
    const voided = finalize("voided", ["src/hive/queen.ts"]);
    store.setSessionVoid({ sessionId: voided, voided: true, reason: "Recorded by mistake." });
    // More than 20 changed files marks a polluted worktree; it must not count.
    finalize(
      "polluted",
      Array.from({ length: 25 }, (_, index) => `src/noise/file-${index}.ts`).concat("src/hive/queen.ts"),
    );

    const result = store.getHotspots({ projectRoot: root });
    if (result.outcome !== "hotspots") throw new Error("Expected hotspots");
    expect(result.items.map((item) => [item.path, item.sessionCount])).toEqual([
      ["src/hive/frames.ts", 6],
      // Ties go to more failures, then the most recently changed path; paths keep their original casing.
      ["src/hive/queen.ts", 1],
      ["README.md", 1],
    ]);
    const [frames] = result.items;
    expect(frames).toMatchObject({ failedCount: 2, notRunCount: 1, projectName: "Apiary" });
    expect(frames?.recentSessions.map((session) => session.id)).toEqual([ids[5], ids[4], ids[3], ids[2], ids[1]]);
    expect(frames?.recentSessions[0]?.verificationStatus).toBe("failed");
  });

  it("groups by directory, filters by date, and limits the result", () => {
    const { store, root, finalize } = setup();
    finalize("a", ["src/hive/frames.ts", "src/hive/queen.ts"]);
    finalize("b", ["src/orchard/trees.ts"]);
    finalize("c", ["src/hive/smoker.ts", "LICENSE"]);

    const byDirectory = store.getHotspots({ projectRoot: root, groupBy: "directory" });
    expect(
      byDirectory.outcome === "hotspots" && byDirectory.items.map((item) => [item.path, item.sessionCount]),
    ).toEqual([
      ["src/hive", 2],
      [".", 1],
      ["src/orchard", 1],
    ]);
    const ranged = store.getHotspots({ projectRoot: root, from: "2026-01-02", to: "2026-01-02" });
    expect(ranged.outcome === "hotspots" && ranged.items.map((item) => item.path)).toEqual(["src/orchard/trees.ts"]);
    const limited = store.getHotspots({ projectRoot: root, limit: 1 });
    expect(limited.outcome === "hotspots" && limited.items).toHaveLength(1);
  });

  it("warns in the Agent context when a path was changed often in the last 30 days", () => {
    const { store, root, finalize } = setup();
    const recent = (key: string, status: VerificationStatus) =>
      finalize(key, ["src/hive/frames.ts"], status, { completedAt: new Date().toISOString() });
    recent("r1", "failed");
    recent("r2", "passed");
    recent("r3", "not_run");
    finalize("old", ["src/hive/queen.ts"]);

    const context = store.getContext(root, {
      task: "adjust frames",
      paths: ["src/hive/frames.ts", "src/hive/queen.ts"],
    });
    expect(context.outcome === "context" && context.relevant?.hotspots).toEqual([
      { path: "src/hive/frames.ts", days: 30, sessionCount: 3, failedCount: 1, notRunCount: 1 },
    ]);
  });

  it("adds files changed by at least two of the period's Sessions to the report risks", () => {
    const { store, project, finalize } = setup();
    const first = finalize("a", ["src/hive/frames.ts"], "failed");
    const second = finalize("b", ["src/hive/frames.ts", "src/hive/queen.ts"], "not_run");

    const report = store.getReport({ period: "month", from: "2026-01-01", to: "2026-01-31", projectId: project.id });
    if (report.outcome !== "report") throw new Error("Expected report");
    expect(report.risks.filter((risk) => risk.kind === "hotspot")).toEqual([
      {
        kind: "hotspot",
        label: "熱點：src/hive/frames.ts",
        detail: "本期 2 筆 Session 修改，其中 1 筆驗證失敗，1 筆未執行驗證。",
        sourceSessionIds: [second, first],
      },
    ]);
  });

  it("skips projects that are not tracked", () => {
    const { store, root, project } = setup();
    store.updateProject(project.id, { status: "paused" });
    expect(store.getHotspots({ projectRoot: root })).toMatchObject({ outcome: "skipped" });
    expect(store.getHotspots({})).toMatchObject({ outcome: "hotspots", items: [] });
  });
});
