import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { FinalizeSessionInput } from "../../packages/core/src/index.js";
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

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-observed-start-"));
  tempDirs.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject("Observed project", root);
  store.updateProject(project.id, { status: "tracked" });
  let counter = 0;
  const finalize = (
    overrides: Partial<FinalizeSessionInput> = {},
    context: Parameters<WorkIntelligenceStore["finalizeSession"]>[1] = {},
  ) => {
    counter += 1;
    const result = store.finalizeSession(
      {
        projectRoot: root,
        idempotencyKey: `observed-${counter}`,
        title: `Session ${counter}`,
        summary: `Observed ${counter} summary.`,
        workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
        changedFiles: [],
        verification: { status: "not_run" },
        ...overrides,
      },
      context,
    );
    if (result.outcome !== "finalized") {
      throw new Error("Expected finalize");
    }
    return result;
  };
  return { store, finalize };
}

describe("server-observed segment start", () => {
  it("stores the observed start with its source and an auditable note event", () => {
    const { store, finalize } = setup();
    const at = hoursAgo(2);

    const result = finalize({}, { observedStartedAt: { at, tool: "work_get_context" } });

    expect(result.startedAtSource).toBe("server_observed");
    expect(result.session.startedAt).toBe(at);
    const note = store
      .getSessionDetail(result.session.id)
      ?.events.find((event) => event.details?.field === "startedAt");
    expect(note).toMatchObject({
      type: "note",
      occurredAt: at,
      details: { field: "startedAt", source: "server_observed", tool: "work_get_context" },
    });
    expect(note?.summary).toContain("work_get_context");
  });

  it("prefers a reported startedAt and ignores the observation", () => {
    const { store, finalize } = setup();
    const reported = hoursAgo(1);

    const result = finalize({ startedAt: reported }, { observedStartedAt: { at: hoursAgo(3), tool: "work_recall" } });

    expect(result.startedAtSource).toBe("reported");
    expect(result.session.startedAt).toBe(reported);
    expect(
      store.getSessionDetail(result.session.id)?.events.some((event) => event.details?.field === "startedAt"),
    ).toBe(false);
  });

  it("does not apply the observation to a backfill with completedAt", () => {
    const { finalize } = setup();

    const result = finalize(
      { completedAt: hoursAgo(30) },
      { observedStartedAt: { at: hoursAgo(40), tool: "work_recall" } },
    );

    expect(result.session.startedAt).toBeUndefined();
    expect(result.startedAtSource).toBeUndefined();
  });

  it("ignores an observation after completedAt or older than the long-segment limit", () => {
    const { finalize } = setup();

    const afterCompleted = finalize(
      { completedAt: hoursAgo(5) },
      { observedStartedAt: { at: hoursAgo(1), tool: "work_recall" } },
    );
    const tooOld = finalize({}, { observedStartedAt: { at: hoursAgo(24 * 8), tool: "work_recall" } });

    expect(afterCompleted.session.startedAt).toBeUndefined();
    expect(tooOld.session.startedAt).toBeUndefined();
    expect(tooOld.startedAtSource).toBeUndefined();
  });

  it("uses the earliest of the events and the observation", () => {
    const { finalize } = setup();
    const eventAt = hoursAgo(3);
    const observedAt = hoursAgo(2);

    const eventFirst = finalize(
      { events: [{ type: "note", summary: "Fictional earlier step.", occurredAt: eventAt }] },
      { observedStartedAt: { at: observedAt, tool: "work_recall" } },
    );
    const observedFirst = finalize(
      { events: [{ type: "note", summary: "Fictional later step.", occurredAt: observedAt }] },
      { observedStartedAt: { at: eventAt, tool: "work_recall" } },
    );

    expect(eventFirst.startedAtSource).toBe("events");
    expect(eventFirst.session.startedAt).toBe(eventAt);
    expect(observedFirst.startedAtSource).toBe("server_observed");
    expect(observedFirst.session.startedAt).toBe(eventAt);
  });

  it("reports no new source and adds no event when a retry returns the existing Session", () => {
    const { store, finalize } = setup();
    const at = hoursAgo(2);
    const first = finalize(
      { idempotencyKey: "observed-retry", summary: "Same summary." },
      { observedStartedAt: { at, tool: "work_recall" } },
    );
    const eventCount = store.getSessionDetail(first.session.id)?.events.length;

    const retry = finalize(
      { idempotencyKey: "observed-retry", summary: "Same summary." },
      { observedStartedAt: { at: hoursAgo(1), tool: "x" } },
    );

    expect(retry.duplicate).toBe(true);
    expect(retry.startedAtSource).toBeUndefined();
    expect(retry.session.startedAt).toBe(at);
    expect(store.getSessionDetail(first.session.id)?.events.length).toBe(eventCount);
  });
});

describe("startedAt and changed-files metadata corrections", () => {
  it("keeps a note when startedAt is added or corrected, and nothing when unchanged", () => {
    const { store, finalize } = setup();
    const sessionId = finalize().session.id;
    const first = hoursAgo(3);
    const second = hoursAgo(2);

    store.updateSessionMetadata({ sessionId, startedAt: first });
    store.updateSessionMetadata({ sessionId, startedAt: second });
    store.updateSessionMetadata({ sessionId, startedAt: second });

    const notes = (store.getSessionDetail(sessionId)?.events ?? []).filter(
      (event) => event.details?.field === "startedAt",
    );
    expect(notes).toHaveLength(2);
    expect(notes.map((note) => note.summary)).toEqual(
      expect.arrayContaining([`補上開始時間 ${first}。`, `開始時間由 ${first} 更正為 ${second}。`]),
    );
    expect(notes.map((note) => note.details)).toEqual(
      expect.arrayContaining([
        { field: "startedAt", previous: null, next: first },
        { field: "startedAt", previous: first, next: second },
      ]),
    );
    expect(store.getSessionById(sessionId)?.startedAt).toBe(second);
  });

  it("keeps the stored files, provenance, and confirmation when changedFiles is omitted", () => {
    const { store, finalize } = setup();
    const sessionId = finalize({
      changedFiles: ["src/ledger.ts"],
      changedFilesProvenance: [{ path: "src/ledger.ts", sources: ["agent"] }],
    }).session.id;
    const before = store.getSessionById(sessionId);

    store.updateSessionMetadata({ sessionId, startedAt: hoursAgo(1) });

    const after = store.getSessionById(sessionId);
    expect(after?.changedFiles).toEqual(["src/ledger.ts"]);
    expect(after?.changedFilesProvenance).toEqual(before?.changedFilesProvenance);
    expect(after?.changedFileChanges).toEqual(before?.changedFileChanges);
  });
});
