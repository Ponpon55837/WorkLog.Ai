import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentReviewRequest, SubmitAgentReviewVerdictsResult } from "../../packages/core/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only. Time is faked so every write has its own later timestamp.
const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup(databaseName = ":memory:") {
  const directory = mkdtempSync(join(tmpdir(), "work-intelligence-agent-review-pages-"));
  tempDirs.push(directory);
  const store = new WorkIntelligenceStore(databaseName === ":memory:" ? databaseName : join(directory, databaseName));
  stores.push(store);
  const db = (store as unknown as { db: DatabaseSync }).db;
  const root = join(directory, "orchard");
  const project = store.addProject("Orchard", root);
  store.updateProject(project.id, { status: "tracked" });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2030, 0, 1));
  const tick = () => vi.setSystemTime(Date.now() + 60_000);

  const finalize = (key: string) => {
    tick();
    const result = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: key,
      title: `Session ${key}`,
      summary: `Fictional summary for ${key}.`,
      workSummary: {
        outcomes: [],
        scope: [],
        decisions: [{ text: `Decision of ${key}`, origin: "agent_autonomous" as const }],
        verification: [],
        nextSteps: [],
      },
      changedFiles: [],
      verification: { status: "passed" },
    });
    if (result.outcome !== "finalized") throw new Error("Expected a finalized Session.");
    const decisionIds = (store.getSessionDetail(result.session.id)?.decisions ?? []).map((decision) => decision.id);
    return { sessionId: result.session.id, decisionId: decisionIds[0]! };
  };
  const queue = (slug: string) => {
    tick();
    const result = store.requestKnowledgePageUpdate({
      projectRoot: root,
      slug,
      title: `Page ${slug}`,
      question: `What is the state of ${slug}?`,
    });
    if (result.outcome !== "knowledge_page_update_requested") throw new Error(`Got ${result.outcome}.`);
  };
  const save = (slug: string, sessionId: string, key: string) => {
    tick();
    const result = store.saveKnowledgePage({
      projectRoot: root,
      slug,
      idempotencyKey: key,
      sections: [{ heading: "Build", content: `Content of ${key}.`, sourceSessionIds: [sessionId] }],
    });
    if (result.outcome !== "knowledge_page_saved") throw new Error(`Got ${result.outcome}.`);
  };
  const open = (key = "review-1"): AgentReviewRequest => {
    tick();
    const result = store.requestAgentReview({ projectRoot: root, idempotencyKey: key });
    if (result.outcome !== "agent_review_request") throw new Error(`Expected a request, got ${result.outcome}.`);
    return result.request;
  };
  const complete = (
    requestId: string,
    verdicts: Array<{ decisionId: string }> = [],
    key = "submit-1",
  ): Extract<SubmitAgentReviewVerdictsResult, { outcome: "agent_review_verdicts_submitted" }> => {
    tick();
    const result = store.submitAgentReviewVerdicts({
      requestId,
      idempotencyKey: key,
      complete: true,
      verdicts: verdicts.map(({ decisionId }) => ({
        itemKind: "decision" as const,
        itemId: decisionId,
        verdict: "confirm" as const,
        reason: "Fictional reason.",
      })),
    });
    if (result.outcome !== "agent_review_verdicts_submitted") throw new Error(`Got ${result.outcome}.`);
    return result;
  };
  const listed = () => {
    const result = store.listAgentReviewRequests({ projectId: project.id });
    if (result.outcome !== "agent_review_requests") throw new Error("Expected a request list.");
    return result.requests;
  };
  const stored = (requestId: string) =>
    (
      db.prepare("SELECT completion_pages_json AS json FROM agent_review_requests WHERE id = ?").get(requestId) as {
        json: string | null;
      }
    ).json;
  return { store, db, root, projectId: project.id, tick, finalize, queue, save, open, complete, listed, stored };
}

describe("Agent review completion pages", () => {
  it("stores the list when the request completes and keeps it after a page leaves the queue", () => {
    const fixture = setup();
    const { decisionId } = fixture.finalize("a");
    fixture.queue("operations");
    const request = fixture.open();
    expect(fixture.stored(request.id)).toBeNull();

    const first = fixture.complete(request.id, [{ decisionId }]);
    const expected = [{ slug: "operations", title: expect.any(String), reasons: ["queued_for_update"] }];
    expect(first.completion?.knowledgePages).toEqual(expected);
    expect(JSON.parse(fixture.stored(request.id)!)).toEqual(expected);

    fixture.save("operations", fixture.finalize("b").sessionId, "operations-page");
    const replay = fixture.complete(request.id, [{ decisionId }]);
    expect(replay.duplicate).toBe(true);
    expect(replay.completion?.knowledgePages).toEqual(expected);
  });

  it("falls back to the computed list for a request completed before the snapshot existed", () => {
    const fixture = setup();
    const { decisionId } = fixture.finalize("a");
    fixture.queue("operations");
    const request = fixture.open();
    fixture.complete(request.id, [{ decisionId }]);
    fixture.db.prepare("UPDATE agent_review_requests SET completion_pages_json = NULL WHERE id = ?").run(request.id);

    expect(fixture.complete(request.id, [{ decisionId }]).completion?.knowledgePages).toEqual([
      { slug: "operations", title: expect.any(String), reasons: ["queued_for_update"] },
    ]);
    fixture.save("operations", fixture.finalize("b").sessionId, "operations-page");
    expect(fixture.complete(request.id, [{ decisionId }]).completion?.knowledgePages).toEqual([]);
    expect(fixture.listed()[0]?.knowledgePages).toEqual([]);
  });

  it("falls back to the computed list when the stored value is not a page list", () => {
    const fixture = setup();
    const { decisionId } = fixture.finalize("a");
    const request = fixture.open();
    fixture.complete(request.id, [{ decisionId }]);
    for (const value of ["{}", "not json", '[{"slug":1}]']) {
      fixture.db
        .prepare("UPDATE agent_review_requests SET completion_pages_json = ? WHERE id = ?")
        .run(value, request.id);
      expect(fixture.complete(request.id, [{ decisionId }]).completion?.knowledgePages).toEqual([]);
    }
  });

  it("round-trips the column through export and import", () => {
    const fixture = setup("source.sqlite");
    const { decisionId } = fixture.finalize("a");
    fixture.queue("operations");
    const request = fixture.open();
    fixture.complete(request.id, [{ decisionId }]);
    const bundle = fixture.store.exportProjectData({ type: "project", projectId: fixture.projectId });
    const exported = bundle.tables.agent_review_requests.find((row) => row.id === request.id);
    expect(exported?.completion_pages_json).toBe(fixture.stored(request.id));

    const directory = mkdtempSync(join(tmpdir(), "work-intelligence-agent-review-pages-import-"));
    tempDirs.push(directory);
    const destination = new WorkIntelligenceStore(join(directory, "destination.sqlite"));
    stores.push(destination);
    destination.importProjectData({ bundle, remap: [] });
    const db = (destination as unknown as { db: DatabaseSync }).db;
    expect(
      db.prepare("SELECT completion_pages_json AS json FROM agent_review_requests WHERE id = ?").get(request.id),
    ).toEqual({ json: fixture.stored(request.id) });
  });
});

describe("Agent review request Knowledge pages", () => {
  it("states each page as pending, updated, checked or unchanged", () => {
    const fixture = setup();
    const reviewed = fixture.finalize("a");
    fixture.queue("architecture");
    fixture.save("architecture", reviewed.sessionId, "architecture-page-1");
    fixture.queue("decisions");
    fixture.save("decisions", reviewed.sessionId, "decisions-page-1");
    fixture.queue("operations");
    fixture.queue("testing");
    const request = fixture.open();
    fixture.complete(request.id, [{ decisionId: reviewed.decisionId }]);

    const bySlug = () =>
      Object.fromEntries((fixture.listed()[0]?.knowledgePages ?? []).map((page) => [page.slug, page.state]));
    const snapshot = fixture.listed()[0]!.knowledgePages!;
    expect(snapshot.find((page) => page.slug === "architecture")?.reasons).toEqual(["cites_reviewed_session"]);
    expect(snapshot.find((page) => page.slug === "operations")?.reasons).toEqual(["queued_for_update"]);
    expect(bySlug()).toEqual({
      architecture: "unchanged",
      decisions: "unchanged",
      operations: "pending",
      testing: "pending",
    });

    fixture.queue("architecture");
    fixture.save("architecture", reviewed.sessionId, "architecture-page-2");
    fixture.save("operations", reviewed.sessionId, "operations-page-1");
    fixture.db.prepare("UPDATE knowledge_pages SET update_requested_at = NULL WHERE slug = 'testing'").run();

    expect(bySlug()).toEqual({
      architecture: "updated",
      decisions: "unchanged",
      operations: "updated",
      testing: "checked",
    });
    fixture.queue("decisions");
    expect(bySlug().decisions).toBe("pending");
  });

  it("is present only on completed requests", () => {
    const fixture = setup();
    const { decisionId } = fixture.finalize("a");
    const open = fixture.open();
    expect(fixture.listed()[0]).not.toHaveProperty("knowledgePages");
    fixture.complete(open.id, [{ decisionId }]);
    expect(fixture.listed()[0]?.knowledgePages).toEqual([]);
    expect(fixture.store.listAgentReviewRequests({ projectId: fixture.projectId, status: "pending" })).toMatchObject({
      requests: [],
    });
    fixture.finalize("b");
    const next = fixture.open("review-2");
    const requests = fixture.listed();
    expect(requests.find((request) => request.id === next.id)).not.toHaveProperty("knowledgePages");
    expect(requests.find((request) => request.id === open.id)).toHaveProperty("knowledgePages");
  });

  it("reads a constant number of statements however many pages a request lists", () => {
    const fixture = setup();
    const reviewed = fixture.finalize("a");
    const countStatements = () => {
      const spy = vi.spyOn(fixture.db, "prepare");
      fixture.listed();
      const count = spy.mock.calls.length;
      spy.mockRestore();
      return count;
    };
    fixture.queue("operations");
    const request = fixture.open();
    fixture.complete(request.id, [{ decisionId: reviewed.decisionId }]);
    const few = countStatements();
    const slugs = ["architecture", "decisions", "testing", "build", "deploy", "security"];
    for (const slug of slugs) fixture.queue(slug);
    fixture.db
      .prepare("UPDATE agent_review_requests SET completion_pages_json = ? WHERE id = ?")
      .run(
        JSON.stringify(["operations", ...slugs].map((slug) => ({ slug, title: slug, reasons: ["queued_for_update"] }))),
        request.id,
      );
    expect(fixture.listed()[0]?.knowledgePages).toHaveLength(slugs.length + 1);
    expect(countStatements()).toBe(few);
  });
});
