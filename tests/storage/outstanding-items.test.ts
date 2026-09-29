import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
  });
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
