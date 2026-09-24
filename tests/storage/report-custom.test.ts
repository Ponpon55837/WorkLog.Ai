import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only. Storage tests run with TZ=UTC, so calendar days match the ISO dates.
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

  it("marks current and comparison periods when they exceed the 200-session report limit", () => {
    const { store, finalize } = setup();
    for (let index = 0; index < 200; index += 1) {
      finalize(`previous-${index}`, "2030-01-01T12:00:00.000Z");
    }
    for (let index = 0; index < 201; index += 1) {
      finalize(`current-${index}`, "2030-01-02T12:00:00.000Z");
    }

    const currentReport = store.getReport({ period: "day", from: "2030-01-02", to: "2030-01-02" });
    if (currentReport.outcome !== "report") {
      throw new Error("Expected a current-period report");
    }
    expect(currentReport.sessions).toHaveLength(200);
    expect(currentReport.sessionTruncation).toEqual({ currentPeriod: true, previousPeriod: false });
    const markdown = store.exportReport({
      period: "day",
      from: "2030-01-02",
      to: "2030-01-02",
      format: "markdown",
    });
    expect(markdown.outcome === "report_export" ? markdown.content : "").toContain("部分資料未納入報告");

    const followingReport = store.getReport({ period: "day", from: "2030-01-03", to: "2030-01-03" });
    expect(followingReport).toMatchObject({
      outcome: "report",
      sessionTruncation: { currentPeriod: false, previousPeriod: true },
    });
  });
});

describe("work that crosses the report period", () => {
  it("lists earlier starts, later completions and later corrections without counting them twice", () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-spanning-"));
    tempDirs.push(root);
    const store = new WorkIntelligenceStore(":memory:");
    stores.push(store);
    const project = store.addProject("Apiary", root);
    store.updateProject(project.id, { status: "tracked" });
    vi.useFakeTimers({ toFake: ["Date"] });
    const finalize = (key: string, now: string, startedAt: string | undefined, completedAt: string) => {
      vi.setSystemTime(new Date(now));
      const result = store.finalizeSession({
        projectRoot: root,
        idempotencyKey: key,
        title: key,
        summary: "Tended the hives.",
        verification: { status: "passed" },
        changedFiles: [],
        ...(startedAt ? { startedAt } : {}),
        completedAt,
      });
      if (result.outcome !== "finalized") {
        throw new Error("Expected finalize");
      }
      return result.session.id;
    };
    // The period is 2030-01-05 .. 2030-01-11.
    finalize("started-earlier", "2030-01-06T12:00:00Z", "2030-01-03T09:00:00Z", "2030-01-06T12:00:00Z");
    finalize("continued-later", "2030-01-13T12:00:00Z", "2030-01-10T09:00:00Z", "2030-01-13T12:00:00Z");
    const corrected = finalize("corrected", "2030-01-02T12:00:00Z", undefined, "2030-01-02T12:00:00Z");
    // Imported during the period for older work: created, not corrected, in the period.
    finalize("imported", "2030-01-08T12:00:00Z", undefined, "2029-12-20T12:00:00Z");
    vi.setSystemTime(new Date("2030-01-09T12:00:00Z"));
    store.updateSessionSummary({
      sessionId: corrected,
      idempotencyKey: "correct-summary",
      summary: "Tended the hives, corrected.",
      mode: "replace",
    });

    const report = store.getReport({ period: "week", from: "2030-01-05", to: "2030-01-11" });
    if (report.outcome !== "report") {
      throw new Error("Expected a report");
    }
    expect(report.totals.sessions).toBe(1);
    expect(report.spanning.startedEarlier.map((session) => session.title)).toEqual(["started-earlier"]);
    expect(report.spanning.continuedLater.map((session) => session.title)).toEqual(["continued-later"]);
    expect(report.spanning.updatedInPeriod.map((session) => session.title)).toEqual(["corrected"]);
  });
});
