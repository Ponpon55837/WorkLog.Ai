import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

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
) {
  return store.finalizeSession({
    projectRoot: root,
    idempotencyKey,
    title: idempotencyKey,
    summary: `已完成 ${idempotencyKey} 的測試工作。`,
    changedFiles: [],
    verification: { status: "passed" },
    workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps },
    resolvedOutstandingItemIds,
    completedAt,
  });
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

    const filtered = store.listOutstandingItems({ from: from.date, to: to.date, projectId, pageSize: 0 });
    expect(filtered.outcome).toBe("outstanding_items");
    if (filtered.outcome !== "outstanding_items") throw new Error("Expected date-filtered outstanding items.");
    expect(filtered.items.map((item) => item.text).sort()).toEqual(["Inclusive end day", "Inclusive start day"]);
    expect(filtered.pageInfo.total).toBe(2);
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
