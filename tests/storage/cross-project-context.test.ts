import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkSessionRecord } from "../../packages/core/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

const stores: WorkIntelligenceStore[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createStore(): WorkIntelligenceStore {
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  return store;
}

function createProjectSession(
  store: WorkIntelligenceStore,
  projectName: string,
  content: string,
  status: "tracked" | "paused" = "tracked",
): { projectId: string; projectName: string; root: string; session: WorkSessionRecord } {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-cross-project-"));
  roots.push(root);
  const project = store.addProject(projectName, root);
  store.updateProject(project.id, { status: "tracked" });
  const finalized = store.finalizeSession({
    projectRoot: root,
    idempotencyKey: `cross-project-${projectName}`,
    title: `${projectName} project-only record`,
    summary: content,
    verification: { status: "passed" },
  });
  if (finalized.outcome !== "finalized") {
    throw new Error(`Expected ${projectName} to finalize, got ${finalized.outcome}.`);
  }
  if (status === "paused") {
    store.updateProject(project.id, { status: "paused" });
  }
  return { projectId: project.id, projectName, root, session: finalized.session };
}

function resultText(value: unknown): string {
  return JSON.stringify(value);
}

function expectProjectAbsent(value: unknown, project: ReturnType<typeof createProjectSession>): void {
  const serialized = resultText(value);
  expect(serialized).not.toContain(project.projectId);
  expect(serialized).not.toContain(project.session.id);
  expect(serialized).not.toContain(project.projectName);
  expect(serialized).not.toContain(project.session.title);
  expect(serialized).not.toContain(project.session.summary);
}

describe("cross-project context and recall", () => {
  it("scopes results to a requested project and labels cross-project results without exposing paused data", () => {
    const store = createStore();
    const query = "sapphire kiln relay";
    const violet = createProjectSession(store, "Tracked Violet", `${query} carries the violet fixture signal.`);
    const amber = createProjectSession(store, "Tracked Amber", `${query} carries the amber fixture signal.`);
    const hidden = createProjectSession(
      store,
      "Paused Silver",
      `${query} carries the paused silver fixture signal.`,
      "paused",
    );

    const violetContext = store.getContext(violet.root);
    if (violetContext.outcome !== "context") throw new Error("Expected tracked-project context.");
    expect(violetContext.recentSessions.map((session) => session.id)).toEqual([violet.session.id]);
    expectProjectAbsent(violetContext, amber);
    expectProjectAbsent(violetContext, hidden);

    const violetFocusedContext = store.getContext(violet.root, { task: query });
    if (violetFocusedContext.outcome !== "context") throw new Error("Expected focused tracked-project context.");
    expect(violetFocusedContext.relevant?.sessions).toEqual([
      expect.objectContaining({ id: violet.session.id, projectId: violet.projectId, projectName: violet.projectName }),
    ]);
    expectProjectAbsent(violetFocusedContext, amber);
    expectProjectAbsent(violetFocusedContext, hidden);

    const violetRecall = store.recall({ q: query, projectRoot: violet.root });
    if (violetRecall.outcome !== "recall") throw new Error("Expected tracked-project recall.");
    expect(violetRecall.hits.map((hit) => hit.id)).toEqual([violet.session.id]);
    expectProjectAbsent(violetRecall, amber);
    expectProjectAbsent(violetRecall, hidden);

    const amberContext = store.getContext(amber.root);
    if (amberContext.outcome !== "context") throw new Error("Expected tracked-project context.");
    expect(amberContext.recentSessions.map((session) => session.id)).toEqual([amber.session.id]);
    expectProjectAbsent(amberContext, violet);
    expectProjectAbsent(amberContext, hidden);

    const amberFocusedContext = store.getContext(amber.root, { task: query });
    if (amberFocusedContext.outcome !== "context") throw new Error("Expected focused tracked-project context.");
    expect(amberFocusedContext.relevant?.sessions).toEqual([
      expect.objectContaining({ id: amber.session.id, projectId: amber.projectId, projectName: amber.projectName }),
    ]);
    expectProjectAbsent(amberFocusedContext, violet);
    expectProjectAbsent(amberFocusedContext, hidden);

    const amberRecall = store.recall({ q: query, projectRoot: amber.root });
    if (amberRecall.outcome !== "recall") throw new Error("Expected tracked-project recall.");
    expect(amberRecall.hits.map((hit) => hit.id)).toEqual([amber.session.id]);
    expectProjectAbsent(amberRecall, violet);
    expectProjectAbsent(amberRecall, hidden);

    const crossProjectContext = store.getContext();
    if (crossProjectContext.outcome !== "context") throw new Error("Expected cross-project context.");
    expect(crossProjectContext.projects.map((project) => project.id)).toEqual(
      expect.arrayContaining([violet.projectId, amber.projectId]),
    );
    expect(crossProjectContext.projects.map((project) => project.id)).not.toContain(hidden.projectId);
    expect(crossProjectContext.recentSessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: violet.session.id,
          projectId: violet.projectId,
          projectName: violet.projectName,
        }),
        expect.objectContaining({ id: amber.session.id, projectId: amber.projectId, projectName: amber.projectName }),
      ]),
    );
    expectProjectAbsent(crossProjectContext, hidden);

    const focusedContext = store.getContext(undefined, { task: query });
    if (focusedContext.outcome !== "context") throw new Error("Expected focused cross-project context.");
    expect(focusedContext.relevant?.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: violet.session.id,
          projectId: violet.projectId,
          projectName: violet.projectName,
        }),
        expect.objectContaining({ id: amber.session.id, projectId: amber.projectId, projectName: amber.projectName }),
      ]),
    );
    expectProjectAbsent(focusedContext, hidden);

    const crossProjectRecall = store.recall({ q: query });
    if (crossProjectRecall.outcome !== "recall") throw new Error("Expected cross-project recall.");
    expect(crossProjectRecall.hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: violet.session.id,
          projectId: violet.projectId,
          projectName: violet.projectName,
        }),
        expect.objectContaining({ id: amber.session.id, projectId: amber.projectId, projectName: amber.projectName }),
      ]),
    );
    expectProjectAbsent(crossProjectRecall, hidden);
  });
});
