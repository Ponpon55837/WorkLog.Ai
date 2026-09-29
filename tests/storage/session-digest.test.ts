import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutstandingItemService } from "../../packages/storage/src/outstanding-item-service.js";
import { toSessionDigests, WorkIntelligenceStore } from "../../packages/storage/src/index.js";

const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

function setup() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-session-digest-"));
  tempDirs.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject("Session digest fixture", root);
  store.updateProject(project.id, { status: "tracked" });
  return { store, root };
}

function finalize(store: WorkIntelligenceStore, root: string, key: string, nextSteps: string[]) {
  const result = store.finalizeSession({
    projectRoot: root,
    idempotencyKey: key,
    title: key,
    summary: `Synthetic digest fixture for ${key}.`,
    changedFiles: [],
    verification: { status: "passed" },
    workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps },
  });
  if (result.outcome !== "finalized") throw new Error("Expected a finalized synthetic Session.");
  return result.session;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Session digest open items", () => {
  it("uses only pending items and excludes items from voided source Sessions in a batch", () => {
    const { store, root } = setup();
    const completedText = "Old nextSteps text marked completed.";
    const notNeededText = "Old nextSteps text marked not needed.";
    const firstPendingText = "First still-pending item.";
    const secondPendingText = "Second still-pending item.";
    const otherPendingText = "Pending item from a different Session.";
    const voidedPendingText = "Pending item whose source was voided.";
    const source = finalize(store, root, "digest-status-source", [
      completedText,
      notNeededText,
      firstPendingText,
      secondPendingText,
    ]);
    const otherSource = finalize(store, root, "digest-status-other", [otherPendingText]);
    const voidedSource = finalize(store, root, "digest-status-voided", [voidedPendingText]);

    const allItems = store.listOutstandingItems({ status: "pending", pageSize: 0 });
    if (allItems.outcome !== "outstanding_items") throw new Error("Expected pending synthetic items.");
    const itemByText = new Map(allItems.items.map((item) => [item.text, item]));
    const completed = itemByText.get(completedText);
    const notNeeded = itemByText.get(notNeededText);
    if (!completed || !notNeeded) throw new Error("Expected terminal-state fixtures.");
    store.updateOutstandingItemStatus(completed.id, "completed");
    store.updateOutstandingItemStatus(notNeeded.id, "not_needed");
    store.setSessionVoid({ sessionId: voidedSource.id, voided: true, reason: "Synthetic source correction." });

    const sessions = store.listSessions({ voided: "include" });
    const pendingItems = store.pendingOutstandingItemsForSessions(sessions.map((session) => session.id));
    const digests = toSessionDigests(sessions, pendingItems);

    expect(digests.find((session) => session.id === source.id)?.openItems).toEqual([
      firstPendingText,
      secondPendingText,
    ]);
    expect(digests.find((session) => session.id === otherSource.id)?.openItems).toEqual([otherPendingText]);
    expect(digests.find((session) => session.id === voidedSource.id)?.openItems).toEqual([]);
    expect(pendingItems.some((item) => item.text === completedText || item.text === notNeededText)).toBe(false);
    expect(pendingItems.some((item) => item.text === voidedPendingText)).toBe(false);
    expect(toSessionDigests([], [])).toEqual([]);
  });

  it("uses a single pending-items batch for search digests", () => {
    const { store, root } = setup();
    const completedText = "A completed search follow-up.";
    const notNeededText = "A follow-up that is no longer needed.";
    const pendingText = "A follow-up that remains open.";
    const source = finalize(store, root, "openitemdigest-search-source", [completedText, notNeededText, pendingText]);
    const allItems = store.listOutstandingItems({ projectRoot: root, status: "pending", pageSize: 0 });
    if (allItems.outcome !== "outstanding_items") throw new Error("Expected synthetic outstanding items.");
    const itemByText = new Map(allItems.items.map((item) => [item.text, item]));
    const completed = itemByText.get(completedText);
    const notNeeded = itemByText.get(notNeededText);
    if (!completed || !notNeeded) throw new Error("Expected terminal-state fixtures.");
    store.updateOutstandingItemStatus(completed.id, "completed");
    store.updateOutstandingItemStatus(notNeeded.id, "not_needed");

    const pendingBatch = vi.spyOn(OutstandingItemService.prototype, "pendingForSessions");
    const result = store.searchForAgent("openitemdigest", root);
    expect(result.outcome).toBe("search");
    if (result.outcome !== "search") throw new Error("Expected the synthetic Session search to complete.");

    expect(result.hits.map((hit) => hit.session.id)).toContain(source.id);
    expect(pendingBatch).toHaveBeenCalledTimes(1);
    expect(pendingBatch).toHaveBeenCalledWith([source.id]);
    expect(result.hits.find((hit) => hit.session.id === source.id)?.session.openItems).toEqual([pendingText]);
  });
});
