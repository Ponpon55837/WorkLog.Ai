import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSessionDecisionsStore } from "../../../apps/web/src/stores/session-decisions.js";
import { useWorkKnowledgePendingStore } from "../../../apps/web/src/stores/work-knowledge-pending.js";
import { createStoreHarness, jsonResponse, type StoreRequest } from "../helpers/store-harness.js";

let harness: ReturnType<typeof createStoreHarness>;

function reviewed(id: string) {
  return { outcome: "session_decision_reviewed", decision: { id, reviewStatus: "confirmed" }, duplicate: false };
}

function inputs(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    decisionId: `decision-${index}`,
    projectRoot: "/work/orchard",
    reviewStatus: "confirmed" as const,
  }));
}

beforeEach(() => {
  harness = createStoreHarness(({ url }: StoreRequest) => {
    if (url.pathname.endsWith("/review")) return reviewed(url.pathname.split("/")[3]!);
    return { outcome: "session_decisions", items: [], pendingCount: 0 };
  });
});
afterEach(async () => harness.cleanup());

describe("session decisions store batch review", () => {
  it("reviews every decision with at most four requests in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    harness.setResponder(async ({ url }) => {
      if (!url.pathname.endsWith("/review")) return { outcome: "session_decisions", items: [], pendingCount: 0 };
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return reviewed(url.pathname.split("/")[3]!);
    });

    const result = await useSessionDecisionsStore().reviewDecisions(inputs(10));

    expect(result.reviewedIds).toHaveLength(10);
    expect(result.failure).toBeUndefined();
    expect(peak).toBe(4);
    expect(
      harness.calls.filter((call) => call.url.pathname.endsWith("/review")).map((call) => call.body),
    ).toContainEqual({ projectRoot: "/work/orchard", reviewStatus: "confirmed" });
  });

  it("counts a decision the API no longer knows as skipped", async () => {
    harness.setResponder(({ url }) =>
      url.pathname === "/api/session-decisions/decision-1/review"
        ? { outcome: "not_found", decisionId: "decision-1" }
        : url.pathname.endsWith("/review")
          ? reviewed("x")
          : { outcome: "session_decisions", items: [], pendingCount: 0 },
    );

    const result = await useSessionDecisionsStore().reviewDecisions(inputs(3));

    expect(result.skippedIds).toEqual(["decision-1"]);
    expect(result.reviewedIds).toEqual(["decision-0", "decision-2"]);
  });

  it("stops starting new reviews after a failure and keeps what was already applied", async () => {
    harness.setResponder(({ url }) =>
      url.pathname === "/api/session-decisions/decision-1/review"
        ? jsonResponse({ error: "Server error.", code: "internal_error" }, 500)
        : url.pathname.endsWith("/review")
          ? reviewed("x")
          : { outcome: "session_decisions", items: [], pendingCount: 0 },
    );

    const result = await useSessionDecisionsStore().reviewDecisions(inputs(12));

    expect(result.failedIds).toEqual(["decision-1"]);
    expect(result.failure?.message).toBe("Server error.");
    expect(result.reviewedIds).toContain("decision-0");
    expect(harness.calls.filter((call) => call.url.pathname.endsWith("/review")).length).toBeLessThan(12);
  });

  it("refreshes the decision lists once for the whole run", async () => {
    const store = useSessionDecisionsStore();
    store.setListActive(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const before = harness.count("/api/session-decisions");

    await store.reviewDecisions(inputs(6));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(harness.count("/api/session-decisions") - before).toBe(1);
  });
});

describe("work knowledge pending store", () => {
  it("adds pending decisions and proposed candidates across all projects", async () => {
    harness.setResponder(({ url }) => {
      if (url.pathname === "/api/session-decisions")
        return { outcome: "session_decisions", items: [], pendingCount: 7 };
      return {
        outcome: "knowledge_candidates",
        items: [{ id: "c1" }, { id: "c2" }],
        openRequests: [],
        backlog: [],
      };
    });
    const store = useWorkKnowledgePendingStore();
    expect(store.pendingTotal).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(store.pendingTotal).toBe(9);
    const read = harness.calls.find((call) => call.url.pathname === "/api/session-decisions");
    expect(read?.url.searchParams.get("status")).toBe("pending");
    expect(read?.url.searchParams.has("projectRoot")).toBe(false);
  });

  it("counts a skipped answer as nothing waiting", async () => {
    harness.setResponder(({ url }) =>
      url.pathname === "/api/session-decisions"
        ? { outcome: "skipped", projectRoot: "", projectStatus: "unknown", reason: "off" }
        : { outcome: "knowledge_candidates", items: [{ id: "c1" }], openRequests: [], backlog: [] },
    );
    const store = useWorkKnowledgePendingStore();

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(store.pendingTotal).toBe(1);
  });
});
