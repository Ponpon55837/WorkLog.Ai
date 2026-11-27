import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectDataExport } from "../../packages/core/src/index.js";
import { readProjectDataImportBytes } from "../../packages/storage/src/project-data-import-stream.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

const ACTOR_REASON = "待結項稽核事件的 actor Session 必須位於同一專案。";
const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createStore(): WorkIntelligenceStore {
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  return store;
}

function total(counts: Record<string, number | undefined>): number {
  return Object.values(counts).reduce<number>((sum, count) => sum + (count ?? 0), 0);
}

function createSource() {
  const root = mkdtempSync(join(tmpdir(), "wi-deleted-actor-"));
  tempDirs.push(root);
  const store = createStore();
  const projectIds: string[] = [];
  const sessionIds: string[] = [];
  for (const name of ["one", "two"]) {
    const projectRoot = join(root, name);
    mkdirSync(projectRoot);
    const project = store.addProject(`Actor project ${name}`, projectRoot);
    store.updateProject(project.id, { status: "tracked" });
    const finalized = store.finalizeSession({
      projectRoot,
      idempotencyKey: `actor-session-${name}`,
      title: `Actor session ${name}`,
      summary: "Synthetic Session.",
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [`Synthetic item ${name}.`] },
      completedAt: "2026-10-01T00:00:00.000Z",
    });
    if (finalized.outcome !== "finalized") throw new Error("The Session must be accepted.");
    projectIds.push(project.id);
    sessionIds.push(finalized.session.id);
  }
  const bundle = store.exportProjectData({ type: "all" });
  const event = bundle.tables.outstanding_item_events.find((item) => item.project_id === projectIds[0]);
  if (!event) throw new Error("Expected an audit event of the first project.");
  return { root, bundle, event, projectIds, sessionIds };
}

describe("outstanding audit events whose actor Session was deleted", () => {
  it("imports an event whose actor is missing on both sides, and skips it the second time", () => {
    const { bundle, event } = createSource();
    event.actor_session_id = "deleted-actor-session";
    const destination = createStore();

    const preview = destination.previewProjectDataImport({ bundle });
    expect(total(preview.conflicts)).toBe(0);
    expect(destination.importProjectData({ bundle }).additions.outstanding_item_events).toBeGreaterThan(0);
    const again = destination.importProjectData({ bundle });
    expect(total(again.additions) + total(again.conflicts)).toBe(0);
    expect(again.changed).toBe(false);
  });

  it("behaves the same for a streamed file", () => {
    const { root, bundle, event } = createSource();
    event.actor_session_id = "deleted-actor-session";
    const streamed = readProjectDataImportBytes(Buffer.from(JSON.stringify({ bundle })), {
      envelope: "request",
      spillPath: join(root, "import.spill"),
    });
    try {
      expect(total(createStore().previewProjectDataImport(streamed).conflicts)).toBe(0);
    } finally {
      streamed.dispose();
    }
  });

  it("still rejects an actor that belongs to another project", () => {
    const { bundle, event, sessionIds } = createSource();
    event.actor_session_id = sessionIds[1] ?? null;

    const preview = createStore().previewProjectDataImport({ bundle });

    expect(preview.conflictDetails).toContainEqual(
      expect.objectContaining({ table: "outstanding_item_events", id: event.id, reason: ACTOR_REASON }),
    );
  });

  it("still rejects an actor Session that is itself a conflict", () => {
    const { bundle, event, sessionIds } = createSource();
    const destination = createStore();
    destination.importProjectData({ bundle });
    const actorId = "renamed-actor-session";
    const session = bundle.tables.sessions.find(
      (item) => item.id === sessionIds[0],
    ) as ProjectDataExport["tables"]["sessions"][number];
    session.id = actorId;
    event.id = "new-event-id";
    event.actor_session_id = actorId;

    const preview = destination.previewProjectDataImport({ bundle });

    expect(preview.conflictDetails).toContainEqual(
      expect.objectContaining({ table: "outstanding_item_events", id: "new-event-id", reason: ACTOR_REASON }),
    );
  });
});
