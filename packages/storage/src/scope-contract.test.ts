import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalizeProjectRoot } from "@work-intelligence/project-policy";
import { WorkIntelligenceStore } from "./store.js";

const stores: WorkIntelligenceStore[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createStore(): { store: WorkIntelligenceStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-scope-contract-"));
  directories.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  return { store, root };
}

describe("skipped response scope contracts", () => {
  it("keeps root-scoped APIs on projectRoot and never substitutes projectId", () => {
    const { store, root } = createStore();
    const expectedRoot = canonicalizeProjectRoot(root);

    const finalize = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "scope-root-finalize",
      title: "Unregistered root",
      summary: "The root policy gate must skip ingestion.",
    });
    const graph = store.getGraph({ projectRoot: root });
    const knowledge = store.searchKnowledge({ projectRoot: root });
    const context = store.getContext(root);

    for (const result of [finalize, graph, knowledge, context]) {
      expect(result).toMatchObject({ outcome: "skipped", projectRoot: expectedRoot });
      expect("projectId" in result).toBe(false);
      expect("sessionId" in result).toBe(false);
    }
  });

  it("keeps project-id-scoped APIs on projectId for an untracked registry entry", () => {
    const { store, root } = createStore();
    const project = store.addProject("Untracked registry entry", root);

    const metadata = store.createMetadataBackfillRequest({
      idempotencyKey: "scope-project-metadata",
      projectId: project.id,
    });
    const reportRequest = store.createReportSynthesisRequest({
      idempotencyKey: "scope-project-report",
      projectId: project.id,
      period: "week",
      date: "2026-09-21",
    });
    const report = store.getReport({ period: "week", projectId: project.id, date: "2026-09-21" });

    for (const result of [metadata, reportRequest, report]) {
      expect(result).toMatchObject({ outcome: "skipped", projectId: project.id });
      expect("projectRoot" in result).toBe(false);
      expect("sessionId" in result).toBe(false);
    }
  });

  it("keeps session-scoped APIs on sessionId after a tracked project is paused", () => {
    const { store, root } = createStore();
    const project = store.addProject("Session scope project", root);
    store.updateProject(project.id, { status: "tracked" });
    const finalized = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: "scope-session-finalize",
      title: "Session scope",
      summary: "This Session is used to verify session-scoped skip responses.",
      verification: { status: "passed" },
    });
    if (finalized.outcome !== "finalized") {
      throw new Error("Expected a finalized session.");
    }

    store.updateProject(project.id, { status: "paused" });
    const evidence = store.attachEvidence({
      sessionId: finalized.session.id,
      kind: "test",
      reference: "scope-contract",
      summary: "Must not be written while the project is paused.",
    });
    const verification = store.updateSessionVerification(finalized.session.id, { status: "failed" });
    const summary = store.updateSessionSummary({
      sessionId: finalized.session.id,
      idempotencyKey: "scope-session-summary",
      mode: "append",
      summary: "Must not be written while the project is paused.",
    });

    for (const result of [evidence, verification, summary]) {
      expect(result).toMatchObject({ outcome: "skipped", sessionId: finalized.session.id });
      expect("projectRoot" in result).toBe(false);
      expect("projectId" in result).toBe(false);
    }
  });
});
