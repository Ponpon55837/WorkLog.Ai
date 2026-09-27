import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreRequest } from "../helpers/store-harness.js";
import { createStoreHarness } from "../helpers/store-harness.js";
import { useKnowledgePagesStore } from "../../../apps/web/src/stores/knowledge-pages.js";

const page = {
  id: "page-1",
  projectId: "project-1",
  slug: "pitfalls",
  title: "常見陷阱",
  question: "What went wrong?",
  sections: [{ heading: "Build", content: "Build first.", sourceSessionIds: ["session-1"] }],
  version: 2,
  status: "needs_update",
  newSessionCount: 3,
  createdAt: "2030-01-01T00:00:00.000Z",
  updatedAt: "2030-01-02T00:00:00.000Z",
};

let harness: ReturnType<typeof createStoreHarness>;

function responder({ url, method }: StoreRequest): unknown {
  if (url.pathname === "/api/knowledge-pages" && method === "GET") {
    return url.searchParams.get("projectRoot") === "/paused"
      ? { outcome: "skipped", reason: "此專案已暫停記錄。" }
      : { outcome: "knowledge_pages", items: [page] };
  }
  if (url.pathname === "/api/knowledge-pages/page-1/versions") {
    return {
      outcome: "knowledge_page_versions",
      page,
      versions: [{ id: "v2", pageId: "page-1", version: 2, author: "web" }],
      sources: [{ id: "session-1", title: "Source Session" }],
    };
  }
  if (url.pathname === "/api/knowledge-pages/update-requests") {
    return { outcome: "knowledge_page_update_requested", page };
  }
  if (url.pathname === "/api/knowledge-pages/page-1" && method === "PATCH") {
    return { outcome: "knowledge_page_updated", page: { ...page, version: 3 } };
  }
  return {};
}

beforeEach(() => {
  harness = createStoreHarness(responder);
});

afterEach(async () => harness.cleanup());

describe("Knowledge pages store", () => {
  it("lists pages per project, counts stale pages, and reports a skipped project", async () => {
    const store = useKnowledgePagesStore();
    store.setListActive(true, "/projects/a");
    await vi.waitFor(() => expect(store.pages).toHaveLength(1));
    expect(store.staleCount).toBe(1);
    expect(harness.calls.at(-1)?.url.searchParams.get("projectRoot")).toBe("/projects/a");

    store.setListActive(true, "/paused");
    await vi.waitFor(() => expect(store.pagesError).toBe("此專案已暫停記錄。"));
    expect(store.pages).toEqual([]);
  });

  it("loads the open page's versions and sources, and refreshes after an edit or request", async () => {
    const store = useKnowledgePagesStore();
    store.setListActive(true);
    store.showPage("page-1");
    await vi.waitFor(() => expect(store.versions).toHaveLength(1));
    expect(store.openPage?.id).toBe("page-1");
    expect(store.sources).toEqual([{ id: "session-1", title: "Source Session" }]);

    const listCalls = harness.count("/api/knowledge-pages");
    await expect(store.updatePage({ pageId: "page-1", sections: page.sections })).resolves.toMatchObject({
      outcome: "knowledge_page_updated",
    });
    await expect(store.requestUpdate({ projectRoot: "/projects/a", slug: "pitfalls" })).resolves.toMatchObject({
      outcome: "knowledge_page_update_requested",
    });
    await vi.waitFor(() => expect(harness.count("/api/knowledge-pages")).toBeGreaterThan(listCalls));
    await store.reload();

    store.closePage();
    expect(store.openPage).toBeNull();
  });
});
