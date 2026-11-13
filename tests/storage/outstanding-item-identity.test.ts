import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];
const EARLY = "2026-01-01T10:00:00.000Z";
const LATE = "2026-01-02T10:00:00.000Z";

type Fixture = { store: WorkIntelligenceStore; root: string; projectId: string };

function createProject(name: string, status: "tracked" | "paused" = "tracked"): Fixture {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-item-identity-"));
  tempDirs.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject(name, root);
  store.updateProject(project.id, { status });
  return { store, root, projectId: project.id };
}

function addProject(store: WorkIntelligenceStore, name: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-item-identity-"));
  tempDirs.push(root);
  const project = store.addProject(name, root);
  store.updateProject(project.id, { status: "tracked" });
  return { store, root, projectId: project.id };
}

function finalize(
  { store, root }: Pick<Fixture, "store" | "root">,
  key: string,
  nextSteps: string[],
  completedAt = EARLY,
  extra: { resolvedOutstandingItemIds?: string[]; parentSessionId?: string } = {},
) {
  const result = store.finalizeSession({
    projectRoot: root,
    idempotencyKey: key,
    title: key,
    summary: `Fictional work ${key}.`,
    changedFiles: [],
    verification: { status: "passed" },
    workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps },
    completedAt,
    ...extra,
  });
  if (result.outcome !== "finalized") throw new Error(`Expected finalized, got ${result.outcome}.`);
  return result;
}

function items(
  store: WorkIntelligenceStore,
  projectId: string,
  status: "pending" | "completed" | "not_needed" = "pending",
) {
  const result = store.listOutstandingItems({ projectId, status, pageSize: 0 });
  if (result.outcome !== "outstanding_items") throw new Error("Expected item list.");
  return result.items;
}

function events(store: WorkIntelligenceStore, projectId: string) {
  return store.exportProjectData({ type: "project", projectId }).tables.outstanding_item_events as Array<
    Record<string, unknown>
  >;
}

function editNextSteps(
  store: WorkIntelligenceStore,
  sessionId: string,
  key: string,
  nextSteps: string[],
  source: "agent" | "web" = "agent",
) {
  const result = store.updateSessionWorkSummary(
    { sessionId, idempotencyKey: key, mode: "patch", workSummary: { nextSteps } },
    source,
  );
  if (result.outcome !== "work_summary_updated") throw new Error(`Expected update, got ${result.outcome}.`);
  return result;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("rewording keeps outstanding item identity", () => {
  it("updates text and position in place without a new event", () => {
    const fixture = createProject("Reword fixture");
    const session = finalize(fixture, "reword-a", ["PR #12 尚未合併", "Rotate signing certificate"]).session;
    const before = items(fixture.store, fixture.projectId);
    const eventCount = events(fixture.store, fixture.projectId).length;

    const update = editNextSteps(fixture.store, session.id, "reword-a-1", [
      "Rotate signing certificate",
      "PR #12 已開啟但尚未合併",
    ]);
    expect(update.outstandingItems).toEqual({ created: 0, retained: 1, reworded: 1, closed: 0 });
    const after = items(fixture.store, fixture.projectId);
    const reworded = after.find((item) => item.text === "PR #12 已開啟但尚未合併");
    const original = before.find((item) => item.text === "PR #12 尚未合併");
    expect(reworded).toMatchObject({
      id: original?.id,
      createdAt: original?.createdAt,
      position: 1,
      status: "pending",
    });
    expect(events(fixture.store, fixture.projectId)).toHaveLength(eventCount);
    expect(items(fixture.store, fixture.projectId, "not_needed")).toEqual([]);
  });

  it("closes unrelated replacements and creates a new item", () => {
    const fixture = createProject("Replacement fixture");
    const session = finalize(fixture, "replace-a", ["Windows 尚未驗證"]).session;
    const update = editNextSteps(fixture.store, session.id, "replace-a-1", ["macOS 尚未驗證"]);
    expect(update.outstandingItems).toEqual({ created: 1, retained: 0, reworded: 0, closed: 1 });
    expect(items(fixture.store, fixture.projectId).map((item) => item.text)).toEqual(["macOS 尚未驗證"]);
    expect(items(fixture.store, fixture.projectId, "not_needed").map((item) => item.text)).toEqual([
      "Windows 尚未驗證",
    ]);
  });

  it("omits the summary when nothing changed and keeps one reworded among unchanged", () => {
    const fixture = createProject("Mixed fixture");
    const session = finalize(fixture, "mixed-a", [
      "Alpha stays the same",
      "Verify Orbit cache lock",
      "Gamma stays too",
    ]).session;
    const ids = new Map(items(fixture.store, fixture.projectId).map((item) => [item.text, item.id]));
    const same = editNextSteps(fixture.store, session.id, "mixed-a-0", [
      "Alpha stays the same",
      "Verify Orbit cache lock",
      "Gamma stays too",
    ]);
    expect(same.outstandingItems).toBeUndefined();
    const update = editNextSteps(fixture.store, session.id, "mixed-a-1", [
      "Gamma stays too",
      "Verify the Orbit cache lock behavior",
      "Alpha stays the same",
    ]);
    expect(update.outstandingItems).toEqual({ created: 0, retained: 2, reworded: 1, closed: 0 });
    const after = items(fixture.store, fixture.projectId);
    expect(after.map((item) => [item.position, item.id])).toEqual([
      [0, ids.get("Gamma stays too")],
      [1, ids.get("Verify Orbit cache lock")],
      [2, ids.get("Alpha stays the same")],
    ]);
  });

  it("gives the new entry to the best of two competing items", () => {
    const fixture = createProject("Competing fixture");
    const session = finalize(fixture, "compete-a", ["Verify Orbit cache lock", "Verify Orbit cache"]).session;
    const before = items(fixture.store, fixture.projectId);
    const best = before.find((item) => item.text === "Verify Orbit cache lock")!;
    const update = editNextSteps(fixture.store, session.id, "compete-a-1", ["Verify Orbit cache lock behavior"]);
    expect(update.outstandingItems).toEqual({ created: 0, retained: 0, reworded: 1, closed: 1 });
    expect(items(fixture.store, fixture.projectId)).toEqual([
      expect.objectContaining({ id: best.id, text: "Verify Orbit cache lock behavior" }),
    ]);
  });

  it("does not rewrite held items and never revives completed or not_needed rows", () => {
    const fixture = createProject("Held fixture");
    const session = finalize(fixture, "held-a", [
      "PR #12 尚未合併",
      "Rotate signing certificate",
      "Check backup job",
    ]).session;
    const all = items(fixture.store, fixture.projectId);
    const held = all.find((item) => item.text === "PR #12 尚未合併")!;
    const done = all.find((item) => item.text === "Rotate signing certificate")!;
    const dropped = all.find((item) => item.text === "Check backup job")!;
    fixture.store.updateOutstandingItemStatus(done.id, "completed", "web");
    fixture.store.updateOutstandingItemStatus(dropped.id, "not_needed", "web");
    const request = fixture.store.createOutstandingCleanupRequest({
      projectId: fixture.projectId,
      idempotencyKey: "held-request",
    });
    expect(request.outcome).toBe("outstanding_cleanup_request_created");

    const update = editNextSteps(fixture.store, session.id, "held-a-1", [
      "PR #12 已開啟但尚未合併",
      "Rotate the signing certificate before release",
      "Check the backup job schedule",
    ]);
    expect(update.outstandingItems).toMatchObject({ reworded: 0, created: 3 });
    expect(items(fixture.store, fixture.projectId, "completed").map((item) => item.text)).toEqual([
      "Rotate signing certificate",
    ]);
    expect(items(fixture.store, fixture.projectId, "not_needed").map((item) => item.text)).toEqual([
      "Check backup job",
    ]);
    const pending = items(fixture.store, fixture.projectId);
    expect(pending.find((item) => item.id === held.id)).toMatchObject({ text: "PR #12 尚未合併", status: "pending" });
  });

  it("behaves the same for web-source edits and ignores punctuation-only entries", () => {
    const fixture = createProject("Web fixture");
    const session = finalize(fixture, "web-a", ["Verify Orbit cache lock", "。。。"]).session;
    const original = items(fixture.store, fixture.projectId).find((item) => item.text === "Verify Orbit cache lock")!;
    editNextSteps(fixture.store, session.id, "web-a-1", ["Verify the Orbit cache lock behavior", "！！！"], "web");
    const pending = items(fixture.store, fixture.projectId);
    expect(pending.find((item) => item.id === original.id)?.text).toBe("Verify the Orbit cache lock behavior");
    expect(pending.some((item) => item.text === "！！！")).toBe(true);
    expect(items(fixture.store, fixture.projectId, "not_needed").map((item) => item.text)).toEqual(["。。。"]);
  });
});

describe("continuedOutstandingItems in the finalize receipt", () => {
  it("lists pending items of linked Sessions and keeps them out of relatedOutstandingItems", () => {
    const fixture = createProject("Continued fixture");
    const parent = finalize(fixture, "cont-parent", ["Verify Orbit cache lock", "Rotate signing certificate"]).session;
    finalize(fixture, "cont-unlinked", ["Orbit cache documentation review"]);
    const result = finalize(fixture, "cont-child", [], LATE, { parentSessionId: parent.id });
    expect(result.continuedOutstandingItems).toMatchObject({ total: 2, omitted: 0 });
    expect(result.continuedOutstandingItems?.items.map((item) => item.sourceSessionId)).toEqual([parent.id, parent.id]);
    const continuedIds = new Set(result.continuedOutstandingItems?.items.map((item) => item.id));
    expect(result.relatedOutstandingItems?.items.every((item) => !continuedIds.has(item.id))).toBe(true);
  });

  it("leaves out items of a linked Session in another project, which this Session cannot close", () => {
    const fixture = createProject("Continued home fixture");
    const other = addProject(fixture.store, "Continued other fixture");
    const foreign = finalize(other, "cont-foreign", ["Verify Orbit cache lock"]).session;
    const result = finalize(fixture, "cont-cross", [], LATE, { parentSessionId: foreign.id });
    expect(result.continuedOutstandingItems).toBeUndefined();
  });

  it("omits the field without links, caps at 10 with an omitted count, and skips the duplicate replay", () => {
    const fixture = createProject("Continued cap fixture");
    const noLinks = finalize(fixture, "cap-none", []);
    expect(noLinks.continuedOutstandingItems).toBeUndefined();
    const many = Array.from(
      { length: 12 },
      (_, index) => `Distinct pending task number ${index} ${"x".repeat(index)}-${index * 7919}`,
    );
    const parent = finalize(fixture, "cap-parent", many).session;
    const child = finalize(fixture, "cap-child", [], LATE, { parentSessionId: parent.id });
    expect(child.continuedOutstandingItems).toMatchObject({ total: 12, omitted: 2 });
    expect(child.continuedOutstandingItems?.items).toHaveLength(10);
    const replay = finalize(fixture, "cap-child", [], LATE, { parentSessionId: parent.id });
    expect(replay.duplicate).toBe(true);
    expect(replay.continuedOutstandingItems).toBeUndefined();
  });
});

describe("resolveOutstandingItems", () => {
  function setup() {
    const fixture = createProject("Resolve fixture");
    const source = finalize(
      fixture,
      "res-source",
      ["Verify Orbit cache lock", "Rotate signing certificate", "Check backup job"],
      EARLY,
    );
    const actor = finalize(fixture, "res-actor", ["Follow-up remains"], LATE);
    const pending = items(fixture.store, fixture.projectId);
    const byText = (text: string) => pending.find((item) => item.text === text)!;
    return { ...fixture, source: source.session, actor: actor.session, byText };
  }

  it("completes and supersedes later-verified items with the actor on the events", () => {
    const { store, projectId, actor, byText } = setup();
    const a = byText("Verify Orbit cache lock");
    const b = byText("Rotate signing certificate");
    const result = store.resolveOutstandingItems({
      sessionId: actor.id,
      resolvedOutstandingItemIds: [a.id],
      supersededOutstandingItemIds: [b.id],
    });
    expect(result).toEqual({
      outcome: "outstanding_items_resolved",
      sessionId: actor.id,
      resolvedOutstandingItemIds: [a.id],
      supersededOutstandingItemIds: [b.id],
    });
    expect(items(store, projectId, "completed").map((item) => item.id)).toEqual([a.id]);
    expect(items(store, projectId, "not_needed").map((item) => item.id)).toEqual([b.id]);
    expect(events(store, projectId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ item_id: a.id, to_status: "completed", source: "agent", actor_session_id: actor.id }),
        expect.objectContaining({
          item_id: b.id,
          to_status: "not_needed",
          source: "agent",
          actor_session_id: actor.id,
        }),
      ]),
    );
  });

  it("reports a replay as already applied without warnings or new events", () => {
    const { store, projectId, actor, byText } = setup();
    const a = byText("Verify Orbit cache lock");
    store.resolveOutstandingItems({ sessionId: actor.id, resolvedOutstandingItemIds: [a.id] });
    const eventCount = events(store, projectId).length;
    const replay = store.resolveOutstandingItems({ sessionId: actor.id, resolvedOutstandingItemIds: [a.id] });
    expect(replay).toEqual({
      outcome: "outstanding_items_resolved",
      sessionId: actor.id,
      resolvedOutstandingItemIds: [],
      supersededOutstandingItemIds: [],
      alreadyAppliedIds: [a.id],
      duplicate: true,
    });
    expect(events(store, projectId)).toHaveLength(eventCount);
  });

  it("rejects ambiguous ids and superseding without nextSteps, and unknown or non-pending ids", () => {
    const fixture = createProject("Resolve reject fixture");
    const source = finalize(fixture, "rej-source", ["Verify Orbit cache lock", "Rotate signing certificate"], EARLY);
    const actor = finalize(fixture, "rej-actor", [], LATE);
    const [a, b] = items(fixture.store, fixture.projectId);
    const result = fixture.store.resolveOutstandingItems({
      sessionId: actor.session.id,
      resolvedOutstandingItemIds: [a!.id, "missing-id"],
      supersededOutstandingItemIds: [a!.id, b!.id],
    });
    expect(result).toMatchObject({
      outcome: "outstanding_items_resolved",
      resolvedOutstandingItemIds: [],
      supersededOutstandingItemIds: [],
      outstandingItemWarnings: {
        unresolvedIds: expect.arrayContaining([a!.id, "missing-id"]),
        unsupersededIds: expect.arrayContaining([a!.id, b!.id]),
      },
    });
    expect(items(fixture.store, fixture.projectId)).toHaveLength(2);
    expect(source.session.id).toBeTruthy();
  });

  it("rejects the same Session, an equal or later source, other projects, and voided sources", () => {
    const { store, projectId, source, actor, byText } = setup();
    const ownItem = items(store, projectId).find((item) => item.sourceSessionId === actor.id)!;
    expect(
      store.resolveOutstandingItems({ sessionId: actor.id, resolvedOutstandingItemIds: [ownItem.id] }),
    ).toMatchObject({ resolvedOutstandingItemIds: [], outstandingItemWarnings: { unresolvedIds: [ownItem.id] } });

    // The older Session cannot close the newer Session's item (source not earlier).
    const reverse = store.resolveOutstandingItems({ sessionId: source.id, resolvedOutstandingItemIds: [ownItem.id] });
    expect(reverse).toMatchObject({
      resolvedOutstandingItemIds: [],
      outstandingItemWarnings: { unresolvedIds: [ownItem.id] },
    });

    // Equal completion time is not earlier.
    const tie = finalize({ store, root: setupRoot(store, projectId) }, "tie-actor", [], EARLY);
    const sourceItem = byText("Check backup job");
    expect(
      store.resolveOutstandingItems({ sessionId: tie.session.id, resolvedOutstandingItemIds: [sourceItem.id] }),
    ).toMatchObject({ resolvedOutstandingItemIds: [] });

    // Other project.
    const other = addProject(store, "Other project");
    const foreign = finalize(other, "other-source", ["Foreign pending item"], EARLY);
    const foreignItem = items(store, other.projectId)[0]!;
    expect(foreign.session.id).toBeTruthy();
    expect(
      store.resolveOutstandingItems({ sessionId: actor.id, resolvedOutstandingItemIds: [foreignItem.id] }),
    ).toMatchObject({ resolvedOutstandingItemIds: [], outstandingItemWarnings: { unresolvedIds: [foreignItem.id] } });

    // Voided source.
    const target = byText("Rotate signing certificate");
    store.setSessionVoid({ sessionId: source.id, voided: true, reason: "Synthetic source correction." });
    expect(
      store.resolveOutstandingItems({ sessionId: actor.id, resolvedOutstandingItemIds: [target.id] }),
    ).toMatchObject({ resolvedOutstandingItemIds: [] });
  });

  it("leaves items held by an active cleanup request and non-pending items unchanged", () => {
    const { store, projectId, actor, byText } = setup();
    const held = byText("Verify Orbit cache lock");
    const done = byText("Rotate signing certificate");
    store.updateOutstandingItemStatus(done.id, "completed", "web");
    const request = store.createOutstandingCleanupRequest({ projectId, idempotencyKey: "resolve-held" });
    expect(request.outcome).toBe("outstanding_cleanup_request_created");
    const result = store.resolveOutstandingItems({
      sessionId: actor.id,
      resolvedOutstandingItemIds: [held.id, done.id],
    });
    expect(result).toMatchObject({
      resolvedOutstandingItemIds: [],
      outstandingItemWarnings: { unresolvedIds: expect.arrayContaining([held.id, done.id]) },
    });
    expect(items(store, projectId).some((item) => item.id === held.id)).toBe(true);
  });

  it("skips untracked projects quietly and reports unknown or voided actors", () => {
    const { store, projectId, actor, byText } = setup();
    const target = byText("Verify Orbit cache lock");
    expect(store.resolveOutstandingItems({ sessionId: "missing", resolvedOutstandingItemIds: [target.id] })).toEqual({
      outcome: "not_found",
      sessionId: "missing",
    });
    store.setSessionVoid({ sessionId: actor.id, voided: true, reason: "Synthetic actor correction." });
    expect(
      store.resolveOutstandingItems({ sessionId: actor.id, resolvedOutstandingItemIds: [target.id] }),
    ).toMatchObject({ outcome: "skipped" });
    store.setSessionVoid({ sessionId: actor.id, voided: false });
    store.updateProject(projectId, { status: "paused" });
    expect(
      store.resolveOutstandingItems({ sessionId: actor.id, resolvedOutstandingItemIds: [target.id] }),
    ).toMatchObject({ outcome: "skipped", projectStatus: "paused" });
  });
});

function setupRoot(store: WorkIntelligenceStore, projectId: string): string {
  const project = store.getProjectById(projectId);
  if (!project) throw new Error("Expected project.");
  return project.rootPath;
}
