import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { FileHistoryResult, FinalizeSessionInput, VerificationStatus } from "../../packages/core/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only.
const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup(name = "Lighthouse") {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-file-history-"));
  tempDirs.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = track(store, name, root);
  let day = 0;
  const finalize = (
    key: string,
    changedFiles: string[],
    status: VerificationStatus = "passed",
    overrides: Partial<FinalizeSessionInput> = {},
  ): string => {
    day += 1;
    const result = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: key,
      title: `Lamp session ${key}`,
      summary: `${key} summary.`,
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles,
      verification: { status },
      completedAt: new Date(Date.UTC(2026, 0, day, 12)).toISOString(),
      ...overrides,
    });
    if (result.outcome !== "finalized") throw new Error("Expected finalize");
    return result.session.id;
  };
  return { store, root, project, finalize };
}

function track(store: WorkIntelligenceStore, name: string, root: string) {
  const project = store.addProject(name, root);
  store.updateProject(project.id, { status: "tracked" });
  return project;
}

function history(result: ReturnType<WorkIntelligenceStore["getFileHistory"]>): FileHistoryResult {
  if (result.outcome !== "file_history") throw new Error(`Expected file_history, received ${result.outcome}`);
  return result;
}

describe("file history", () => {
  it("totals the whole history and returns the newest Sessions first with their decisions and pending items", () => {
    const { store, root, project, finalize } = setup();
    finalize("a", ["src/lamp/beam.ts", "src/lamp/lens.ts"], "failed");
    const withDecision = finalize("b", ["src/lamp/beam.ts"], "passed", {
      workSummary: {
        outcomes: [],
        scope: [],
        decisions: ["Rotate the beam clockwise.", "Keep the lens oiled.", "Paint the tower white."],
        verification: [],
        nextSteps: ["Replace the bulb.", "Check the fog horn.", "Log the ships."],
      },
    });
    finalize("c", ["src/lamp/lens.ts"]);
    const broadFiles = Array.from({ length: 21 }, (_, index) => `src/keeper/log-${index}.ts`);
    const broad = finalize("d", [...broadFiles, "src/lamp/beam.ts"], "not_run");

    const result = history(store.getFileHistory({ projectRoot: root, paths: ["src/lamp/beam.ts"] }));
    expect(result).toMatchObject({ project: { id: project.id, name: "Lighthouse" }, relation: "changed_files" });
    const [entry] = result.files;
    expect(entry!.totals).toEqual({
      sessions: 3,
      firstAt: "2026-01-01T12:00:00.000Z",
      lastAt: "2026-01-04T12:00:00.000Z",
      verification: { failed: 1, passed: 1, not_run: 1 },
      withDecisions: 1,
      pendingItems: 3,
      broadChanges: 1,
    });
    expect(entry!.recent.map((session) => session.id)).toEqual([broad, withDecision, expect.any(String)]);
    const decided = entry!.recent[1]!;
    expect(decided).toMatchObject({
      verificationStatus: "passed",
      decisions: ["Rotate the beam clockwise.", "Keep the lens oiled."],
      decisionsOmitted: 1,
      pendingItemsOmitted: 1,
    });
    expect(decided.pendingItems!.map((item) => item.text)).toEqual(["Replace the bulb.", "Check the fog horn."]);
    expect(entry!.omitted).toEqual({ older: 0, attention: 0 });
    expect(entry).not.toHaveProperty("nextCursor");
  });

  it("pages older Sessions with nextCursor and surfaces older failed or not-run Sessions", () => {
    const { store, root, finalize } = setup();
    const failed = finalize("old-failed", ["src/lamp/beam.ts"], "failed");
    const notRun = finalize("old-not-run", ["src/lamp/beam.ts"], "not_run");
    finalize("old-progress", ["src/lamp/beam.ts"], "in_progress");
    const ids = Array.from({ length: 6 }, (_, index) => finalize(`new-${index}`, ["src/lamp/beam.ts"]));

    const first = history(store.getFileHistory({ projectRoot: root, paths: ["src/lamp/beam.ts"], limit: 4 })).files[0]!;
    expect(first.recent.map((session) => session.id)).toEqual(ids.slice(2).reverse());
    expect(first.attention.map((session) => session.id)).toEqual([notRun, failed]);
    expect(first.omitted).toEqual({ older: 5, attention: 0 });
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = history(
      store.getFileHistory({ projectRoot: root, paths: ["src/lamp/beam.ts"], limit: 4, cursor: first.nextCursor }),
    ).files[0]!;
    expect(second.recent.map((session) => session.id)).toEqual([ids[1], ids[0], expect.any(String), notRun]);
    expect(second.attention.map((session) => session.id)).toEqual([failed]);
    expect(second.omitted).toEqual({ older: 1, attention: 0 });
    expect(second.totals.sessions).toBe(9);
  });

  it("bounds attention and counts what it leaves out", () => {
    const { store, root, finalize } = setup();
    for (let index = 0; index < 5; index += 1) finalize(`failed-${index}`, ["src/lamp/beam.ts"], "failed");
    finalize("newest", ["src/lamp/beam.ts"]);
    const entry = history(store.getFileHistory({ projectRoot: root, paths: ["src/lamp/beam.ts"], limit: 1 })).files[0]!;
    expect(entry.attention).toHaveLength(3);
    expect(entry.omitted).toEqual({ older: 5, attention: 2 });
  });

  it("leaves voided Sessions and their pending items out", () => {
    const { store, root, finalize } = setup();
    finalize("kept", ["src/lamp/beam.ts"]);
    const voided = finalize("voided", ["src/lamp/beam.ts"], "failed", {
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: ["Recount the stairs."] },
    });
    expect(store.setSessionVoid({ sessionId: voided, voided: true, reason: "Recorded by mistake." }).outcome).toBe(
      "session_void_updated",
    );
    const entry = history(store.getFileHistory({ projectRoot: root, paths: ["src/lamp/beam.ts"] })).files[0]!;
    expect(entry.totals).toMatchObject({ sessions: 1, verification: { passed: 1 }, pendingItems: 0 });
    expect(entry.recent.map((session) => session.id)).not.toContain(voided);
  });

  it("matches paths with the changed-file normalization and only exact recorded files", () => {
    const { store, root, project, finalize } = setup();
    const stored = store.getProjectById(project.id)!.rootPath;
    const absolute = finalize("absolute", [`${stored}/src/Lamp/Beam.ts`]);
    const backslash = finalize("backslash", ["src\\lamp\\beam.ts"]);
    finalize("similar", ["src/lamp/beam.test.ts", "other/src/lamp/beam.ts"]);

    const entry = history(store.getFileHistory({ projectRoot: root, paths: ["./SRC/lamp/beam.ts"] })).files[0]!;
    expect(entry.path).toBe("./SRC/lamp/beam.ts");
    expect(entry.recent.map((session) => session.id)).toEqual([backslash, absolute]);
  });

  it("answers each requested path once and an unknown path with empty totals", () => {
    const { store, root, finalize } = setup();
    finalize("a", ["src/lamp/beam.ts"]);
    const result = history(
      store.getFileHistory({ projectRoot: root, paths: ["src/lamp/beam.ts", "SRC/lamp/beam.ts", "src/none.ts"] }),
    );
    expect(result.files.map((entry) => [entry.path, entry.totals.sessions])).toEqual([
      ["src/lamp/beam.ts", 1],
      ["src/none.ts", 0],
    ]);
    expect(result.files[1]).toMatchObject({ recent: [], attention: [], omitted: { older: 0, attention: 0 } });
  });

  it("lists active Knowledge whose appliesTo covers the path, best match first", () => {
    const { store, root } = setup();
    const record = (key: string, appliesTo: string[]) => {
      const result = store.recordKnowledge({
        projectRoot: root,
        idempotencyKey: key,
        kind: "gotcha",
        title: `Knowledge ${key}`,
        body: "Fictional lighthouse note.",
        appliesTo,
      });
      if (result.outcome !== "knowledge_recorded") throw new Error("Expected Knowledge");
      return result.knowledge.id;
    };
    const exact = record("exact", ["src/lamp/beam.ts"]);
    const glob = record("glob", ["src/**/*.ts"]);
    const directory = record("directory", ["src/lamp"]);
    record("other", ["src/keeper/log.ts"]);
    const archived = record("archived", ["src/lamp/beam.ts"]);
    store.updateKnowledge({ projectRoot: root, knowledgeId: archived, status: "archived" });

    const result = history(store.getFileHistory({ projectRoot: root, paths: ["src/lamp/beam.ts"] }));
    expect(result.knowledge.map((item) => item.id)).toEqual([exact, glob, directory]);
    expect(result.knowledge[0]).toEqual({ type: "knowledge", id: exact, title: "Knowledge exact" });
  });

  it("skips projects that are not tracked and never reads another project's Sessions", () => {
    const { store, root, project, finalize } = setup();
    finalize("own", ["src/lamp/beam.ts"]);
    const otherRoot = mkdtempSync(join(tmpdir(), "work-intelligence-file-history-other-"));
    tempDirs.push(otherRoot);
    track(store, "Harbor", otherRoot);
    store.finalizeSession({
      projectRoot: otherRoot,
      idempotencyKey: "harbor",
      title: "Harbor session",
      summary: "Harbor summary.",
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      changedFiles: ["src/lamp/beam.ts"],
      verification: { status: "failed" },
    });

    const own = history(store.getFileHistory({ projectRoot: root, paths: ["src/lamp/beam.ts"] }));
    expect(own.files[0]!.totals).toMatchObject({ sessions: 1, verification: { passed: 1 } });

    store.updateProject(project.id, { status: "paused" });
    expect(store.getFileHistory({ projectRoot: root, paths: ["src/lamp/beam.ts"] })).toMatchObject({
      outcome: "skipped",
      projectStatus: "paused",
    });
    const unregistered = mkdtempSync(join(tmpdir(), "work-intelligence-file-history-none-"));
    tempDirs.push(unregistered);
    expect(store.getFileHistory({ projectRoot: unregistered, paths: ["src/lamp/beam.ts"] })).toMatchObject({
      outcome: "skipped",
    });
  });

  it("keeps long histories within the response budget by shortening digests", () => {
    const { store, root, finalize } = setup();
    const long = "A fictional lighthouse decision that keeps going. ".repeat(20);
    for (let index = 0; index < 10; index += 1) {
      finalize(`long-${index}`, ["src/lamp/beam.ts"], index < 4 ? "failed" : "passed", {
        title: `Lamp session ${index} ${"with a very long fictional title ".repeat(6)}`,
        workSummary: { outcomes: [], scope: [], decisions: [long, long], verification: [], nextSteps: [long, long] },
      });
    }
    const result = history(store.getFileHistory({ projectRoot: root, paths: ["src/lamp/beam.ts"], limit: 10 }));
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(4_000);
    expect(result.budgetTrimmed).toBe(true);
    const entry = result.files[0]!;
    expect(entry.totals).toMatchObject({ sessions: 10, pendingItems: 20, withDecisions: 10 });
    // Whatever was dropped is still counted and reachable.
    const shown = entry.recent.length;
    expect(entry.omitted.older).toBe(10 - shown);
    if (entry.omitted.older > 0) expect(entry.nextCursor).toEqual(expect.any(String));
  });
});
