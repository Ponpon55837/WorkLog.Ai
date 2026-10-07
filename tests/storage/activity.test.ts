import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only. Storage tests run with TZ=UTC unless a test switches the zone.
const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-activity-"));
  tempDirs.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject("Meadow", root);
  store.updateProject(project.id, { status: "tracked" });
  const finalize = (key: string, completedAt: string, projectRoot = root) => {
    const result = store.finalizeSession({
      projectRoot,
      idempotencyKey: key,
      title: `Session ${key}`,
      summary: `${key} summary.`,
      completedAt,
    });
    if (result.outcome !== "finalized") throw new Error("Expected finalize");
    return result.session.id;
  };
  return { store, root, project, finalize };
}

describe("getActivity", () => {
  it("counts Sessions per calendar day, oldest first, only for days with work", () => {
    const { store, finalize } = setup();
    finalize("a", "2026-09-01T08:00:00.000Z");
    finalize("b", "2026-09-01T20:00:00.000Z");
    finalize("c", "2026-09-03T12:00:00.000Z");
    finalize("outside", "2026-10-01T12:00:00.000Z");
    expect(store.getActivity({ from: "2026-09-01", to: "2026-09-30" })).toEqual({
      outcome: "activity",
      from: "2026-09-01",
      to: "2026-09-30",
      days: [
        { date: "2026-09-01", sessions: 2 },
        { date: "2026-09-03", sessions: 1 },
      ],
    });
  });

  it("returns an empty list for an empty range and includes both boundary days", () => {
    const { store, finalize } = setup();
    expect(store.getActivity({ from: "2026-09-01", to: "2026-09-30" })).toMatchObject({ days: [] });
    finalize("first", "2026-09-01T00:00:00.000Z");
    finalize("last", "2026-09-30T23:59:59.000Z");
    const result = store.getActivity({ from: "2026-09-01", to: "2026-09-30" });
    expect(result.outcome === "activity" && result.days.map((day) => day.date)).toEqual(["2026-09-01", "2026-09-30"]);
  });

  it("leaves out voided Sessions and untracked projects, and filters by project", () => {
    const { store, finalize, project } = setup();
    const voided = finalize("voided", "2026-09-02T12:00:00.000Z");
    finalize("kept", "2026-09-02T13:00:00.000Z");
    store.setSessionVoid({ sessionId: voided, voided: true, reason: "Fictional mistake." });
    const other = mkdtempSync(join(tmpdir(), "work-intelligence-activity-other-"));
    tempDirs.push(other);
    const second = store.addProject("Orchard", other);
    store.updateProject(second.id, { status: "tracked" });
    finalize("orchard", "2026-09-02T14:00:00.000Z", other);

    expect(store.getActivity({ from: "2026-09-01", to: "2026-09-30" })).toMatchObject({
      days: [{ date: "2026-09-02", sessions: 2 }],
    });
    expect(store.getActivity({ from: "2026-09-01", to: "2026-09-30", projectId: project.id })).toMatchObject({
      days: [{ date: "2026-09-02", sessions: 1 }],
    });

    store.updateProject(second.id, { status: "paused" });
    expect(store.getActivity({ from: "2026-09-01", to: "2026-09-30" })).toMatchObject({
      days: [{ date: "2026-09-02", sessions: 1 }],
    });
    expect(store.getActivity({ from: "2026-09-01", to: "2026-09-30", projectId: second.id })).toMatchObject({
      outcome: "skipped",
    });
  });

  it("buckets days in the host time zone, not by the UTC date", () => {
    process.env.TZ = "Asia/Taipei";
    try {
      const { store, finalize } = setup();
      // 23:30Z on the 21st is 07:30 on the 22nd in Taipei; 16:30Z on the 22nd is 00:30 on the 23rd.
      finalize("early", "2026-09-21T23:30:00.000Z");
      finalize("late", "2026-09-22T16:30:00.000Z");
      expect(store.getActivity({ from: "2026-09-21", to: "2026-09-23" })).toMatchObject({
        days: [
          { date: "2026-09-22", sessions: 1 },
          { date: "2026-09-23", sessions: 1 },
        ],
      });
    } finally {
      process.env.TZ = "UTC";
    }
  });
});
