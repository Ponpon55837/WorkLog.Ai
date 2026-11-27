import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDecisionReview } from "../../../apps/web/src/composables/useDecisionReview.js";
import { useConfirmStore } from "../../../apps/web/src/stores/confirm.js";
import { loadCatalog, locale, t } from "../../../apps/web/src/i18n/index.js";
import { createStoreHarness } from "../helpers/store-harness.js";

const showToast = vi.hoisted(() => vi.fn());

vi.mock("../../../apps/web/src/stores/projects", () => ({
  useProjectsStore: () => ({ projects: [{ id: "project-1", rootPath: "/work/orchard" }] }),
}));
vi.mock("../../../apps/web/src/composables/useToast", () => ({ useToast: () => ({ showToast }) }));

let harness: ReturnType<typeof createStoreHarness>;

const decision = (id: string) => ({ id, projectId: "project-1" });

function reviewCalls() {
  return harness.calls.filter((call) => call.url.pathname.endsWith("/review"));
}

async function answerConfirm(confirmed: boolean): Promise<void> {
  await vi.waitFor(() => expect(useConfirmStore().pending).not.toBeNull());
  useConfirmStore().settle(confirmed);
}

beforeEach(async () => {
  showToast.mockClear();
  await loadCatalog("en-US");
  locale.value = "en-US";
  harness = createStoreHarness(({ url }) =>
    url.pathname.endsWith("/review")
      ? { outcome: "session_decision_reviewed", decision: { id: "d", reviewStatus: "confirmed" }, duplicate: false }
      : { outcome: "session_decisions", items: [], pendingCount: 0 },
  );
});
afterEach(async () => harness.cleanup());

describe("useDecisionReview", () => {
  it("confirms immediately and offers no undo, since a human review cannot be reset", async () => {
    const { review } = useDecisionReview();

    await expect(review(decision("d1"), "confirmed")).resolves.toBe(true);

    expect(reviewCalls()).toHaveLength(1);
    expect(useConfirmStore().pending).toBeNull();
    expect(showToast).toHaveBeenCalledOnce();
    expect(showToast).toHaveBeenCalledWith(t("knowledge.agentAutonomousDecisionConfirmed"));
  });

  it("asks before rejecting and sends nothing when the question is declined", async () => {
    const { review } = useDecisionReview();

    const pending = review(decision("d1"), "rejected");
    await answerConfirm(false);

    await expect(pending).resolves.toBe(false);
    expect(reviewCalls()).toHaveLength(0);
  });

  it("rejects once the question is accepted", async () => {
    const { review } = useDecisionReview();

    const pending = review(decision("d1"), "rejected");
    expect(await vi.waitFor(() => useConfirmStore().pending?.title)).toBe(
      t("knowledge.rejectDecisionsTitle", { count: 1 }),
    );
    await answerConfirm(true);

    await expect(pending).resolves.toBe(true);
    expect(reviewCalls()[0]?.body).toEqual({ projectRoot: "/work/orchard", reviewStatus: "rejected" });
  });

  it("confirms a batch without a question and reports the count", async () => {
    const { reviewMany } = useDecisionReview();

    const done = await reviewMany([decision("d1"), decision("d2"), decision("d3")], "confirmed");

    expect(done).toEqual(expect.arrayContaining(["d1", "d2", "d3"]));
    expect(showToast).toHaveBeenCalledWith(t("knowledge.decisionsConfirmed", { count: 3 }), "success");
  });

  it("asks once for a whole rejected batch with its size", async () => {
    const { reviewMany } = useDecisionReview();

    const pending = reviewMany([decision("d1"), decision("d2")], "rejected");
    await vi.waitFor(() =>
      expect(useConfirmStore().pending?.title).toBe(t("knowledge.rejectDecisionsTitle", { count: 2 })),
    );
    await answerConfirm(false);

    await expect(pending).resolves.toEqual([]);
    expect(reviewCalls()).toHaveLength(0);
  });

  it("leaves a decision whose project is unknown out of the batch", async () => {
    const { reviewMany } = useDecisionReview();

    const done = await reviewMany([decision("d1"), { id: "d2", projectId: "gone" }], "confirmed");

    expect(done).toEqual(["d1"]);
  });
});
