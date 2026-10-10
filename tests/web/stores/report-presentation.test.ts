import { afterEach, describe, expect, it, vi } from "vitest";
import { useReportPresentationStore } from "../../../apps/web/src/stores/report-presentation.js";
import { createStoreHarness, jsonResponse } from "../helpers/store-harness.js";

let harness: ReturnType<typeof createStoreHarness>;
function result(summaryId: string, revision = 0) {
  return { summaryId, revision, state: { pinned: [], hidden: [], overrides: [] }, history: [] };
}
afterEach(async () => harness?.cleanup());
describe("report presentation scoped queries", () => {
  it("does not expose a delayed prior report after switching versions", async () => {
    let release: (value: unknown) => void = () => undefined;
    harness = createStoreHarness(({ url }) =>
      url.pathname.includes("first")
        ? new Promise((resolve) => {
            release = resolve;
          })
        : result("second"),
    );
    const store = useReportPresentationStore();
    store.setSummary("first");
    await vi.waitFor(() => expect(harness.count("/api/reports/summaries/first/presentation")).toBe(1));
    store.setSummary("second");
    await vi.waitFor(() => expect(store.data?.summaryId).toBe("second"));
    release(result("first", 9));
    await Promise.resolve();
    expect(store.data?.summaryId).toBe("second");
    store.setSummary("");
    expect(store.data).toBeNull();
  });
  it("keeps failed source validation unknown and permits an explicit retry", async () => {
    harness = createStoreHarness(() => jsonResponse({ code: "not_found" }, 404));
    const store = useReportPresentationStore();
    store.setSummary("fixture");
    await vi.waitFor(() => expect(store.error).not.toBe(""));
    expect(store.data).toBeNull();
    harness.setResponder(() => result("fixture"));
    await store.reload();
    expect(store.error).toBe("");
    expect(store.data?.revision).toBe(0);
  });
  it("preserves a successful save when background refetch aborts, and surfaces CAS conflicts", async () => {
    let saved = false;
    harness = createStoreHarness(({ method }) => {
      if (method === "PATCH") {
        saved = true;
        return result("fixture", 1);
      }
      if (saved) throw new DOMException("Superseded fetch", "AbortError");
      return result("fixture");
    });
    const store = useReportPresentationStore();
    store.setSummary("fixture");
    await vi.waitFor(() => expect(store.data?.revision).toBe(0));
    const input = { summaryId: "fixture", expectedRevision: 0, state: { pinned: [], hidden: [], overrides: [] } };
    await expect(store.save(input)).resolves.toMatchObject({ revision: 1 });
    expect(store.saving).toBe(false);
    harness.setResponder(() => jsonResponse({ code: "report_presentation_conflict", error: "Conflict" }, 409));
    await expect(store.save(input)).rejects.toMatchObject({ status: 409 });
    expect(store.saving).toBe(false);
  });
});
