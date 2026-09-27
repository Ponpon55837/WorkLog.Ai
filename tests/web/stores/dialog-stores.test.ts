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
  vi.stubGlobal("window", { setTimeout });
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
});
