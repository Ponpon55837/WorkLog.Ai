import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStoreHarness } from "../helpers/store-harness.js";
import { useConfirmStore } from "../../../apps/web/src/stores/confirm.js";
import { useKnowledgeCandidateEditorStore } from "../../../apps/web/src/stores/knowledge-candidate-editor.js";
import { useKnowledgeEditorStore } from "../../../apps/web/src/stores/knowledge-editor.js";
import { useRecordVoidStore } from "../../../apps/web/src/stores/record-void.js";
import { toForm, useSessionEditorStore } from "../../../apps/web/src/stores/session-editor.js";
import { useSessionLinkDialogStore } from "../../../apps/web/src/stores/session-link-dialog.js";
import { useToastsStore } from "../../../apps/web/src/stores/toasts.js";

let harness: ReturnType<typeof createStoreHarness>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  harness = createStoreHarness();
});

afterEach(async () => {
  await harness.cleanup();
  vi.useRealTimers();
});

describe("dialog and form stores", () => {
  it("reset every dialog to its closed, empty state", () => {
    const knowledge = useKnowledgeEditorStore();
    knowledge.knowledgeEditorCreating = true;
    knowledge.knowledgeEditorForm.title = "Draft";
    expect(knowledge.knowledgeEditorOpen).toBe(true);
    knowledge.$reset();
    expect(knowledge.knowledgeEditorOpen).toBe(false);
    expect(knowledge.knowledgeEditorForm.title).toBe("");

    const candidate = useKnowledgeCandidateEditorStore();
    candidate.candidateError = "Oops";
    candidate.candidateForm.title = "Draft";
    candidate.$reset();
    expect([candidate.candidateError, candidate.candidateForm.title]).toEqual(["", ""]);

    const voiding = useRecordVoidStore();
    voiding.voidTarget = { type: "diagram", id: "d", sessionId: "s", title: "Flow" };
    voiding.voidReason = "Wrong";
    voiding.$reset();
    expect([voiding.voidTarget, voiding.voidReason]).toEqual([null, ""]);

    const editor = useSessionEditorStore();
    editor.sessionEditorForm.summary = "Changed";
    editor.$reset();
    expect(editor.sessionEditorForm).toEqual(toForm());
    expect(toForm().verificationStatus).toBe("not_supplied");

    const links = useSessionLinkDialogStore();
    links.linkQuery = "planning";
    links.linkDirection = "related";
    links.$reset();
    expect([links.linkQuery, links.linkDirection]).toEqual(["", "continues"]);
  });

  it("answers an open confirmation with no when a new one replaces it or the store resets", async () => {
    const confirm = useConfirmStore();
    const first = confirm.ask({ title: "First?" });
    const second = confirm.ask({ title: "Second?" });
    await expect(first).resolves.toBe(false);
    confirm.$reset();
    await expect(second).resolves.toBe(false);
    expect(confirm.pending).toBeNull();
    const third = confirm.ask({ title: "Third?" });
    confirm.settle(true);
    await expect(third).resolves.toBe(true);
  });

  it("keeps the newest toasts, dismisses them after a delay, and resets", () => {
    const toasts = useToastsStore();
    for (const index of [1, 2, 3, 4, 5]) toasts.showToast(`Toast ${index}`);
    expect(toasts.toasts.map((toast) => toast.message)).toEqual(["Toast 2", "Toast 3", "Toast 4", "Toast 5"]);
    vi.advanceTimersByTime(4_000);
    expect(toasts.toasts).toEqual([]);
    toasts.showToast("Again", "success");
    toasts.$reset();
    expect(toasts.toasts).toEqual([]);
  });

  it("keeps a toast with an action for 8 seconds and runs the action once before dismissing it", async () => {
    const toasts = useToastsStore();
    const undo = vi.fn();
    toasts.showToast("Marked as done", "success", { label: "Undo", run: undo });
    toasts.showToast("Plain");
    vi.advanceTimersByTime(4_000);
    expect(toasts.toasts.map((toast) => toast.message)).toEqual(["Marked as done"]);

    const [toast] = toasts.toasts;
    await toasts.runToastAction(toast!.id);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(toasts.toasts).toEqual([]);
    await toasts.runToastAction(toast!.id);
    expect(undo).toHaveBeenCalledTimes(1);

    toasts.showToast("Again", "success", { label: "Undo", run: undo });
    vi.advanceTimersByTime(8_000);
    expect(toasts.toasts).toEqual([]);
  });

  it("never evicts a toast with an action because of plain toasts, and caps each kind on its own", () => {
    const toasts = useToastsStore();
    const action = { label: "Undo", run: vi.fn() };
    toasts.showToast("Undoable", "success", action);
    for (const index of [1, 2, 3, 4, 5, 6]) toasts.showToast(`Plain ${index}`);
    expect(toasts.toasts.map((toast) => toast.message)).toEqual([
      "Undoable",
      "Plain 3",
      "Plain 4",
      "Plain 5",
      "Plain 6",
    ]);
    for (const index of [1, 2, 3, 4]) toasts.showToast(`Undoable ${index}`, "success", action);
    expect(toasts.toasts.filter((toast) => toast.action).map((toast) => toast.message)).toEqual([
      "Undoable 1",
      "Undoable 2",
      "Undoable 3",
      "Undoable 4",
    ]);
  });

  it("pauses a toast while it is hovered or focused and resumes it once both end", () => {
    const toasts = useToastsStore();
    toasts.showToast("Marked as done", "success", { label: "Undo", run: vi.fn() });
    const [toast] = toasts.toasts;

    vi.advanceTimersByTime(6_000);
    toasts.holdToast(toast!.id, "hover");
    toasts.holdToast(toast!.id, "focus");
    vi.advanceTimersByTime(60_000);
    expect(toasts.toasts).toHaveLength(1);

    toasts.releaseToast(toast!.id, "hover");
    vi.advanceTimersByTime(60_000);
    expect(toasts.toasts).toHaveLength(1);

    toasts.releaseToast(toast!.id, "focus");
    vi.advanceTimersByTime(1_999);
    expect(toasts.toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(toasts.toasts).toEqual([]);
  });
});
