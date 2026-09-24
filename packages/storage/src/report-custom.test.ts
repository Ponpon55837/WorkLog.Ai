import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { WorkIntelligenceStore } from "./store.js";

// Fictional fixtures only. Storage tests run with TZ=UTC, so calendar days match the ISO dates.
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
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-custom-report-"));
  tempDirs.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject("Apiary", root);
  store.updateProject(project.id, { status: "tracked" });
  const finalize = (title: string, completedAt: string) =>
    store.finalizeSession({
      projectRoot: root,
      idempotencyKey: title,
      title,
      summary: "Tended the hives.",
      verification: { status: "passed" },
      changedFiles: [],
      completedAt,
    });
  return { store, finalize };
}

describe("custom-range reports", () => {
  it("covers exactly the given days and compares with the same number of days before", () => {
    const { store, finalize } = setup();
    finalize("before", "2030-01-04T12:00:00.000Z");
    finalize("start", "2030-01-05T12:00:00.000Z");
    finalize("end", "2030-01-18T12:00:00.000Z");
    finalize("after", "2030-01-19T12:00:00.000Z");

    const report = store.getReport({ period: "week", from: "2030-01-05", to: "2030-01-18" });
    if (report.outcome !== "report") {
      throw new Error("Expected a report");
    }
    expect(report.period).toBe("custom");
    expect(report.range).toEqual({ from: "2030-01-05", to: "2030-01-18" });
    expect(report.previousRange).toEqual({ from: "2029-12-22", to: "2030-01-04" });
    expect(report.sessions.map((session) => session.title).sort()).toEqual(["end", "start"]);
    expect(report.comparison.sessions).toMatchObject({ current: 2, previous: 1 });
    expect(report.trendGranularity).toBe("day");
    expect(report.trends).toHaveLength(14);
  });

  it("trends by month past 92 days and names the export after the range", () => {
    const { store } = setup();
    const report = store.getReport({ period: "day", from: "2030-01-01", to: "2030-06-30" });
    expect(report).toMatchObject({ period: "custom", trendGranularity: "month" });
    expect(report.outcome === "report" ? report.trends.map((point) => point.date) : []).toHaveLength(6);

    const exported = store.exportReport({ period: "week", from: "2030-01-01", to: "2030-01-14", format: "markdown" });
    expect(exported).toMatchObject({ filename: "work-report-custom-2030-01-01-to-2030-01-14-all-projects.md" });
    expect(exported.outcome === "report_export" ? exported.content : "").toContain("報告類型：自訂期間");
  });
});
