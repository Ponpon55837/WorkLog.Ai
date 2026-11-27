import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FinalizeSessionInput } from "../../packages/core/src/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

const EARLY = "2026-05-01T08:00:00.000Z";
const MIDDAY = "2026-05-01T12:00:00.000Z";
const LATE = "2026-05-02T08:00:00.000Z";

const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

interface Fixture {
  store: WorkIntelligenceStore;
  root: string;
  projectId: string;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createFixture(name: string, store = new WorkIntelligenceStore(":memory:")): Fixture {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-finalize-hints-"));
  tempDirs.push(root);
  if (!stores.includes(store)) stores.push(store);
  const project = store.addProject(name, root);
  store.updateProject(project.id, { status: "tracked" });
  return { store, root, projectId: project.id };
}

function finalize(fixture: Fixture, key: string, nextSteps: string[], extra: Partial<FinalizeSessionInput> = {}) {
  const result = fixture.store.finalizeSession({
    projectRoot: fixture.root,
    idempotencyKey: key,
    title: key,
    summary: `Finished ${key}.`,
    workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps },
    changedFiles: [],
    verification: { status: "passed" },
    completedAt: EARLY,
    ...extra,
  });
  if (result.outcome !== "finalized") throw new Error("Expected a finalized Session.");
  return result;
}

function pendingId(fixture: Fixture, text: string): string {
  const result = fixture.store.listOutstandingItems({ projectId: fixture.projectId, status: "pending", pageSize: 0 });
  if (result.outcome !== "outstanding_items") throw new Error("Expected outstanding items.");
  const item = result.items.find((candidate) => candidate.text === text);
  if (!item) throw new Error(`Expected pending item: ${text}`);
  return item.id;
}

describe("timestamp warnings", () => {
  it("point to work_update_session_metadata instead of voiding the Session", () => {
    const fixture = createFixture("Timestamp hint fixture");
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
    const backfilled = finalize(fixture, "ts-backfill", [], { completedAt: hoursAgo(48) });
    const inverted = finalize(fixture, "ts-inverted", [], { startedAt: hoursAgo(-1), completedAt: undefined });
    const longSpan = finalize(fixture, "ts-long", [], { startedAt: hoursAgo(24 * 10), completedAt: undefined });
    for (const result of [backfilled, inverted, longSpan]) {
      expect(result.timestampWarnings).toHaveLength(1);
      expect(result.timestampWarnings![0]).toContain("work_update_session_metadata");
      expect(result.timestampWarnings![0]).toContain("never void and recreate the Session");
    }
  });
});

describe("privateTagWarnings", () => {
  it("lists the fields with an unclosed <private> tag without echoing their text", () => {
    const fixture = createFixture("Private tag fixture");
    const result = finalize(fixture, "private-open", ["Plain step", "Follow up <private> zephyrquill"], {
      summary: "Opened <private> and never closed it.",
    });
    expect(result.privateTagWarnings).toEqual({
      fields: ["summary", "workSummary.nextSteps[1]"],
      unclosed: 2,
      message: expect.any(String),
    });
    expect(JSON.stringify(result.privateTagWarnings)).not.toContain("zephyrquill");
    expect(result.session.summary).toContain("<private>");
  });

  it("counts every unclosed opening tag and ignores closed blocks", () => {
    const fixture = createFixture("Private tag count fixture");
    const result = finalize(fixture, "private-count", [], {
      title: "Two <private> opens <private> here",
      summary: "A closed <private>hidden-plan</private> is redacted as usual.",
    });
    expect(result.privateTagWarnings).toMatchObject({ fields: ["title"], unclosed: 2 });
    expect(result.session.summary).not.toContain("hidden-plan");
  });

  it("stays absent for closed blocks, stray closing tags, and replays", () => {
    const fixture = createFixture("Private tag absent fixture");
    const clean = finalize(fixture, "private-closed", ["Step </private> stray close"], {
      summary: "Closed <private>secret plan</private> block.",
    });
    expect(clean).not.toHaveProperty("privateTagWarnings");
    const first = finalize(fixture, "private-replay", [], { summary: "Replay <private> open." });
    expect(first.privateTagWarnings).toBeDefined();
    const replay = finalize(fixture, "private-replay", [], { summary: "Replay <private> open." });
    expect(replay.duplicate).toBe(true);
    expect(replay).not.toHaveProperty("privateTagWarnings");
  });

  it("caps the listed fields while still counting all of them", () => {
    const fixture = createFixture("Private tag cap fixture");
    const nextSteps = Array.from({ length: 14 }, (_, index) => `Step ${index} <private> open`);
    const result = finalize(fixture, "private-cap", nextSteps);
    expect(result.privateTagWarnings!.fields).toHaveLength(10);
    expect(result.privateTagWarnings!.unclosed).toBe(14);
  });
});

describe("outstandingItemWarnings reasons", () => {
  function seed() {
    const fixture = createFixture("Reason fixture");
    finalize(fixture, "reason-source", ["Open pending", "Already done", "Voided source"], { completedAt: EARLY });
    const other = createFixture("Reason other project", fixture.store);
    finalize(other, "reason-other", ["Foreign pending"], { completedAt: EARLY });
    return { fixture, other };
  }

  it("names the failed rule for each id a finalize leaves pending", () => {
    const { fixture, other } = seed();
    const done = pendingId(fixture, "Already done");
    fixture.store.updateOutstandingItemStatus(done, "completed", "web");
    const foreign = pendingId(other, "Foreign pending");
    const result = finalize(fixture, "reason-actor", [], {
      completedAt: LATE,
      resolvedOutstandingItemIds: ["missing-id", foreign, done],
    });
    expect(result.outstandingItemWarnings?.reasons).toEqual([
      { id: "missing-id", list: "resolved", code: "not_found" },
      { id: foreign, list: "resolved", code: "other_project" },
      { id: done, list: "resolved", code: "not_pending" },
    ]);
    expect(result.outstandingItemWarnings?.message).toContain("維持原狀");
  });

  it("reports source_voided for a voided source", () => {
    const { fixture } = seed();
    const voided = finalize(fixture, "reason-voided-source", ["Orphaned item"], { completedAt: EARLY });
    const orphan = pendingId(fixture, "Orphaned item");
    fixture.store.setSessionVoid({ sessionId: voided.session.id, voided: true, reason: "Synthetic correction." });
    const result = finalize(fixture, "reason-voided", [], { completedAt: LATE, resolvedOutstandingItemIds: [orphan] });
    expect(result.outstandingItemWarnings?.reasons).toEqual([{ id: orphan, list: "resolved", code: "source_voided" }]);
  });

  it("reports no_next_steps and both_lists to work_resolve_outstanding_items", () => {
    const { fixture } = seed();
    const actor = finalize(fixture, "reason-resolver", [], { completedAt: LATE });
    const open = pendingId(fixture, "Open pending");
    const result = fixture.store.resolveOutstandingItems({
      sessionId: actor.session.id,
      resolvedOutstandingItemIds: [open],
      supersededOutstandingItemIds: [open],
    });
    if (result.outcome !== "outstanding_items_resolved") throw new Error("Expected a resolve result.");
    expect(result.outstandingItemWarnings?.reasons).toEqual(
      expect.arrayContaining([
        { id: open, list: "resolved", code: "both_lists" },
        { id: open, list: "superseded", code: "both_lists" },
      ]),
    );
    const noSteps = fixture.store.resolveOutstandingItems({
      sessionId: actor.session.id,
      supersededOutstandingItemIds: [open],
    });
    if (noSteps.outcome !== "outstanding_items_resolved") throw new Error("Expected a resolve result.");
    expect(noSteps.outstandingItemWarnings?.reasons).toEqual([{ id: open, list: "superseded", code: "no_next_steps" }]);
  });

  it("reports held_by_cleanup while a cleanup request holds the item", () => {
    const { fixture } = seed();
    const open = pendingId(fixture, "Open pending");
    const request = fixture.store.createOutstandingCleanupRequest({
      projectId: fixture.projectId,
      idempotencyKey: "reason-held-request",
    });
    expect(request.outcome).toBe("outstanding_cleanup_request_created");
    const result = finalize(fixture, "reason-held", [], { completedAt: LATE, resolvedOutstandingItemIds: [open] });
    expect(result.outstandingItemWarnings?.reasons).toEqual([{ id: open, list: "resolved", code: "held_by_cleanup" }]);
  });

  it("lets a Session resolve its own items and adds not_earlier for later sources", () => {
    const { fixture } = seed();
    const earlyActor = finalize(fixture, "reason-early-actor", ["Own step"], { completedAt: MIDDAY });
    const own = pendingId(fixture, "Own step");
    const older = pendingId(fixture, "Open pending");
    const later = finalize(fixture, "reason-later-source", ["Later pending"], { completedAt: LATE });
    const laterItem = pendingId(fixture, "Later pending");
    const result = fixture.store.resolveOutstandingItems({
      sessionId: earlyActor.session.id,
      resolvedOutstandingItemIds: [own, laterItem, older],
      supersededOutstandingItemIds: ["missing-id"],
    });
    if (result.outcome !== "outstanding_items_resolved") throw new Error("Expected a resolve result.");
    expect(later.session.id).toBeTruthy();
    expect(result.outstandingItemWarnings?.reasons).toEqual(
      expect.arrayContaining([
        { id: laterItem, list: "resolved", code: "not_earlier" },
        { id: "missing-id", list: "superseded", code: "not_found" },
      ]),
    );
    expect(result.resolvedOutstandingItemIds).toEqual(expect.arrayContaining([own, older]));
    expect(result.resolvedOutstandingItemIds).toHaveLength(2);
    expect(result.outstandingItemWarnings?.reasons).toHaveLength(2);
  });

  it("is absent when every id applies", () => {
    const { fixture } = seed();
    const open = pendingId(fixture, "Open pending");
    const result = finalize(fixture, "reason-clean", [], { completedAt: LATE, resolvedOutstandingItemIds: [open] });
    expect(result.resolvedOutstandingItemIds).toEqual([open]);
    expect(result).not.toHaveProperty("outstandingItemWarnings");
  });
});
