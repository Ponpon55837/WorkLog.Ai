import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only.
const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];
const filler = "The fictional heron gate keeps its verified calibration window and its source notes. ";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-context-budget-"));
  tempDirs.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject("Heron Gate", root);
  store.updateProject(project.id, { status: "tracked" });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2031, 0, 1));
  const sessionIds: string[] = [];
  for (let index = 0; index < 14; index += 1) {
    vi.setSystemTime(Date.now() + 60_000);
    const result = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: `heron-${index}`,
      title: `Heron gate step ${index}`,
      summary: filler.repeat(6),
      workSummary: {
        outcomes: [`Heron gate outcome ${index}.`],
        scope: [],
        decisions: [filler.repeat(2)],
        verification: [],
        nextSteps: [filler.repeat(2), `Second heron follow-up ${index}.`, `Third heron follow-up ${index}.`],
      },
      changedFiles: [`src/heron-${index}.ts`],
      verification: { status: "passed" },
    });
    if (result.outcome !== "finalized") throw new Error("Expected a finalized fixture Session.");
    sessionIds.push(result.session.id);
  }
  for (let index = 0; index < 12; index += 1) {
    store.recordKnowledge({
      projectRoot: root,
      idempotencyKey: `heron-knowledge-${index}`,
      kind: "pattern",
      title: `Heron gate pattern ${index}`,
      body: filler.repeat(6),
    });
  }
  for (const slug of ["architecture", "pitfalls", "in-progress"]) {
    store.requestKnowledgePageUpdate({ projectRoot: root, slug });
    store.saveKnowledgePage({
      projectRoot: root,
      slug,
      idempotencyKey: `heron-page-${slug}`,
      sections: [{ heading: `Heron ${slug}`, content: filler.repeat(20), sourceSessionIds: sessionIds.slice(0, 6) }],
    });
  }
  return { store, root, project, sessionIds };
}

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("context budget", () => {
  it("keeps the newest Sessions ahead of page content when a context without a focus is trimmed", () => {
    const { store, root, sessionIds } = setup();
    const context = store.getContext(root);
    if (context.outcome !== "context") throw new Error("Expected context.");

    expect(JSON.stringify(context).length).toBeLessThanOrEqual(15_800);
    expect(context.recentSessions.map((session) => session.id)).toEqual(sessionIds.slice(-3).reverse());
    const omittedSessions = context.omitted?.find((omission) => omission.section === "recentSessions");
    expect(omittedSessions).toMatchObject({ count: 9, moreIds: 6, readWith: "work_get_session" });
    expect(omittedSessions?.ids).toHaveLength(3);
  });

  it("drops the newest Sessions last when a focus already names relevant ones", () => {
    const { store, root } = setup();
    const context = store.getContext(root, { task: "heron gate calibration window" });
    if (context.outcome !== "context") throw new Error("Expected context.");

    expect(JSON.stringify(context).length).toBeLessThanOrEqual(9_800);
    expect(context.relevant?.sessions.length).toBeGreaterThan(0);
    expect(context.recentSessions).toEqual([]);
  });

  it("keeps omission pointers to ids, counts, and flags without page review detail", () => {
    const { store, root, sessionIds } = setup();
    vi.setSystemTime(Date.now() + 60_000);
    const corrected = store.updateSessionSummary({
      sessionId: sessionIds[0]!,
      idempotencyKey: "heron-source-correction",
      summary: "The corrected heron gate source needs a page review.",
    });
    expect(corrected.outcome).toBe("summary_updated");

    const context = store.getContext(root, { task: "unrelated lantern topic" });
    if (context.outcome !== "context") throw new Error("Expected context.");
    const serialized = JSON.stringify(context.omitted);
    expect(serialized).not.toContain("reviewSections");
    expect(serialized).not.toContain("sourceSessionIds");
    const pages = context.omitted?.find((omission) => omission.section === "knowledgePages");
    expect(pages).toEqual({
      section: "knowledgePages",
      count: 3,
      readWith: "work_get_knowledge_page_context",
      reasons: ["本次不相關"],
      entries: expect.arrayContaining([
        { id: "architecture", needsReview: true },
        { id: "pitfalls", needsReview: true },
        { id: "in-progress", needsReview: true },
      ]),
    });
    for (const omission of context.omitted ?? []) expect((omission.ids ?? []).length).toBeLessThanOrEqual(3);
  });

  it("names the project once in a scoped context and on every item of an unscoped one", () => {
    const { store, root, project } = setup();
    const scoped = store.getContext(root, { task: "heron gate calibration window" });
    if (scoped.outcome !== "context") throw new Error("Expected context.");
    expect(scoped.project?.id).toBe(project.id);
    expect(scoped.projects).toEqual([]);
    const scopedItems = [
      ...(scoped.relevant?.sessions ?? []),
      ...(scoped.relevant?.knowledge ?? []),
      ...(scoped.relevant?.knowledgePages ?? []),
    ];
    expect(scopedItems.length).toBeGreaterThan(0);
    for (const item of scopedItems) {
      expect(item).not.toHaveProperty("projectId");
      expect(item).not.toHaveProperty("projectName");
    }

    const unscoped = store.getContext(undefined, { task: "heron gate calibration window" });
    if (unscoped.outcome !== "context") throw new Error("Expected context.");
    expect(unscoped.projects.map((item) => item.id)).toEqual([project.id]);
    expect(unscoped.relevant?.sessions[0]).toMatchObject({ projectId: project.id, projectName: "Heron Gate" });
  });
});
