import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

interface FinalizeTestOptions {
  title?: string;
  summary?: string;
  changedFiles?: string[];
  supersededOutstandingItemIds?: string[];
  omitWorkSummary?: boolean;
}

function createTrackedProject(name: string): { store: WorkIntelligenceStore; root: string; projectId: string } {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-outstanding-items-"));
  tempDirs.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject(name, root);
  store.updateProject(project.id, { status: "tracked" });
  return { store, root, projectId: project.id };
}

function finalize(
  store: WorkIntelligenceStore,
  root: string,
  idempotencyKey: string,
  nextSteps: string[],
  resolvedOutstandingItemIds?: string[],
  completedAt?: string,
  options: FinalizeTestOptions = {},
) {
  return store.finalizeSession({
    projectRoot: root,
    idempotencyKey,
    title: options.title ?? idempotencyKey,
    summary: options.summary ?? `已完成 ${idempotencyKey} 的測試工作。`,
    changedFiles: options.changedFiles ?? [],
    verification: { status: "passed" },
    ...(options.omitWorkSummary
      ? {}
      : { workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps } }),
    resolvedOutstandingItemIds,
    ...(options.supersededOutstandingItemIds
      ? { supersededOutstandingItemIds: options.supersededOutstandingItemIds }
      : {}),
    completedAt,
  });
}

function findOutstandingItem(
  store: WorkIntelligenceStore,
  projectId: string,
  text: string,
  status: "pending" | "completed" | "not_needed" = "pending",
) {
  const result = store.listOutstandingItems({ projectId, status, pageSize: 0 });
  if (result.outcome !== "outstanding_items") throw new Error("Expected outstanding item list.");
  const item = result.items.find((candidate) => candidate.text === text);
  if (!item) throw new Error(`Expected outstanding item: ${text}`);
  return item;
}

function localCalendarDay(daysFromToday: number): { date: string; completedAt: string } {
  const completedAt = new Date();
  completedAt.setHours(12, 0, 0, 0);
  completedAt.setDate(completedAt.getDate() + daysFromToday);
  return {
    date: [
      completedAt.getFullYear().toString().padStart(4, "0"),
      (completedAt.getMonth() + 1).toString().padStart(2, "0"),
      completedAt.getDate().toString().padStart(2, "0"),
    ].join("-"),
    completedAt: completedAt.toISOString(),
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("outstanding items", () => {
  it("keeps exact-text identities and terminal history when workSummary nextSteps changes", () => {
    const { store, root } = createTrackedProject("Outstanding sync fixture");
    const created = finalize(store, root, "outstanding-sync-source", ["Keep this id", "Remove this", "Looks complete"]);
    expect(created.outcome).toBe("finalized");
    const initial = store.listOutstandingItems({ projectRoot: root, status: "pending" });
    expect(initial.outcome).toBe("outstanding_items");
    if (initial.outcome !== "outstanding_items") throw new Error("Expected outstanding item list.");
    const keep = initial.items.find((item) => item.text === "Keep this id");
    const remove = initial.items.find((item) => item.text === "Remove this");
    const looksComplete = initial.items.find((item) => item.text === "Looks complete");
    expect(keep && remove && looksComplete).toBeTruthy();
    if (!keep || !remove || !looksComplete) throw new Error("Expected all initial outstanding items.");

    expect(store.updateOutstandingItemStatus(keep.id, "completed", "web").outcome).toBe("outstanding_item_updated");
    const update = store.updateSessionWorkSummary(
      {
        sessionId: keep.sourceSessionId,
        idempotencyKey: "outstanding-sync-edit",
        mode: "patch",
        workSummary: { nextSteps: ["Keep this id", "New item"] },
      },
      "web",
    );
    expect(update.outcome).toBe("work_summary_updated");

    const all = store.listOutstandingItems({ projectRoot: root, status: "pending", page: 1, pageSize: 0 });
    expect(all.outcome).toBe("outstanding_items");
    if (all.outcome !== "outstanding_items") throw new Error("Expected pending items.");
    expect(all.items.map((item) => item.text)).toEqual(["New item"]);
    const history = store.listOutstandingItems({ projectRoot: root, status: "completed", pageSize: 0 });
    expect(history.outcome).toBe("outstanding_items");
    if (history.outcome !== "outstanding_items") throw new Error("Expected completed history.");
    expect(history.items).toEqual([
      expect.objectContaining({ id: keep.id, status: "completed", text: "Keep this id" }),
    ]);
    const notNeeded = store.listOutstandingItems({ projectRoot: root, status: "not_needed", pageSize: 0 });
    expect(notNeeded.outcome).toBe("outstanding_items");
    if (notNeeded.outcome !== "outstanding_items") throw new Error("Expected removed-item history.");
    expect(notNeeded.items.map(({ id, text }) => ({ id, text }))).toEqual([
      { id: remove.id, text: "Remove this" },
      { id: looksComplete.id, text: "Looks complete" },
    ]);
    expect(
      store.exportProjectData({ type: "project", projectId: keep.projectId }).tables.outstanding_item_events,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ item_id: keep.id, from_status: "pending", to_status: "completed", source: "web" }),
        expect.objectContaining({ item_id: remove.id, from_status: "pending", to_status: "not_needed", source: "web" }),
        expect.objectContaining({
          item_id: expect.any(String),
          from_status: null,
          to_status: "pending",
          source: "web",
        }),
      ]),
    );
  });

  it("resolves only pending items in the finalized tracked project and reports bounded warnings", () => {
    const first = createTrackedProject("Outstanding first project");
    const secondRoot = mkdtempSync(join(tmpdir(), "work-intelligence-outstanding-cross-project-"));
    tempDirs.push(secondRoot);
    const secondProject = first.store.addProject("Outstanding second project", secondRoot);
    first.store.updateProject(secondProject.id, { status: "tracked" });
    const sourceA = finalize(first.store, first.root, "outstanding-resolution-a", ["Resolve me", "Already done"]);
    const sourceB = finalize(first.store, secondRoot, "outstanding-resolution-b", ["Other project"]);
    if (sourceA.outcome !== "finalized" || sourceB.outcome !== "finalized")
      throw new Error("Expected source Sessions.");
    const items = first.store.listOutstandingItems({ status: "pending", pageSize: 0 });
    if (items.outcome !== "outstanding_items") throw new Error("Expected pending items.");
    const resolveMe = items.items.find((item) => item.text === "Resolve me");
    const alreadyDone = items.items.find((item) => item.text === "Already done");
    const otherProject = items.items.find((item) => item.text === "Other project");
    if (!resolveMe || !alreadyDone || !otherProject) throw new Error("Expected pending fixtures.");
    first.store.updateOutstandingItemStatus(alreadyDone.id, "completed", "web");

    const result = finalize(
      first.store,
      first.root,
      "outstanding-resolution-finalize",
      [],
      [resolveMe.id, alreadyDone.id, otherProject.id, "unknown-outstanding-item"],
    );
    expect(result).toMatchObject({
      outcome: "finalized",
      resolvedOutstandingItemIds: [resolveMe.id],
      outstandingItemWarnings: {
        unresolvedIds: [alreadyDone.id, otherProject.id, "unknown-outstanding-item"],
        message: expect.any(String),
      },
    });
    const events = first.store.exportProjectData({ type: "project", projectId: first.projectId }).tables
      .outstanding_item_events;
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          item_id: resolveMe.id,
          from_status: "pending",
          to_status: "completed",
          source: "agent",
          actor_session_id: (result as { session: { id: string } }).session.id,
        }),
      ]),
    );
  });

  it("resolves and supersedes eligible items together, warns on invalid requests, and audits the actor", () => {
    const first = createTrackedProject("Outstanding mixed finalize fixture");
    const source = finalize(first.store, first.root, "outstanding-mixed-source", [
      "Resolve directly verified result",
      "Supersede replaced obligation",
      "Orbit cache conflicting request",
      "Keep completed obligation",
      "Keep not-needed obligation",
      "Review Orbit cache lock state",
    ]);
    if (source.outcome !== "finalized") throw new Error("Expected source Session.");
    const resolve = findOutstandingItem(first.store, first.projectId, "Resolve directly verified result");
    const supersede = findOutstandingItem(first.store, first.projectId, "Supersede replaced obligation");
    const ambiguous = findOutstandingItem(first.store, first.projectId, "Orbit cache conflicting request");
    const completed = findOutstandingItem(first.store, first.projectId, "Keep completed obligation");
    const notNeeded = findOutstandingItem(first.store, first.projectId, "Keep not-needed obligation");
    const related = findOutstandingItem(first.store, first.projectId, "Review Orbit cache lock state");
    first.store.updateOutstandingItemStatus(completed.id, "completed");
    first.store.updateOutstandingItemStatus(notNeeded.id, "not_needed");

    const voidedResolveSource = finalize(first.store, first.root, "outstanding-mixed-voided-resolve", [
      "Void resolve request",
    ]);
    const voidedSupersedeSource = finalize(first.store, first.root, "outstanding-mixed-voided-supersede", [
      "Void supersede request",
    ]);
    if (voidedResolveSource.outcome !== "finalized" || voidedSupersedeSource.outcome !== "finalized") {
      throw new Error("Expected voidable source Sessions.");
    }
    const voidedResolve = findOutstandingItem(first.store, first.projectId, "Void resolve request");
    const voidedSupersede = findOutstandingItem(first.store, first.projectId, "Void supersede request");
    first.store.setSessionVoid({
      sessionId: voidedResolveSource.session.id,
      voided: true,
      reason: "Synthetic source correction.",
    });
    first.store.setSessionVoid({
      sessionId: voidedSupersedeSource.session.id,
      voided: true,
      reason: "Synthetic source correction.",
    });

    const secondRoot = mkdtempSync(join(tmpdir(), "work-intelligence-outstanding-mixed-cross-project-"));
    tempDirs.push(secondRoot);
    const otherProject = first.store.addProject("Outstanding mixed other fixture", secondRoot);
    first.store.updateProject(otherProject.id, { status: "tracked" });
    const otherSource = finalize(first.store, secondRoot, "outstanding-mixed-other-source", [
      "Cross-project resolve request",
      "Cross-project supersede request",
    ]);
    if (otherSource.outcome !== "finalized") throw new Error("Expected cross-project source Session.");
    const crossResolve = findOutstandingItem(first.store, otherProject.id, "Cross-project resolve request");
    const crossSupersede = findOutstandingItem(first.store, otherProject.id, "Cross-project supersede request");

    const beforeEvents = first.store.exportProjectData({ type: "project", projectId: first.projectId }).tables
      .outstanding_item_events;
    const result = finalize(
      first.store,
      first.root,
      "outstanding-mixed-finalize",
      ["Replacement task"],
      [resolve.id, ambiguous.id, completed.id, voidedResolve.id, crossResolve.id, "missing-resolve-item"],
      undefined,
      {
        title: "Orbit cache follow-up",
        summary: "Review the Orbit cache state before closing this work.",
        supersededOutstandingItemIds: [
          supersede.id,
          ambiguous.id,
          notNeeded.id,
          voidedSupersede.id,
          crossSupersede.id,
          "missing-supersede-item",
        ],
      },
    );
    expect(result.outcome).toBe("finalized");
    if (result.outcome !== "finalized") throw new Error("Expected mixed finalize result.");
    expect(result).toMatchObject({
      resolvedOutstandingItemIds: [resolve.id],
      supersededOutstandingItemIds: [supersede.id],
      outstandingItemWarnings: {
        unresolvedIds: expect.arrayContaining([
          ambiguous.id,
          completed.id,
          voidedResolve.id,
          crossResolve.id,
          "missing-resolve-item",
        ]),
        unsupersededIds: expect.arrayContaining([
          ambiguous.id,
          notNeeded.id,
          voidedSupersede.id,
          crossSupersede.id,
          "missing-supersede-item",
        ]),
      },
    });

    const tables = first.store.exportProjectData({ type: "project", projectId: first.projectId }).tables;
    expect(tables.outstanding_items.find((item) => item.id === resolve.id)?.status).toBe("completed");
    expect(tables.outstanding_items.find((item) => item.id === supersede.id)?.status).toBe("not_needed");
    expect(tables.outstanding_items.find((item) => item.id === ambiguous.id)?.status).toBe("pending");
    expect(tables.outstanding_items.find((item) => item.id === related.id)?.status).toBe("pending");
    expect(tables.outstanding_items.find((item) => item.id === voidedResolve.id)?.status).toBe("pending");
    expect(tables.outstanding_items.find((item) => item.id === voidedSupersede.id)?.status).toBe("pending");
    expect(
      first.store
        .exportProjectData({ type: "project", projectId: otherProject.id })
        .tables.outstanding_items.filter(
          (item) => typeof item.id === "string" && [crossResolve.id, crossSupersede.id].includes(item.id),
        )
        .every((item) => item.status === "pending"),
    ).toBe(true);

    const actorEvents = tables.outstanding_item_events.filter((event) => event.actor_session_id === result.session.id);
    expect(tables.outstanding_item_events).toHaveLength(beforeEvents.length + 3);
    expect(actorEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          item_id: resolve.id,
          from_status: "pending",
          to_status: "completed",
          source: "agent",
          actor_session_id: result.session.id,
        }),
        expect.objectContaining({
          item_id: supersede.id,
          from_status: "pending",
          to_status: "not_needed",
          source: "agent",
          actor_session_id: result.session.id,
        }),
      ]),
    );
    expect(actorEvents).toHaveLength(3);

    expect(result.relatedOutstandingItems).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: related.id, sourceSessionId: related.sourceSessionId }),
        expect.objectContaining({ id: ambiguous.id, sourceSessionId: ambiguous.sourceSessionId }),
      ]),
      hint: expect.stringContaining("先讀來源"),
    });
    expect(result.relatedOutstandingItems?.items.some((item) => item.sourceSessionId === result.session.id)).toBe(
      false,
    );
  });

  it("does not supersede requested items when finalize has no nextSteps", () => {
    const { store, root, projectId } = createTrackedProject("Outstanding no-nextSteps fixture");
    const source = finalize(store, root, "outstanding-no-nextSteps-source", [
      "Remain pending without a replacement",
      "Remain pending with empty nextSteps",
    ]);
    if (source.outcome !== "finalized") throw new Error("Expected source Session.");
    const absent = findOutstandingItem(store, projectId, "Remain pending without a replacement");
    const empty = findOutstandingItem(store, projectId, "Remain pending with empty nextSteps");
    const beforeEvents = store.exportProjectData({ type: "project", projectId }).tables.outstanding_item_events;

    const withoutWorkSummary = finalize(store, root, "outstanding-no-nextSteps-absent", [], undefined, undefined, {
      omitWorkSummary: true,
      supersededOutstandingItemIds: [absent.id],
    });
    const withEmptyNextSteps = finalize(store, root, "outstanding-no-nextSteps-empty", [], undefined, undefined, {
      supersededOutstandingItemIds: [empty.id],
    });
    expect(withoutWorkSummary).toMatchObject({
      outcome: "finalized",
      supersededOutstandingItemIds: [],
      outstandingItemWarnings: { unsupersededIds: [absent.id] },
    });
    expect(withEmptyNextSteps).toMatchObject({
      outcome: "finalized",
      supersededOutstandingItemIds: [],
      outstandingItemWarnings: { unsupersededIds: [empty.id] },
    });

    const after = store.exportProjectData({ type: "project", projectId });
    expect(after.tables.outstanding_items.find((item) => item.id === absent.id)?.status).toBe("pending");
    expect(after.tables.outstanding_items.find((item) => item.id === empty.id)?.status).toBe("pending");
    expect(after.tables.outstanding_item_events.filter((event) => event.to_status === "not_needed")).toEqual(
      beforeEvents.filter((event) => event.to_status === "not_needed"),
    );
  });

  it("recovers completed and superseded IDs from audit on idempotent finalize retries", () => {
    const { store, root, projectId } = createTrackedProject("Outstanding retry fixture");
    const source = finalize(store, root, "outstanding-retry-source", [
      "Confirm retried completion",
      "Replace retried obsolete task",
      "Leave this retry item pending",
    ]);
    if (source.outcome !== "finalized") throw new Error("Expected source Session.");
    const resolved = findOutstandingItem(store, projectId, "Confirm retried completion");
    const superseded = findOutstandingItem(store, projectId, "Replace retried obsolete task");
    const stillPending = findOutstandingItem(store, projectId, "Leave this retry item pending");
    const actorKey = "outstanding-retry-finalize";
    const first = finalize(store, root, actorKey, ["Replacement created on first finalize"], [resolved.id], undefined, {
      supersededOutstandingItemIds: [superseded.id],
    });
    expect(first.outcome).toBe("finalized");
    if (first.outcome !== "finalized") throw new Error("Expected first finalize result.");
    const afterFirst = store.exportProjectData({ type: "project", projectId }).tables.outstanding_item_events;

    const retry = finalize(store, root, actorKey, ["Ignored retry replacement"], [stillPending.id], undefined, {
      supersededOutstandingItemIds: [stillPending.id],
    });
    expect(retry).toMatchObject({
      outcome: "finalized",
      duplicate: true,
      resolvedOutstandingItemIds: [resolved.id],
      supersededOutstandingItemIds: [superseded.id],
    });
    expect(store.exportProjectData({ type: "project", projectId }).tables.outstanding_item_events).toEqual(afterFirst);
    expect(store.listOutstandingItems({ projectId, status: "pending", pageSize: 0 })).toMatchObject({
      outcome: "outstanding_items",
      items: expect.arrayContaining([expect.objectContaining({ id: stillPending.id, status: "pending" })]),
    });
  });

  it("rolls back both finalize transitions and audit rows when superseded audit insertion fails", () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-outstanding-finalize-rollback-"));
    tempDirs.push(root);
    const store = new WorkIntelligenceStore(join(root, "store.sqlite"));
    stores.push(store);
    const project = store.addProject("Outstanding finalize rollback fixture", root);
    store.updateProject(project.id, { status: "tracked" });
    const source = finalize(store, root, "outstanding-finalize-rollback-source", [
      "Rollback resolved member",
      "Rollback superseded member",
    ]);
    if (source.outcome !== "finalized") throw new Error("Expected source Session.");
    const resolved = findOutstandingItem(store, project.id, "Rollback resolved member");
    const superseded = findOutstandingItem(store, project.id, "Rollback superseded member");
    const before = store.exportProjectData({ type: "project", projectId: project.id }).tables;

    const sabotage = new DatabaseSync(store.databasePath);
    try {
      sabotage.exec(
        `CREATE TRIGGER fail_agent_superseded_event BEFORE INSERT ON outstanding_item_events
         WHEN NEW.source = 'agent' AND NEW.to_status = 'not_needed'
         BEGIN SELECT RAISE(ABORT, 'synthetic superseded audit failure'); END;`,
      );
    } finally {
      sabotage.close();
    }

    expect(() =>
      finalize(
        store,
        root,
        "outstanding-finalize-rollback-actor",
        ["New rollback follow-up"],
        [resolved.id],
        undefined,
        {
          supersededOutstandingItemIds: [superseded.id],
        },
      ),
    ).toThrow();
    expect(store.getSessionByIdempotencyKey("outstanding-finalize-rollback-actor")).toBeUndefined();
    expect(store.exportProjectData({ type: "project", projectId: project.id }).tables).toEqual(before);
  });

  it("records web status changes including reopening, skips no-op audits, and policy-gates project reads", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T00:00:00.000Z"));
    const { store, root, projectId } = createTrackedProject("Outstanding status fixture");
    const result = finalize(store, root, "outstanding-status-source", ["Reopen me"]);
    if (result.outcome !== "finalized") throw new Error("Expected Session.");
    const list = store.listOutstandingItems({ projectId });
    if (list.outcome !== "outstanding_items") throw new Error("Expected list.");
    const item = list.items[0];
    if (!item) throw new Error("Expected one item.");

    vi.setSystemTime(new Date("2026-09-22T00:00:01.000Z"));
    expect(store.updateOutstandingItemStatus(item.id, "completed")).toMatchObject({
      outcome: "outstanding_item_updated",
      duplicate: false,
    });
    expect(store.updateOutstandingItemStatus(item.id, "completed")).toMatchObject({
      outcome: "outstanding_item_updated",
      duplicate: true,
    });
    vi.setSystemTime(new Date("2026-09-22T00:00:02.000Z"));
    expect(store.updateOutstandingItemStatus(item.id, "pending")).toMatchObject({
      outcome: "outstanding_item_updated",
      duplicate: false,
    });
    const bundle = store.exportProjectData({ type: "project", projectId });
    expect(bundle.tables.outstanding_item_events.filter((event) => event.item_id === item.id)).toEqual([
      expect.objectContaining({ from_status: null, to_status: "pending", source: "agent" }),
      expect.objectContaining({ from_status: "pending", to_status: "completed", source: "web" }),
      expect.objectContaining({ from_status: "completed", to_status: "pending", source: "web" }),
    ]);
    store.updateProject(projectId, { status: "paused" });
    expect(store.listOutstandingItems({ projectId })).toMatchObject({ outcome: "skipped", projectStatus: "paused" });
    expect(store.updateOutstandingItemStatus(item.id, "not_needed")).toMatchObject({
      outcome: "skipped",
      projectStatus: "paused",
    });
  });

  it("does not change status or append audit history after the source Session is voided", () => {
    const { store, root, projectId } = createTrackedProject("Outstanding voided source fixture");
    const result = finalize(store, root, "outstanding-voided-source", ["Keep pending after void"]);
    if (result.outcome !== "finalized") throw new Error("Expected Session.");
    const items = store.listOutstandingItems({ projectId, pageSize: 0 });
    if (items.outcome !== "outstanding_items") throw new Error("Expected outstanding items.");
    const item = items.items[0];
    if (!item) throw new Error("Expected one outstanding item.");
    const beforeEvents = store.exportProjectData({ type: "project", projectId }).tables.outstanding_item_events;

    store.setSessionVoid({ sessionId: result.session.id, voided: true, reason: "Synthetic source correction." });

    const agentFinalize = finalize(store, root, "outstanding-voided-source-resolution", [], [item.id]);
    expect(agentFinalize).toMatchObject({
      outcome: "finalized",
      outstandingItemWarnings: { unresolvedIds: [item.id] },
    });

    expect(store.updateOutstandingItemStatus(item.id, "completed", "web")).toEqual({
      outcome: "not_found",
      itemId: item.id,
    });
    const after = store.exportProjectData({ type: "project", projectId });
    expect(after.tables.outstanding_items.find((row) => row.id === item.id)?.status).toBe("pending");
    expect(after.tables.outstanding_item_events).toEqual(beforeEvents);
  });

  it("updates a batch atomically, skips duplicate audits, and supports undo", () => {
    const { store, root, projectId } = createTrackedProject("Outstanding batch success fixture");
    const result = finalize(store, root, "outstanding-batch-success", ["Batch alpha", "Batch beta"]);
    if (result.outcome !== "finalized") throw new Error("Expected source Session.");
    const initial = store.listOutstandingItems({ projectId, pageSize: 0 });
    if (initial.outcome !== "outstanding_items") throw new Error("Expected outstanding items.");
    const itemIds = initial.items.map((item) => item.id);
    const beforeEvents = store.exportProjectData({ type: "project", projectId }).tables.outstanding_item_events;

    const updated = store.batchUpdateOutstandingItemStatus({ itemIds, status: "completed" });
    expect(updated).toMatchObject({
      outcome: "outstanding_items_updated",
      duplicate: false,
      updatedItemIds: expect.arrayContaining(itemIds),
    });
    expect(updated.outcome === "outstanding_items_updated" ? updated.items.map((item) => item.status) : []).toEqual([
      "completed",
      "completed",
    ]);

    const afterUpdateEvents = store.exportProjectData({ type: "project", projectId }).tables.outstanding_item_events;
    expect(afterUpdateEvents).toHaveLength(beforeEvents.length + itemIds.length);
    expect(
      afterUpdateEvents.filter((event) => typeof event.item_id === "string" && itemIds.includes(event.item_id)),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from_status: "pending", to_status: "completed", source: "web" }),
      ]),
    );

    expect(store.batchUpdateOutstandingItemStatus({ itemIds, status: "completed" })).toMatchObject({
      outcome: "outstanding_items_updated",
      duplicate: true,
    });
    expect(store.exportProjectData({ type: "project", projectId }).tables.outstanding_item_events).toHaveLength(
      afterUpdateEvents.length,
    );

    const undone = store.batchUpdateOutstandingItemStatus({
      itemIds,
      status: "pending",
      expectedStatus: "completed",
    });
    expect(undone).toMatchObject({
      outcome: "outstanding_items_updated",
      duplicate: false,
      updatedItemIds: expect.arrayContaining(itemIds),
    });
    const afterUndo = store.exportProjectData({ type: "project", projectId }).tables.outstanding_item_events;
    expect(
      afterUndo.filter((event) => typeof event.item_id === "string" && itemIds.includes(event.item_id)),
    ).toHaveLength(itemIds.length * 3);
    expect(afterUndo).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from_status: "completed", to_status: "pending", source: "web" }),
      ]),
    );
  });

  it("rejects malformed batches and accepts the 100-item limit", () => {
    const { store, root, projectId } = createTrackedProject("Outstanding batch limit fixture");
    const itemIds: string[] = [];
    for (let sessionIndex = 0; sessionIndex < 5; sessionIndex += 1) {
      const result = finalize(
        store,
        root,
        `outstanding-batch-limit-${sessionIndex}`,
        Array.from({ length: 20 }, (_, itemIndex) => `Limit item ${sessionIndex}-${itemIndex}`),
      );
      if (result.outcome !== "finalized") throw new Error("Expected source Session.");
    }
    const listed = store.listOutstandingItems({ projectId, pageSize: 0 });
    if (listed.outcome !== "outstanding_items") throw new Error("Expected outstanding items.");
    itemIds.push(...listed.items.map((item) => item.id));
    expect(itemIds).toHaveLength(100);

    expect(store.batchUpdateOutstandingItemStatus({ itemIds: [], status: "completed" })).toMatchObject({
      outcome: "rejected",
      reason: "invalid_batch",
    });
    expect(
      store.batchUpdateOutstandingItemStatus({ itemIds: [itemIds[0]!, itemIds[0]!], status: "completed" }),
    ).toMatchObject({
      outcome: "rejected",
      reason: "invalid_batch",
    });
    expect(
      store.batchUpdateOutstandingItemStatus({
        itemIds: Array.from({ length: 101 }, (_, index) => `batch-limit-${index}`),
        status: "completed",
      }),
    ).toMatchObject({ outcome: "rejected", reason: "invalid_batch" });

    const atLimit = store.batchUpdateOutstandingItemStatus({ itemIds, status: "completed" });
    expect(atLimit).toMatchObject({ outcome: "outstanding_items_updated", duplicate: false });
    expect(atLimit.outcome === "outstanding_items_updated" ? atLimit.updatedItemIds : []).toHaveLength(100);
  });

  it("rejects status conflicts and missing or voided members without partial changes", () => {
    const { store, root, projectId } = createTrackedProject("Outstanding batch rejection fixture");
    const result = finalize(store, root, "outstanding-batch-rejection", ["Pending member", "Completed member"]);
    if (result.outcome !== "finalized") throw new Error("Expected source Session.");
    const initial = store.listOutstandingItems({ projectId, pageSize: 0 });
    if (initial.outcome !== "outstanding_items") throw new Error("Expected outstanding items.");
    const pending = initial.items.find((item) => item.text === "Pending member");
    const completed = initial.items.find((item) => item.text === "Completed member");
    if (!pending || !completed) throw new Error("Expected both members.");
    store.updateOutstandingItemStatus(completed.id, "completed", "web");

    const beforeConflict = store.exportProjectData({ type: "project", projectId }).tables;
    expect(
      store.batchUpdateOutstandingItemStatus({
        itemIds: [pending.id, completed.id],
        status: "completed",
        expectedStatus: "pending",
      }),
    ).toMatchObject({ outcome: "rejected", reason: "status_conflict" });
    expect(store.exportProjectData({ type: "project", projectId }).tables).toEqual(beforeConflict);

    const voidedSource = finalize(store, root, "outstanding-batch-voided-source", ["Voided member"]);
    if (voidedSource.outcome !== "finalized") throw new Error("Expected voidable source Session.");
    const voidedList = store.listOutstandingItems({ projectId, pageSize: 0 });
    if (voidedList.outcome !== "outstanding_items") throw new Error("Expected outstanding items.");
    const voided = voidedList.items.find((item) => item.text === "Voided member");
    if (!voided) throw new Error("Expected the voided member.");
    store.setSessionVoid({ sessionId: voidedSource.session.id, voided: true, reason: "Synthetic source correction." });
    const beforeInvalid = store.exportProjectData({ type: "project", projectId }).tables;

    expect(
      store.batchUpdateOutstandingItemStatus({
        itemIds: [pending.id, voided.id, "missing-outstanding-item"],
        status: "completed",
      }),
    ).toMatchObject({
      outcome: "rejected",
      reason: "invalid_items",
      invalidItemIds: expect.arrayContaining([voided.id, "missing-outstanding-item"]),
    });
    expect(store.exportProjectData({ type: "project", projectId }).tables).toEqual(beforeInvalid);
  });

  it("skips an entire batch when one member belongs to a paused project", () => {
    const first = createTrackedProject("Outstanding batch tracked fixture");
    const secondRoot = mkdtempSync(join(tmpdir(), "work-intelligence-outstanding-batch-paused-"));
    tempDirs.push(secondRoot);
    const pausedProject = first.store.addProject("Outstanding batch paused fixture", secondRoot);
    first.store.updateProject(pausedProject.id, { status: "tracked" });
    const trackedSource = finalize(first.store, first.root, "outstanding-batch-tracked-source", ["Tracked member"]);
    const pausedSource = finalize(first.store, secondRoot, "outstanding-batch-paused-source", ["Paused member"]);
    if (trackedSource.outcome !== "finalized" || pausedSource.outcome !== "finalized") {
      throw new Error("Expected both source Sessions.");
    }
    const listed = first.store.listOutstandingItems({ pageSize: 0 });
    if (listed.outcome !== "outstanding_items") throw new Error("Expected outstanding items.");
    const tracked = listed.items.find((item) => item.text === "Tracked member");
    const paused = listed.items.find((item) => item.text === "Paused member");
    if (!tracked || !paused) throw new Error("Expected both members.");
    const before = first.store.exportProjectData({ type: "project", projectId: tracked.projectId }).tables;
    first.store.updateProject(pausedProject.id, { status: "paused" });

    expect(
      first.store.batchUpdateOutstandingItemStatus({ itemIds: [tracked.id, paused.id], status: "completed" }),
    ).toMatchObject({ outcome: "skipped", projectStatus: "paused" });
    expect(first.store.exportProjectData({ type: "project", projectId: tracked.projectId }).tables).toEqual(before);
  });

  it("filters outstanding items by inclusive source-Session calendar dates", () => {
    const { store, root, projectId } = createTrackedProject("Outstanding date-range fixture");
    const before = localCalendarDay(-5);
    const from = localCalendarDay(-4);
    const to = localCalendarDay(-2);
    const after = localCalendarDay(-1);
    for (const [key, text, day] of [
      ["before", "Outside before", before],
      ["from", "Inclusive start day", from],
      ["to", "Inclusive end day", to],
      ["after", "Outside after", after],
    ] as const) {
      const result = finalize(store, root, `outstanding-date-${key}`, [text], undefined, day.completedAt);
      if (result.outcome !== "finalized") throw new Error("Expected source Session.");
    }
    const historical = new Date();
    historical.setFullYear(50, 5, 15);
    historical.setHours(12, 0, 0, 0);
    const historicalResult = finalize(
      store,
      root,
      "outstanding-date-historical",
      ["Historical year 0050"],
      undefined,
      historical.toISOString(),
    );
    if (historicalResult.outcome !== "finalized") throw new Error("Expected historical source Session.");

    const filtered = store.listOutstandingItems({ from: from.date, to: to.date, projectId, pageSize: 0 });
    expect(filtered.outcome).toBe("outstanding_items");
    if (filtered.outcome !== "outstanding_items") throw new Error("Expected date-filtered outstanding items.");
    expect(filtered.items.map((item) => item.text).sort()).toEqual(["Inclusive end day", "Inclusive start day"]);
    expect(filtered.pageInfo.total).toBe(2);

    const historicalDay = store.listOutstandingItems({ from: "0050-06-15", to: "0050-06-15", projectId, pageSize: 0 });
    expect(historicalDay.outcome).toBe("outstanding_items");
    if (historicalDay.outcome !== "outstanding_items") throw new Error("Expected historical date-filtered items.");
    expect(historicalDay.items.map((item) => item.text)).toEqual(["Historical year 0050"]);

    const fullRange = store.listOutstandingItems({ from: "0001-01-01", to: "9999-12-31", projectId, pageSize: 0 });
    expect(fullRange.outcome).toBe("outstanding_items");
    if (fullRange.outcome !== "outstanding_items") throw new Error("Expected full-range date-filtered items.");
    expect(fullRange.items.map((item) => item.text).sort()).toEqual(
      ["Outside before", "Inclusive start day", "Inclusive end day", "Outside after", "Historical year 0050"].sort(),
    );
    expect(fullRange.pageInfo.total).toBe(5);
  });

  it("rolls back every status and audit when one batch audit insert fails", () => {
    const root = mkdtempSync(join(tmpdir(), "work-intelligence-outstanding-batch-rollback-"));
    tempDirs.push(root);
    const store = new WorkIntelligenceStore(join(root, "store.sqlite"));
    stores.push(store);
    const project = store.addProject("Outstanding batch rollback fixture", root);
    store.updateProject(project.id, { status: "tracked" });
    const result = finalize(store, root, "outstanding-batch-rollback", [
      "First rollback member",
      "Second rollback member",
    ]);
    if (result.outcome !== "finalized") throw new Error("Expected source Session.");
    const listed = store.listOutstandingItems({ projectId: project.id, pageSize: 0 });
    if (listed.outcome !== "outstanding_items") throw new Error("Expected outstanding items.");
    const ids = listed.items.map((item) => item.id);
    const before = store.exportProjectData({ type: "project", projectId: project.id }).tables;

    const sabotage = new DatabaseSync(store.databasePath);
    try {
      sabotage.exec(
        `CREATE TRIGGER reject_outstanding_batch_audit BEFORE INSERT ON outstanding_item_events
         WHEN NEW.item_id = '${ids[1]}' AND NEW.to_status = 'completed'
         BEGIN SELECT RAISE(ABORT, 'synthetic outstanding batch audit failure'); END;`,
      );
    } finally {
      sabotage.close();
    }

    expect(() => store.batchUpdateOutstandingItemStatus({ itemIds: ids, status: "completed" })).toThrow();
    expect(store.exportProjectData({ type: "project", projectId: project.id }).tables).toEqual(before);
  });

  it("blocks workSummary synchronization and idempotent retries for a voided source Session", () => {
    const { store, root, projectId } = createTrackedProject("Outstanding voided workSummary fixture");
    const result = finalize(store, root, "outstanding-voided-work-summary", ["Keep pending", "Remove after void"]);
    if (result.outcome !== "finalized") throw new Error("Expected Session.");
    const existingUpdate = {
      sessionId: result.session.id,
      idempotencyKey: "outstanding-voided-work-summary-retry",
      mode: "patch" as const,
      workSummary: { outcomes: ["Saved before the source was voided."] },
    };
    expect(store.updateSessionWorkSummary(existingUpdate).outcome).toBe("work_summary_updated");

    store.setSessionVoid({ sessionId: result.session.id, voided: true, reason: "Synthetic source correction." });
    const before = store.exportProjectData({ type: "project", projectId });

    expect(store.updateSessionWorkSummary(existingUpdate)).toMatchObject({
      outcome: "skipped",
      sessionId: result.session.id,
      projectStatus: "tracked",
    });
    expect(
      store.updateSessionWorkSummary({
        sessionId: result.session.id,
        idempotencyKey: "outstanding-voided-work-summary-remove",
        mode: "patch",
        workSummary: { nextSteps: [] },
      }),
    ).toMatchObject({
      outcome: "skipped",
      sessionId: result.session.id,
      projectStatus: "tracked",
    });

    const after = store.exportProjectData({ type: "project", projectId });
    expect(after.tables.outstanding_items).toEqual(before.tables.outstanding_items);
    expect(after.tables.outstanding_item_events).toEqual(before.tables.outstanding_item_events);
  });

  it("ranks direct text, changed paths, and recalled source items beyond the recall window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T00:00:00.000Z"));
    const { store, root, projectId } = createTrackedProject("Outstanding relevance fixture");
    const directSource = finalize(
      store,
      root,
      "outstanding-relevance-direct",
      ["Aster cache direct repair"],
      undefined,
      undefined,
      {
        title: "Legacy checklist",
        summary: "An older maintenance note without task details.",
      },
    );
    if (directSource.outcome !== "finalized") throw new Error("Expected direct-match source Session.");
    const directItem = findOutstandingItem(store, projectId, "Aster cache direct repair");

    vi.setSystemTime(new Date("2026-09-01T00:00:01.000Z"));
    const pathSource = finalize(
      store,
      root,
      "outstanding-relevance-path",
      ["Review nearby worker contract"],
      undefined,
      undefined,
      {
        title: "Legacy file inspection",
        summary: "An earlier review of a shared module.",
        changedFiles: ["packages/shared/src/lease.ts"],
      },
    );
    if (pathSource.outcome !== "finalized") throw new Error("Expected path-match source Session.");
    const pathItem = findOutstandingItem(store, projectId, "Review nearby worker contract");

    for (let index = 0; index < 21; index += 1) {
      vi.setSystemTime(new Date(`2026-09-01T00:00:${String(index + 2).padStart(2, "0")}.000Z`));
      const noise = finalize(store, root, `outstanding-relevance-noise-${index}`, [], undefined, undefined, {
        title: `Aster cache unrelated entry ${index}`,
        summary: `An unrelated recent record mentioning Aster cache ${index}.`,
      });
      if (noise.outcome !== "finalized") throw new Error("Expected unrelated recent Session.");
    }

    vi.setSystemTime(new Date("2026-09-01T00:01:00.000Z"));
    const sourceA = finalize(
      store,
      root,
      "outstanding-relevance-source-a",
      ["Review worker behavior A"],
      undefined,
      undefined,
      {
        title: "Aster cache implementation",
        summary: "Aster cache implementation notes.",
      },
    );
    vi.setSystemTime(new Date("2026-09-01T00:01:01.000Z"));
    const sourceB = finalize(
      store,
      root,
      "outstanding-relevance-source-b",
      ["Review worker behavior B"],
      undefined,
      undefined,
      {
        title: "Aster cache implementation",
        summary: "Aster cache implementation notes.",
      },
    );
    if (sourceA.outcome !== "finalized" || sourceB.outcome !== "finalized") {
      throw new Error("Expected recalled source Sessions.");
    }
    const sourceItemA = findOutstandingItem(store, projectId, "Review worker behavior A");
    const sourceItemB = findOutstandingItem(store, projectId, "Review worker behavior B");

    const recall = store.recall({ q: "Aster cache", projectRoot: root, limit: 20 });
    expect(recall.outcome).toBe("recall");
    if (recall.outcome !== "recall") throw new Error("Expected focused recall.");
    expect(recall.hits.map((hit) => hit.id)).not.toContain(directSource.session.id);

    const context = store.getContext(root, { task: "Aster cache", paths: ["packages/shared/src/lease.ts"] });
    expect(context.outcome).toBe("context");
    if (context.outcome !== "context") throw new Error("Expected focused context.");
    const related = context.relevant?.outstandingItems;
    expect(related).toMatchObject({ total: 4, omitted: 0 });
    if (!related) throw new Error("Expected related outstanding item digest.");
    expect(related.items.map((item) => item.id)).toEqual(
      expect.arrayContaining([directItem.id, pathItem.id, sourceItemA.id, sourceItemB.id]),
    );
    const relatedIds = related.items.map((item) => item.id);
    expect(relatedIds.indexOf(pathItem.id)).toBeLessThan(relatedIds.indexOf(directItem.id));
    expect(relatedIds.indexOf(directItem.id)).toBeLessThan(
      Math.min(relatedIds.indexOf(sourceItemA.id), relatedIds.indexOf(sourceItemB.id)),
    );

    const relevantContext = context.relevant;
    if (!relevantContext) throw new Error("Expected relevant context.");
    const recalledSourceOrder = relevantContext.sessions
      .filter((hit) => [sourceA.session.id, sourceB.session.id].includes(hit.id))
      .map((hit) => hit.id);
    expect(
      related.items
        .filter((item) => [sourceA.session.id, sourceB.session.id].includes(item.sourceSessionId))
        .map((item) => item.sourceSessionId),
    ).toEqual(recalledSourceOrder);
  });

  it("matches Chinese item keywords and does not return unrelated items", () => {
    const { store, root, projectId } = createTrackedProject("Outstanding Chinese relevance fixture");
    const result = finalize(store, root, "outstanding-chinese-relevance", ["修復權限稽核流程"]);
    if (result.outcome !== "finalized") throw new Error("Expected Chinese relevance source Session.");
    const chineseItem = findOutstandingItem(store, projectId, "修復權限稽核流程");
    const unrelated = finalize(store, root, "outstanding-chinese-unrelated", ["整理其他介面細節"]);
    if (unrelated.outcome !== "finalized") throw new Error("Expected unrelated source Session.");

    const matched = store.getContext(root, { task: "權限稽核" });
    expect(matched.outcome).toBe("context");
    if (matched.outcome !== "context") throw new Error("Expected Chinese focused context.");
    expect(matched.relevant?.outstandingItems).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ id: chineseItem.id })],
    });

    const unmatched = store.getContext(root, { task: "天氣預報" });
    expect(unmatched.outcome).toBe("context");
    if (unmatched.outcome !== "context") throw new Error("Expected unmatched focused context.");
    expect(unmatched.relevant?.outstandingItems).toMatchObject({ items: [], total: 0, omitted: 0 });
  });

  it("limits related digests to five, filters ineligible scope and statuses, and fits the task budget", () => {
    const { store, root, projectId } = createTrackedProject("Outstanding digest bound fixture");
    const manyLongItems = Array.from(
      { length: 9 },
      (_, index) => `Quartz ledger entry ${index}: ${"supporting detail ".repeat(80)}`,
    );
    const longTitle = `Quartz ledger maintenance ${"session title ".repeat(15)}`;
    const activeSource = finalize(store, root, "outstanding-digest-long-source", manyLongItems, undefined, undefined, {
      title: longTitle,
      summary: "A long historical entry for the Quartz ledger.",
    });
    if (activeSource.outcome !== "finalized") throw new Error("Expected long source Session.");
    const initialItems = store.listOutstandingItems({ projectId, pageSize: 0 });
    if (initialItems.outcome !== "outstanding_items") throw new Error("Expected long pending items.");
    const completedItem = initialItems.items.find((item) => item.text.startsWith("Quartz ledger entry 0:"));
    const notNeededItem = initialItems.items.find((item) => item.text.startsWith("Quartz ledger entry 1:"));
    if (!completedItem || !notNeededItem) throw new Error("Expected terminal-status digest fixtures.");
    store.updateOutstandingItemStatus(completedItem.id, "completed");
    store.updateOutstandingItemStatus(notNeededItem.id, "not_needed");

    const voidedSource = finalize(store, root, "outstanding-digest-voided-source", ["Quartz ledger voided item"]);
    if (voidedSource.outcome !== "finalized") throw new Error("Expected voided source Session.");
    const voidedItem = findOutstandingItem(store, projectId, "Quartz ledger voided item");
    store.setSessionVoid({ sessionId: voidedSource.session.id, voided: true, reason: "Synthetic source correction." });

    const pausedRoot = mkdtempSync(join(tmpdir(), "work-intelligence-outstanding-digest-paused-"));
    tempDirs.push(pausedRoot);
    const pausedProject = store.addProject("Outstanding digest paused fixture", pausedRoot);
    store.updateProject(pausedProject.id, { status: "tracked" });
    const pausedSource = finalize(store, pausedRoot, "outstanding-digest-paused-source", ["Quartz ledger paused item"]);
    if (pausedSource.outcome !== "finalized") throw new Error("Expected paused candidate source Session.");
    const pausedItem = findOutstandingItem(store, pausedProject.id, "Quartz ledger paused item");
    store.updateProject(pausedProject.id, { status: "paused" });

    const longPaths = Array.from(
      { length: 20 },
      (_, index) => `packages/context-budget/${index}-${"segment".repeat(35)}.ts`,
    );
    const context = store.getContext(root, { task: "Quartz ledger", paths: longPaths });
    expect(context.outcome).toBe("context");
    if (context.outcome !== "context") throw new Error("Expected bounded focused context.");
    const related = context.relevant?.outstandingItems;
    expect(related).toBeDefined();
    if (!related) throw new Error("Expected related digest.");
    expect(related.total).toBe(7);
    expect(related.items.length).toBeLessThanOrEqual(5);
    expect(related.omitted).toBe(related.total - related.items.length);
    expect(related.items.length).toBeLessThan(5);
    expect(related.items.every((item) => item.text.length <= 400 && item.textTruncated)).toBe(true);
    expect(
      related.items.every((item) => item.sourceSessionTitle.length <= 160 && item.sourceSessionTitleTruncated),
    ).toBe(true);
    expect(related.items.map((item) => item.id)).not.toContain(completedItem.id);
    expect(related.items.map((item) => item.id)).not.toContain(notNeededItem.id);
    expect(related.items.map((item) => item.id)).not.toContain(voidedItem.id);
    expect(related.items.map((item) => item.id)).not.toContain(pausedItem.id);
    expect(JSON.stringify(context).length).toBeLessThan(10_000);
    expect(context.omitted).toEqual(
      expect.arrayContaining([expect.objectContaining({ section: "relevant.outstandingItems" })]),
    );
  });

  it("bounds context items, reports truncation and omission, and links the read operation", () => {
    const { store, root } = createTrackedProject("Outstanding context fixture");
    const longItems = Array.from({ length: 6 }, (_, index) => `Pending item ${index + 1}: ${"details ".repeat(450)}`);
    const result = finalize(store, root, "outstanding-context-source", longItems);
    expect(result.outcome).toBe("finalized");
    if (result.outcome !== "finalized") throw new Error("Expected source Session.");
    const context = store.getContext(root);
    expect(context.outcome).toBe("context");
    if (context.outcome !== "context") throw new Error("Expected context.");
    expect(context.pendingOutstandingItems).toHaveLength(5);
    expect(context.pendingOutstandingItemsTotal).toBe(6);
    expect(context.pendingOutstandingItemsOmitted).toBe(1);
    expect(context.pendingOutstandingItemsTruncated).toBe(5);
    expect(context.pendingOutstandingItemsOmitted + context.pendingOutstandingItems.length).toBe(
      context.pendingOutstandingItemsTotal,
    );
    expect(
      context.pendingOutstandingItems.every(
        (item) => item.status === "pending" && item.sourceSessionId === result.session.id,
      ),
    ).toBe(true);
    expect(context.pendingOutstandingItems.every((item) => item.text.length <= 500 && item.textTruncated)).toBe(true);
    expect(context.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ section: "pendingOutstandingItems", readWith: "work_list_outstanding_items" }),
      ]),
    );
    const outstandingOmission = context.omitted?.find((item) => item.section === "pendingOutstandingItems");
    expect(outstandingOmission?.count).toBe(
      context.pendingOutstandingItemsOmitted + context.pendingOutstandingItemsTruncated,
    );
    expect(outstandingOmission?.reasons).toContain("待結項省略 1 筆，文字截短 5 筆");
    expect(JSON.stringify(context).length).toBeLessThan(16_000);
  });
});
