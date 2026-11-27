import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeCandidateRequest } from "@work-intelligence/core";

const showToast = vi.fn();
let resolveCancel: (value: unknown) => void = () => undefined;
const store = {
  candidateRequesting: false,
  cancelKnowledgeCandidateRequest: vi.fn(() => new Promise((resolve) => (resolveCancel = resolve))),
};

vi.mock("../../../apps/web/src/stores/knowledge", () => ({ useKnowledgeStore: () => store }));
vi.mock("../../../apps/web/src/stores/knowledge-candidate-editor", () => ({
  useKnowledgeCandidateEditorStore: () => ({}),
}));
vi.mock("../../../apps/web/src/composables/useToast", () => ({ useToast: () => ({ showToast }) }));
vi.mock("pinia", async (importOriginal) => ({
  ...(await importOriginal<typeof import("pinia")>()),
  storeToRefs: () => ({}),
}));

const { useKnowledgeCandidates } = await import("../../../apps/web/src/composables/useKnowledgeCandidates");

function request(id: string): KnowledgeCandidateRequest {
  return { id, projectName: "Orchard" } as KnowledgeCandidateRequest;
}

describe("useKnowledgeCandidates stop", () => {
  beforeEach(() => {
    showToast.mockReset();
  });

  it("marks a request stopped before the list refresh can report it as submitted", async () => {
    const { cancelCandidateRequest, wasStoppedByUser } = useKnowledgeCandidates();
    const pending = cancelCandidateRequest(request("req-1"));
    expect(wasStoppedByUser("req-1")).toBe(true);
    resolveCancel({ outcome: "knowledge_candidate_request_cancelled" });
    await pending;
    expect(wasStoppedByUser("req-1")).toBe(true);
  });

  it("forgets the mark when the request could not be stopped", async () => {
    const { cancelCandidateRequest, wasStoppedByUser } = useKnowledgeCandidates();
    const pending = cancelCandidateRequest(request("req-2"));
    resolveCancel({ outcome: "request_not_open" });
    await pending;
    expect(wasStoppedByUser("req-2")).toBe(false);
    expect(showToast).toHaveBeenCalledWith(expect.any(String), "danger");
  });
});
